/**
 * Cloudflare Workers: one ES-module Worker script per function, all built from
 * the same bundle (`build/worker.mjs`); the `NSKIT_FUNCTION` binding picks the
 * function. HTTP via the `workers.dev` subdomain, zone routes or custom
 * domains; schedules via Cron Triggers; queues via Cloudflare Queues; workflows
 * on the embedded engine.
 *
 * Options (`provider.options`): `account_id` (required), `workers_subdomain`
 * (the account's `<name>.workers.dev`, used for URLs in outputs), `workers_dev`
 * (default true), `zone_id` (for routes / custom domains), `compatibility_date`,
 * `compatibility_flags` (default `["nodejs_compat"]`), `observability`.
 * Per-function `options`: `route` / `routes`, `custom_domain`, `bindings`
 * (appended), `invokes` (service bindings to other functions), anything else is merged into `cloudflare_workers_script`.
 */

import { builtinModules } from "node:module";
import { eventsOf, type FunctionConfig, type QueueEvent, type ServiceConfig } from "../config/schema.js";
import { bindingName, normalizeCron } from "../runtime/adapters/cloudflare.js";
import {
  HTTP,
  Issue,
  Provider,
  QUEUE,
  SCHEDULE,
  type BundleTarget,
  type Capability,
  type EntryContext,
  type RenderContext,
} from "./base.js";
import * as sched from "./schedule.js";
import { escape, ref, tfId, type TerraformDoc } from "./terraform-doc.js";

const SCRIPT = "cloudflare_workers_script";
const QUEUE_RES = "cloudflare_queue";
export const DEFAULT_COMPAT_DATE = "2026-01-15";
export const DEFAULT_COMPAT_FLAGS = ["nodejs_compat"];
const MAX_BATCH_SIZE = 100;
const MAX_BATCH_WAIT_SECONDS = 60;

/** Node built-ins provided by workerd under `nodejs_compat`; left as imports in the bundle. */
const NODE_EXTERNALS = [
  "node:*",
  ...[...new Set(builtinModules.filter((m) => !m.startsWith("_") && !m.startsWith("node:")))].sort(),
];

function asStringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  return undefined;
}

function compatFlags(config: ServiceConfig): string[] {
  return asStringList(config.provider.options.compatibility_flags) ?? DEFAULT_COMPAT_FLAGS;
}

function nodeCompat(config: ServiceConfig): boolean {
  return compatFlags(config).some((f) => f === "nodejs_compat" || f === "nodejs_compat_v2");
}

/** `{cron: input}` for one function's enabled schedules (cron in Cloudflare's dialect: SUN..SAT weekdays). */
export function scheduleInputs(fn: FunctionConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const ev of eventsOf(fn, "schedule")) {
    if (!ev.enabled) continue;
    out[sched.namedCron5(ev)] = ev.input ?? null;
  }
  return out;
}

/** First cycle in the `options.invokes` graph, if any (Terraform cannot create mutually bound scripts). */
function invokeCycle(config: ServiceConfig): string[] | undefined {
  const edges = (fn: string) =>
    (asStringList(config.functions[fn]?.options.invokes) ?? []).filter((t) => t in config.functions && t !== fn);
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (fn: string): string[] | undefined => {
    if (state.get(fn) === "done") return undefined;
    if (state.get(fn) === "visiting") return [...stack.slice(stack.indexOf(fn)), fn];
    state.set(fn, "visiting");
    stack.push(fn);
    for (const next of edges(fn)) {
      const found = visit(next);
      if (found) return found;
    }
    stack.pop();
    state.set(fn, "done");
    return undefined;
  };
  for (const fn of Object.keys(config.functions).sort()) {
    const found = visit(fn);
    if (found) return found;
  }
  return undefined;
}

export class CloudflareProvider extends Provider {
  readonly name = "cloudflare";
  readonly displayName = "Cloudflare Workers";
  override readonly tier = "beta";
  readonly terraformSource = "cloudflare/cloudflare";
  override readonly terraformVersion = ">= 5.28, < 6.0";
  override readonly defaultRegion = "";
  override readonly capabilities = new Set<Capability>([HTTP, SCHEDULE, QUEUE]);
  override readonly maxNameLength = 63;
  // workers.dev hostnames are DNS labels: no underscores.
  override readonly namePattern = /[^a-z0-9-]/g;
  override readonly maxTimeout = 900;
  override readonly notes =
    "One ES-module Worker per function (V8 isolate, not Node.js; Node APIs via the nodejs_compat flag). http via workers.dev " +
    "(set options.workers_subdomain for URLs), zone routes or custom domains; schedules via Cron Triggers; queues via " +
    "Cloudflare Queues. Needs options.account_id and CLOUDFLARE_API_TOKEN.";
  override readonly bundle: BundleTarget = {
    format: "esm",
    platform: "browser",
    entryFile: "worker.mjs",
    conditions: ["workerd", "worker", "browser"],
    external: NODE_EXTERNALS,
  };

  override bundleTarget(config: ServiceConfig): BundleTarget {
    // Without nodejs_compat, Node built-ins do not exist: let esbuild report them at build time.
    return nodeCompat(config) ? this.bundle : { ...this.bundle, external: [] };
  }

  // ------------------------------------------------------------------ bundle
  entryCode(ctx: EntryContext): string {
    const schedules: Record<string, Record<string, unknown>> = {};
    for (const [name, fn] of Object.entries(ctx.config.functions).sort(([a], [b]) => (a < b ? -1 : 1))) {
      try {
        const inputs = scheduleInputs(fn);
        if (Object.keys(inputs).length) schedules[name] = inputs;
      } catch {
        /* invalid schedules are reported by validate() */
      }
    }
    return [
      `import { createWorker } from ${JSON.stringify(ctx.runtime("adapters/cloudflare"))};`,
      `export default createWorker({ schedules: ${JSON.stringify(schedules)} });`,
    ].join("\n");
  }

  override providerBlock(_ctx: RenderContext): Record<string, unknown> {
    return {}; // credentials: CLOUDFLARE_API_TOKEN
  }

  override extraValidation(config: ServiceConfig): Issue[] {
    const issues: Issue[] = [];
    const opts = config.provider.options;
    if (!opts.account_id) issues.push(new Issue("error", "options.account_id is required", "provider.options.account_id"));
    if (opts.compatibility_flags !== undefined && !asStringList(opts.compatibility_flags)) {
      issues.push(new Issue("error", "compatibility_flags must be a list of strings", "provider.options.compatibility_flags"));
    }
    const nodeExternals = new Set(NODE_EXTERNALS);
    const external = config.package.external.filter((n) => !nodeExternals.has(n));
    if (external.length) {
      issues.push(
        new Issue(
          "error",
          `Workers upload only the bundled worker.mjs (no node_modules); package.external is not supported: ${external.join(", ")}`,
          "package.external",
        ),
      );
    }
    const consumers = new Map<string, string>();
    let http = false;
    for (const [name, fn] of Object.entries(config.functions)) {
      const where = `functions.${name}`;
      for (const ev of eventsOf(fn, "http")) {
        http = true;
        if (ev.auth !== "none") {
          issues.push(
            new Issue("error", `auth \`${ev.auth}\` is not supported on Workers; validate tokens in the handler or use Cloudflare Access`, where),
          );
        }
      }
      if ((fn.options.route || fn.options.routes) && !opts.zone_id) {
        issues.push(new Issue("error", "options.route needs provider.options.zone_id", where));
      }
      if (fn.options.route !== undefined && !asStringList(fn.options.route)) {
        issues.push(new Issue("error", "options.route must be a string or a list of strings", where));
      }
      for (const target of asStringList(fn.options.invokes) ?? []) {
        if (!(target in config.functions)) issues.push(new Issue("error", `options.invokes: unknown function '${target}'`, where));
      }
      if (fn.options.invokes !== undefined && !asStringList(fn.options.invokes)) {
        issues.push(new Issue("error", "options.invokes must be a list of function names", where));
      }
      if (fn.memory) {
        issues.push(new Issue("warning", "memory is fixed at 128 MB per isolate on Workers; `memory` is ignored", where));
      }
      const crons = new Map<string, unknown>();
      for (const ev of eventsOf(fn, "schedule")) {
        let cron: string;
        try {
          cron = normalizeCron(sched.namedCron5(ev));
        } catch (err) {
          issues.push(new Issue("error", (err as Error).message, where));
          continue;
        }
        if (crons.has(cron) && JSON.stringify(crons.get(cron)) !== JSON.stringify(ev.input ?? null)) {
          issues.push(new Issue("error", `two schedules use the cron '${cron}' with different inputs`, where));
        }
        crons.set(cron, ev.input ?? null);
        if (ev.timezone && ev.timezone.toUpperCase() !== "UTC") {
          issues.push(new Issue("error", "Cron Triggers always run in UTC; remove `timezone` or convert the cron to UTC", where));
        }
      }
      for (const ev of eventsOf(fn, "queue")) {
        if (ev.fifo) issues.push(new Issue("error", "Cloudflare Queues have no FIFO queues", where));
        if (ev.batchSize > MAX_BATCH_SIZE) {
          issues.push(new Issue("error", `batchSize ${ev.batchSize} exceeds the Cloudflare Queues max of ${MAX_BATCH_SIZE}`, where));
        }
        if (ev.batchWindow > MAX_BATCH_WAIT_SECONDS) {
          issues.push(new Issue("error", `batchWindow ${ev.batchWindow}s exceeds the Cloudflare Queues max of ${MAX_BATCH_WAIT_SECONDS}s`, where));
        }
        if (ev.visibilityTimeout) {
          issues.push(new Issue("warning", "visibilityTimeout does not apply to Worker queue consumers and is ignored", where));
        }
        const other = consumers.get(ev.name);
        if (other && other !== name) {
          issues.push(new Issue("error", `queue '${ev.name}' already has a consumer (${other}); a queue has one Worker consumer`, where));
        }
        consumers.set(ev.name, name);
      }
    }
    const cycle = invokeCycle(config);
    if (cycle) {
      issues.push(new Issue("error", `options.invokes forms a cycle (${cycle.join(" -> ")}); service bindings must be acyclic`, "functions"));
    }
    if (http && opts.workers_dev !== false && !opts.workers_subdomain) {
      issues.push(
        new Issue(
          "warning",
          "set options.workers_subdomain (your <name>.workers.dev) to get function URLs in `nskit info`",
          "provider.options.workers_subdomain",
        ),
      );
    }
    return issues;
  }

  // ------------------------------------------------------------------ render
  renderResources(doc: TerraformDoc, ctx: RenderContext): void {
    const cfg = ctx.config;
    const account = escape(String(ctx.opt("account_id", "")));
    const zone = ctx.opt<string | undefined>("zone_id");
    const subdomain = ctx.opt<string | undefined>("workers_subdomain");
    const workersDev = ctx.opt<boolean>("workers_dev", true) !== false;
    const compatDate = String(ctx.opt("compatibility_date", DEFAULT_COMPAT_DATE));
    const flags = [...compatFlags(cfg)].sort();
    const entry = ctx.artifact.entryFile;
    const content = `\${path.module}/build/${entry}`;
    this.warnSkippedFiles(doc, ctx);

    const fnOut: Record<string, Record<string, unknown>> = {};
    let endpoint: string | null = null;
    for (const [name, fn] of ctx.functionItems()) {
      const scriptName = ctx.physicalName(name);
      const opts: Record<string, unknown> = { ...fn.options };
      const routes = [...(asStringList(opts.route) ?? []), ...(asStringList(opts.routes) ?? [])];
      const customDomain = opts.custom_domain ? String(opts.custom_domain) : undefined;
      const extraBindings = Array.isArray(opts.bindings) ? (opts.bindings as unknown[]) : [];
      const invokes = (asStringList(opts.invokes) ?? []).filter((t) => t in cfg.functions && t !== name).sort();
      delete opts.invokes;
      delete opts.route;
      delete opts.routes;
      delete opts.custom_domain;
      delete opts.bindings;

      const bindings: Record<string, unknown>[] = Object.entries(ctx.environment(name, fn))
        .filter(([, v]) => v !== "")
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => ({ name: k, type: "plain_text", text: escape(v) }));
      for (const task of invokes) {
        bindings.push({ name: bindingName(task), type: "service", service: ref(SCRIPT, tfId(task), "script_name") });
      }
      const body: Record<string, unknown> = {
        account_id: account,
        script_name: scriptName,
        content_file: content,
        content_sha256: `\${filesha256("${content}")}`,
        main_module: entry,
        compatibility_date: compatDate,
        compatibility_flags: flags,
        bindings: [...bindings, ...extraBindings],
      };
      if (ctx.opt("observability")) body.observability = { enabled: true };
      Object.assign(body, opts); // escape hatch: limits, placement, logpush, tail_consumers, ...
      const script = doc.resource(SCRIPT, name, body);

      const http = eventsOf(fn, "http").length > 0;
      // workers.dev is on for HTTP functions and explicitly off for the rest (they are reached via triggers / bindings).
      doc.resource("cloudflare_workers_script_subdomain", name, {
        account_id: account,
        script_name: ref(script, "script_name"),
        enabled: http && workersDev,
        previews_enabled: false,
      });
      routes.forEach((pattern, i) => {
        doc.resource("cloudflare_workers_route", routes.length > 1 ? `${name}-${i}` : name, {
          zone_id: escape(String(zone ?? "")),
          pattern: escape(pattern),
          script: ref(script, "script_name"),
        });
      });
      if (customDomain) {
        const domain: Record<string, unknown> = { account_id: account, hostname: escape(customDomain), service: ref(script, "script_name") };
        if (zone) domain.zone_id = escape(String(zone));
        doc.resource("cloudflare_workers_custom_domain", name, domain);
      }

      const schedules = Object.keys(scheduleInputs(fn));
      const disabled = eventsOf(fn, "schedule").filter((ev) => !ev.enabled).length;
      if (disabled) doc.warnings.push(`Cloudflare: ${disabled} disabled schedule(s) of ${name} are not deployed`);
      if (schedules.length) {
        doc.resource("cloudflare_workers_cron_trigger", name, {
          account_id: account,
          script_name: ref(script, "script_name"),
          schedules: schedules.map((cron) => ({ cron })),
        });
      }
      for (const ev of eventsOf(fn, "queue")) this.queue(doc, account, name, script, ev);

      const out: Record<string, unknown> = {
        id: ref(script, "script_name"),
        console: `https://dash.cloudflare.com/${account}/workers/services/view/${scriptName}/production`,
      };
      let url: string | undefined;
      if (http && workersDev && subdomain) url = `https://${scriptName}.${subdomain}.workers.dev`;
      else if (http && customDomain) url = `https://${customDomain}`;
      else if (http && routes.length) url = "https://" + routes[0].replace(/\*+$/, "").replace(/\/+$/, "");
      if (url) {
        out.url = escape(url);
        out.base_url = escape(url);
        endpoint ??= escape(url);
      }
      fnOut[name] = out;
    }

    const wfOut: Record<string, unknown> = {};
    for (const wfName of Object.keys(cfg.workflows).sort()) {
      const orch = fnOut[`${wfName}-orchestrator`];
      wfOut[wfName] = orch ? { id: orch.id, ...(orch.url ? { url: orch.url } : {}) } : { id: ctx.physicalName(`${wfName}-orchestrator`) };
    }
    doc.output("nskit", { functions: fnOut, workflows: wfOut, endpoint }, { description: "node_serverless_kit deployment summary" });
  }

  // ------------------------------------------------------------------ pieces
  private warnSkippedFiles(doc: TerraformDoc, ctx: RenderContext): void {
    const assets = ctx.config.package.include;
    if (assets.length) {
      doc.warnings.push(
        "Cloudflare: only the bundled worker module is uploaded; package.include assets are not available at run time " +
          "(import small files into the bundle, or use KV / R2)",
      );
    }
  }

  /** Returns a Terraform expression for the queue id. */
  private queueId(doc: TerraformDoc, account: string, ev: QueueEvent): string {
    if (ev.existing) {
      const all = doc.data("cloudflare_queues", "all", { account_id: account });
      return `\${one([for q in ${all}.result : q.queue_id if q.queue_name == ${JSON.stringify(ev.name)}])}`;
    }
    const label = `q-${ev.name}`;
    if (!doc.hasResource(QUEUE_RES, label)) doc.resource(QUEUE_RES, label, { account_id: account, queue_name: escape(ev.name) });
    return ref(QUEUE_RES, tfId(label), "queue_id");
  }

  private queue(doc: TerraformDoc, account: string, name: string, script: string, ev: QueueEvent): void {
    const queueId = this.queueId(doc, account, ev);
    const settings: Record<string, unknown> = {
      batch_size: ev.batchSize,
      max_retries: Math.max(0, ev.maxReceive - 1),
    };
    if (ev.batchWindow) settings.max_wait_time_ms = ev.batchWindow * 1000;
    const body: Record<string, unknown> = {
      account_id: account,
      queue_id: queueId,
      script_name: ref(script, "script_name"),
      type: "worker",
      settings,
    };
    if (ev.deadLetter) {
      const label = `q-${ev.deadLetter}`;
      if (ev.existing) {
        body.dead_letter_queue = escape(ev.deadLetter);
      } else {
        if (!doc.hasResource(QUEUE_RES, label)) doc.resource(QUEUE_RES, label, { account_id: account, queue_name: escape(ev.deadLetter) });
        body.dead_letter_queue = ref(QUEUE_RES, tfId(label), "queue_name");
      }
    }
    doc.resource("cloudflare_queue_consumer", `${name}-${ev.name}`, body);
  }
}
