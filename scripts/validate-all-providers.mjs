#!/usr/bin/env node
/**
 * Render a representative project for every provider and run `terraform validate`.
 *
 * Usage:
 *
 *     npm run validate:terraform                          # all providers
 *     npm run validate:terraform -- --provider gcp        # one provider (repeatable, or a comma list)
 *     npm run validate:terraform -- --keep                # keep the temp projects
 *     npm run validate:terraform -- --strict              # exit 2 when terraform is missing
 *
 * Needs terraform (or tofu / NSKIT_TERRAFORM_BIN) and network access to download
 * provider plugins. Set TF_PLUGIN_CACHE_DIR to reuse plugin downloads between runs.
 * No cloud credentials are needed: `validate` never calls cloud APIs.
 *
 * The script imports the built package (`dist/api.js`) and runs `npm run build`
 * first when it is missing.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distApi = path.join(root, "dist", "api.js");

// Placeholder values for options a provider requires. `terraform validate`
// checks types and references only, so fake ids are fine.
const DUMMY_OPTIONS = {
  gcp: { project: "nskit-validate" },
  azure: { subscription_id: "00000000-0000-0000-0000-000000000000" },
  oracle: {
    compartment_id: "ocid1.compartment.oc1..example",
    subnet_ids: ["ocid1.subnet.oc1..example"],
    image: "iad.ocir.io/namespace/nskit-validate:latest",
  },
  digitalocean: { namespace: "fn-00000000-0000-0000-0000-000000000000" },
  cloudflare: { account_id: "0123456789abcdef0123456789abcdef", workers_subdomain: "example" },
  huawei: { apig_instance_id: "00000000000000000000000000000000" },
};

const HANDLERS = `import type { Context, Event } from "node_serverless_kit";

export async function api(_event: Event, _ctx: Context) {
  return { ok: true };
}

export async function job(event: Event, _ctx: Context) {
  return { type: event.type };
}

export async function step(event: Event, _ctx: Context) {
  return event.data;
}
`;

function parseArgs(argv) {
  const opts = { providers: [], keep: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provider" || a === "-p") opts.providers.push(...String(argv[++i] ?? "").split(","));
    else if (a.startsWith("--provider=")) opts.providers.push(...a.slice(11).split(","));
    else if (a === "--keep") opts.keep = true;
    else if (a === "--strict") opts.strict = true;
    else if (a === "-h" || a === "--help") {
      console.log("usage: node scripts/validate-all-providers.mjs [--provider NAME[,NAME]]... [--keep] [--strict]");
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  opts.providers = opts.providers.map((p) => p.trim()).filter(Boolean);
  return opts;
}

function ensureBuilt() {
  if (existsSync(distApi)) return;
  console.log("dist/api.js not found - running `npm run build` first");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const proc = spawnSync(npm, ["run", "build"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (proc.status !== 0 || !existsSync(distApi)) {
    console.error("build failed; run `npm run build` and retry");
    process.exit(1);
  }
}

function projectConfig(name, provider) {
  const caps = provider.capabilities;
  const functions = {
    api: {
      handler: "src/handlers.api",
      events: [{ http: "GET /items/{id}" }, { http: { path: "/items", method: "POST", cors: true } }],
    },
    step: { handler: "src/handlers.step" },
  };
  if (caps.has("schedule")) {
    functions.cron = {
      handler: "src/handlers.job",
      events: [{ schedule: "5 minutes" }, { schedule: { cron: "0 3 * * *", input: { x: 1 } } }],
    };
  }
  if (caps.has("queue")) {
    functions["queue-worker"] = { handler: "src/handlers.job", events: [{ queue: { name: "nskit-validate-jobs" } }] };
  }
  if (caps.has("storage")) {
    functions.uploads = {
      handler: "src/handlers.job",
      events: [{ storage: { bucket: "nskit-validate-uploads-1250000000", suffix: ".csv" } }],
    };
  }
  if (caps.has("topic")) {
    functions.subscriber = { handler: "src/handlers.job", events: [{ topic: "nskit-validate-events" }] };
  }
  return {
    service: "nskit-validate",
    provider: { name, options: DUMMY_OPTIONS[name] ?? {} },
    functions,
    workflows: {
      flow: {
        startAt: "A",
        states: {
          A: { type: "task", function: "step", retry: [{ errors: ["*"], maxAttempts: 2 }], next: "B" },
          B: { type: "choice", choices: [{ variable: "$.ok", equals: true, next: "C" }], default: "C" },
          C: { type: "succeed" },
        },
      },
    },
  };
}

function lastLines(text, n = 25) {
  return String(text ?? "").trim().split(/\r?\n/).slice(-n).join("\n");
}

async function validateProvider(api, name, tfBinary, keep) {
  const provider = api.getProvider(name);
  const tmp = mkdtempSync(path.join(os.tmpdir(), `nskit-validate-${name}-`));
  const result = { name, tier: provider.tier, ok: false, detail: "" };
  try {
    mkdirSync(path.join(tmp, "src"));
    writeFileSync(path.join(tmp, "src", "handlers.ts"), HANDLERS);
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "nskit-validate", type: "module", private: true }, null, 2));
    // JSON is valid YAML.
    writeFileSync(path.join(tmp, "nskit.yml"), JSON.stringify(projectConfig(name, provider), null, 2));

    const project = api.Project.load(path.join(tmp, "nskit.yml"));
    const errors = project.validate().filter((i) => i.level === "error").map(String);
    if (errors.length) {
      result.detail = `config errors: ${errors.join("; ")}`;
      return result;
    }
    await new api.Deployer(project, () => undefined).package({ skipInstall: true });

    const env = { ...process.env, TF_IN_AUTOMATION: "1", TF_INPUT: "0" };
    for (const args of [
      ["init", "-backend=false", "-input=false", "-no-color"],
      ["validate", "-no-color"],
    ]) {
      const proc = spawnSync(tfBinary, args, { cwd: project.workDir, env, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
      if (proc.error || proc.status !== 0) {
        result.detail = `terraform ${args[0]} failed:\n${lastLines(proc.stdout)}\n${lastLines(proc.stderr)}`;
        return result;
      }
    }
    result.ok = true;
    result.detail = keep ? path.join(project.workDir, "main.tf.json") : "Success! The configuration is valid.";
    return result;
  } catch (err) {
    result.detail = `${err?.name ?? "Error"}: ${err?.message ?? String(err)}`;
    return result;
  } finally {
    if (!keep) rmSync(tmp, { recursive: true, force: true });
  }
}

function printTable(results) {
  const rows = results.map((r) => [r.name, r.tier, r.ok ? "OK" : "FAIL", r.detail.split("\n")[0].slice(0, 100)]);
  const header = ["provider", "tier", "result", "detail"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("  ");
  console.log("\n" + line(header));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(line(r));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  ensureBuilt();
  const api = await import(pathToFileURL(distApi).href);

  let tfBinary;
  try {
    tfBinary = api.findBinary();
  } catch (err) {
    console.error(
      `${err.message}\n\nThis check is optional: it needs Terraform (or OpenTofu) locally. CI runs it for every provider.\n` +
        "See deploy_docs/HOW_TO_INSTALL_TERRAFORM.md.",
    );
    process.exit(opts.strict ? 2 : 0);
  }

  const names = opts.providers.length ? opts.providers : api.available();
  const unknown = names.filter((n) => !api.available().includes(n));
  if (unknown.length) {
    console.error(`unknown provider(s): ${unknown.join(", ")}; available: ${api.available().join(", ")}`);
    process.exit(1);
  }

  console.log(`terraform: ${tfBinary}`);
  const results = [];
  for (const name of names) {
    process.stdout.write(`[${name}] rendering and validating... `);
    const r = await validateProvider(api, name, tfBinary, opts.keep);
    console.log(r.ok ? "OK" : "FAIL");
    if (!r.ok) console.log(r.detail.replace(/^/gm, "    "));
    results.push(r);
  }

  printTable(results);
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} providers valid` +
      (failed.length ? `; failed: ${failed.map((r) => r.name).join(", ")}` : ""),
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
