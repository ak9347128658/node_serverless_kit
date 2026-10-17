/**
 * DigitalOcean Functions.
 *
 * The DigitalOcean Terraform provider has no resource for Functions, so nskit
 * renders a standard `doctl serverless` project (`do_project/project.yml` +
 * `packages/<service>-<stage>/<fn>/`, each function directory holding the
 * bundle with a package.json whose `main` is `index.js`) and deploys it from a
 * `terraform_data` resource with `local-exec` provisioners. Terraform tracks
 * *when* to redeploy (artifact + project hash) while `doctl` does the upload.
 *
 * Options (`provider.options`): `namespace` (required, `fn-...`), `api_host`
 * (e.g. `https://faas-nyc1-2ef2e6cc.doserverless.co`, to output URLs),
 * `region`, `remote_build` (pass `--remote-build` to `doctl serverless deploy`).
 * Per-function `options` are merged into the function's project.yml entry
 * (`webSecure`, `parameters`, `limits`, ...).
 */

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { stringify as toYaml } from "yaml";
import { eventsOf, memoryOf, type ServiceConfig } from "../config/schema.js";
import { envelope } from "../runtime/envelope.js";
import type { BundleManifest } from "../runtime/manifest.js";
import { HTTP, Issue, Provider, SCHEDULE, type BundleTarget, type Capability, type EntryContext, type RenderContext } from "./base.js";
import * as sched from "./schedule.js";
import { escape, TerraformDoc } from "./terraform-doc.js";

export const PROJECT_DIR = "do_project";

function onPath(binary: string): boolean {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (existsSync(path.join(dir, binary + ext.toLowerCase())) || existsSync(path.join(dir, binary + ext))) return true;
    }
  }
  return false;
}

export class DigitalOceanProvider extends Provider {
  readonly name = "digitalocean";
  readonly displayName = "DigitalOcean Functions";
  override readonly tier = "beta";
  /** terraform_data + doctl: no cloud provider plugin is required. */
  readonly terraformSource = "terraform.io/builtin/terraform";
  override readonly defaultRegion = "";
  override readonly capabilities = new Set<Capability>([HTTP, SCHEDULE]);
  override readonly maxNameLength = 63;
  override readonly runtimes = { nodejs18: "nodejs:18", nodejs22: "nodejs:22", nodejs24: "nodejs:24" };
  override readonly maxTimeout = 900;
  override readonly notes =
    "Deployed with `doctl serverless deploy` (doctl must be installed and authenticated: `doctl auth init`). " +
    "Requires options.namespace (fn-...); set options.api_host to get URLs. Supports http (web: raw, public) and " +
    "schedule triggers only. Runtimes: nodejs18 / nodejs22 / nodejs24.";
  override readonly bundle: BundleTarget = { format: "cjs", platform: "node", entryFile: "index.js" };

  // ------------------------------------------------------------------ terraform header
  override initDoc(ctx: RenderContext): TerraformDoc {
    const doc = new TerraformDoc();
    doc.requiredVersion(ctx.config.provider.terraform.requiredVersion);
    const state = ctx.config.provider.state;
    if (state.backend) doc.backend(state.backend, state.config);
    return doc;
  }

  override providerBlock(_ctx: RenderContext): Record<string, unknown> | undefined {
    return undefined;
  }

  override region(config: ServiceConfig): string {
    return config.provider.region || String(config.provider.options.region ?? "");
  }

  // ------------------------------------------------------------------ bundle
  entryCode(ctx: EntryContext): string {
    return `export { main } from ${JSON.stringify(ctx.runtime("adapters/digitalocean"))};`;
  }

  override extraFiles(_config: ServiceConfig, _manifest: BundleManifest): Record<string, string> {
    return { "package.json": JSON.stringify({ main: this.bundle.entryFile }, null, 2) + "\n" };
  }

  override extraValidation(config: ServiceConfig): Issue[] {
    const issues: Issue[] = [];
    if (!config.provider.options.namespace) {
      issues.push(
        new Issue("error", "options.namespace is required (see `doctl serverless namespaces list`)", "provider.options.namespace"),
      );
    }
    if (!onPath("doctl")) {
      issues.push(
        new Issue(
          "warning",
          "`doctl` is not on PATH; deploy will fail until it is installed and authenticated (`doctl auth init`)",
          "provider",
        ),
      );
    }
    for (const [name, fn] of Object.entries(config.functions)) {
      const mem = memoryOf(config, fn);
      if (mem < 128 || mem > 1024) {
        issues.push(new Issue("error", `memory ${mem} MB is outside DigitalOcean's 128-1024 MB range`, `functions.${name}.memory`));
      }
      for (const ev of eventsOf(fn, "http")) {
        if (ev.auth !== "none") {
          issues.push(
            new Issue(
              "error",
              `auth \`${ev.auth}\` is not supported; DigitalOcean web functions are public - validate tokens in the handler`,
              `functions.${name}`,
            ),
          );
        }
      }
      if (eventsOf(fn, "schedule").some((ev) => ev.timezone && ev.timezone !== "UTC")) {
        issues.push(new Issue("warning", "DigitalOcean scheduled triggers run in UTC; `timezone` is ignored", `functions.${name}`));
      }
    }
    return issues;
  }

  // ------------------------------------------------------------------ render
  packageName(ctx: RenderContext): string {
    return ctx.prefix;
  }

  projectSpec(ctx: RenderContext): Record<string, unknown> {
    const functions: Record<string, unknown>[] = [];
    for (const [name, fn] of ctx.functionItems()) {
      const spec: Record<string, unknown> = {
        name,
        runtime: ctx.runtimeIdOf(fn),
        main: "main",
        web: eventsOf(fn, "http").length ? "raw" : false,
        limits: { timeout: ctx.timeoutOf(fn) * 1000, memory: ctx.memoryOf(fn) },
        environment: ctx.environment(name, fn),
      };
      const triggers: Record<string, unknown>[] = [];
      eventsOf(fn, "schedule").forEach((ev, i) => {
        if (!ev.enabled) return;
        triggers.push({
          name: `${name}-${ev.name ?? i}`,
          sourceType: "scheduler",
          sourceDetails: {
            cron: sched.toCron5(ev),
            withBody: envelope("schedule", ev.input ?? null, { source: "digitalocean.scheduler" }),
          },
        });
      });
      if (triggers.length) spec.triggers = triggers;
      Object.assign(spec, fn.options);
      functions.push(spec);
    }
    return { packages: [{ name: this.packageName(ctx), functions }] };
  }

  /** Materialise the doctl project next to main.tf.json; returns a content hash of project.yml. */
  writeProject(ctx: RenderContext): string {
    const root = path.join(ctx.workDir, PROJECT_DIR);
    rmSync(root, { recursive: true, force: true });
    const spec = this.projectSpec(ctx);
    const pkg = this.packageName(ctx);
    const build = ctx.artifact.buildDir;
    for (const [name] of ctx.functionItems()) {
      const dest = path.join(root, "packages", pkg, name);
      if (build && existsSync(build)) cpSync(build, dest, { recursive: true });
      else mkdirSync(dest, { recursive: true });
    }
    const text = toYaml(spec, { lineWidth: 0 });
    writeFileSync(path.join(root, "project.yml"), text, "utf-8");
    return createHash("sha256").update(text).digest("hex");
  }

  renderResources(doc: TerraformDoc, ctx: RenderContext): void {
    const cfg = ctx.config;
    const namespace = escape(String(ctx.opt("namespace", "")));
    const pkg = this.packageName(ctx);
    const projectHash = this.writeProject(ctx);
    const deploy = `doctl serverless deploy ${PROJECT_DIR}${ctx.opt("remote_build") ? " --remote-build" : ""}`;
    doc.resource("terraform_data", "deploy", {
      triggers_replace: [ctx.artifact.sha256, projectHash],
      input: { namespace, package: pkg },
      provisioner: [
        {
          "local-exec": {
            working_dir: "${path.module}",
            command: `doctl serverless connect ${namespace} && ${deploy}`,
          },
        },
        {
          "local-exec": {
            when: "destroy",
            command:
              "doctl serverless connect ${self.input.namespace} && doctl serverless undeploy --packages ${self.input.package}",
          },
        },
      ],
    });
    const apiHost = escape(String(ctx.opt("api_host", "")).replace(/\/+$/, ""));
    const fnOut: Record<string, Record<string, unknown>> = {};
    let endpoint: string | null = null;
    for (const [name, fn] of ctx.functionItems()) {
      const url = apiHost && eventsOf(fn, "http").length ? `${apiHost}/api/v1/web/${namespace}/${pkg}/${name}` : null;
      const out: Record<string, unknown> = { id: `${pkg}/${name}`, url, console: "https://cloud.digitalocean.com/functions" };
      if (url) {
        out.base_url = url;
        endpoint ??= `${apiHost}/api/v1/web/${namespace}/${pkg}`;
      }
      fnOut[name] = out;
    }
    const wfOut: Record<string, unknown> = {};
    for (const n of Object.keys(cfg.workflows).sort()) wfOut[n] = { id: `${pkg}/${n}-orchestrator` };
    doc.output("nskit", { functions: fnOut, workflows: wfOut, endpoint }, { description: "node_serverless_kit deployment summary" });
  }
}
