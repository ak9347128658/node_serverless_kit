/**
 * GCP: Cloud Functions (2nd gen) + Cloud Scheduler + Pub/Sub + Cloud Storage + Cloud Workflows.
 *
 * Cloud Functions gen2 allows a single `event_trigger` per function and an
 * event-triggered function cannot serve plain HTTP. To keep "change only the
 * provider in YAML" true, each *logical* function is deployed as one or more
 * Cloud Functions sharing the same source and handler (`NSKIT_FUNCTION` is the
 * logical name in all of them):
 *
 * - `<name>`           - HTTP deployment (entry `nskit_http`). Created when the
 *   function has `http` events, no event triggers at all, is a workflow task
 *   (Cloud Workflows needs a URL), or has schedules but no Pub/Sub trigger to publish to.
 * - `<name>-<kind><i>` - one per event trigger (entry `nskit_event`), e.g.
 *   `worker-queue0`, `worker-storage0`, `worker-topic0`. A storage event listing
 *   both `created` and `deleted` becomes two deployments. When a function has
 *   exactly one trigger and needs no HTTP deployment it is simply named `<name>`.
 *
 * Triggers:
 *
 * - `queue` / `topic` -> Pub/Sub `messagePublished` via Eventarc (GCP has no push
 *   queue like SQS, so a queue is a Pub/Sub topic too).
 * - `storage`         -> Cloud Storage `finalized` / `deleted`. Prefix / suffix
 *   filters are not supported by Eventarc, so the runtime applies them.
 * - `schedule`        -> Cloud Scheduler: POSTs the `__nskit` envelope to the HTTP
 *   deployment with an OIDC token, or - when there is no HTTP deployment - publishes
 *   the envelope to the function's first Pub/Sub topic.
 *
 * A dedicated *invoker* service account is created and granted `roles/run.invoker`
 * on every deployment; Cloud Scheduler, Eventarc and Cloud Workflows all use it.
 *
 * Source: the artifact zip (bundle + package.json listing
 * `@google-cloud/functions-framework`) is uploaded to a GCS bucket; Cloud Build
 * installs the framework remotely with the Node.js buildpack.
 *
 * Options (`provider.options`): `project` (required), `service_account` (runtime
 * identity), `build_service_account` (Cloud Build identity), `artifact_bucket`
 * (existing bucket for sources), `enable_apis` (manage `google_project_service`),
 * `ingress` (`ALLOW_ALL` | `ALLOW_INTERNAL_ONLY` | `ALLOW_INTERNAL_AND_GCLB`).
 * Per-function `options` are merged into `google_cloudfunctions2_function`.
 */

import {
  eventsOf,
  taskFunctions,
  type FunctionConfig,
  type QueueEvent,
  type ScheduleEvent,
  type ServiceConfig,
  type StorageEvent,
  type TopicEvent,
} from "../config/schema.js";
import { envelope } from "../runtime/envelope.js";
import type { BundleManifest } from "../runtime/manifest.js";
import { compileGcpWorkflow } from "../workflows/gcp.js";
import { definitionData } from "../workflows/index.js";
import {
  HTTP,
  Issue,
  Provider,
  QUEUE,
  SCHEDULE,
  STORAGE,
  stableSuffix,
  TOPIC,
  WORKFLOW_NATIVE,
  type BundleTarget,
  type Capability,
  type EntryContext,
  type RenderContext,
} from "./base.js";
import * as sched from "./schedule.js";
import { escape, escapeMap, ref, tfId, type TerraformDoc } from "./terraform-doc.js";

const FN = "google_cloudfunctions2_function";
export const FUNCTIONS_FRAMEWORK = "@google-cloud/functions-framework";
export const FUNCTIONS_FRAMEWORK_VERSION = "^5.0.0";
export const PUBSUB_EVENT = "google.cloud.pubsub.topic.v1.messagePublished";
export const STORAGE_EVENTS = {
  created: "google.cloud.storage.object.v1.finalized",
  deleted: "google.cloud.storage.object.v1.deleted",
} as const;
export const EVENT_MAX_TIMEOUT = 540;
const TRIGGERS = ["queue", "topic", "storage"] as const;
type TriggerKind = (typeof TRIGGERS)[number];
const INGRESS = ["ALLOW_ALL", "ALLOW_INTERNAL_ONLY", "ALLOW_INTERNAL_AND_GCLB"];
const DEPRECATED_RUNTIMES: Record<string, string> = { nodejs20: "2026-04-30 (decommissioned 2026-10-30)" };
/** APIs a deployment needs (managed only with `options.enable_apis: true`). */
const SERVICES = [
  "artifactregistry.googleapis.com",
  "cloudbuild.googleapis.com",
  "cloudfunctions.googleapis.com",
  "cloudscheduler.googleapis.com",
  "eventarc.googleapis.com",
  "pubsub.googleapis.com",
  "run.googleapis.com",
  "storage.googleapis.com",
  "workflows.googleapis.com",
];

function labelValue(text: string): string {
  return String(text).toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 63);
}

/** GCP labels: lowercase keys starting with a letter, values of `[a-z0-9_-]`, max 63 chars. */
export function labels(tags: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    let k = labelValue(key);
    if (!k || !/^[a-z]/.test(k)) k = "k" + k;
    out[k.slice(0, 63)] = labelValue(value);
  }
  return out;
}

/** Service account id: 6-30 chars, `^[a-z][-a-z0-9]{4,28}[a-z0-9]$`. */
export function serviceAccountId(prefix: string, suffix: string): string {
  let base = prefix.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  base = base.slice(0, 30 - suffix.length - 1).replace(/^-+|-+$/g, "");
  if (!base || !/^[a-z]/.test(base)) base = "p" + base;
  return `${base}-${suffix}`.slice(0, 30);
}

/** One Cloud Function backing (part of) a logical function. */
export interface Deployment {
  /** Logical name or `<name>-<kind><i>`; also the Terraform label. */
  key: string;
  kind: "http" | TriggerKind;
  queue?: QueueEvent;
  topic?: TopicEvent;
  storage?: StorageEvent;
  /** Storage only: `created` | `deleted`. */
  action?: "created" | "deleted";
  schedules: ScheduleEvent[];
  /** Schedules publish the envelope to this deployment's Pub/Sub topic. */
  pubsubSchedules: boolean;
}

/** Split a logical function into Cloud Functions (see the module docs). */
export function planDeployments(name: string, fn: FunctionConfig, needsHttp = false): Deployment[] {
  const triggers: Deployment[] = [];
  const counters: Record<string, number> = {};
  const next = (kind: string) => {
    const i = counters[kind] ?? 0;
    counters[kind] = i + 1;
    return `${name}-${kind}${i}`;
  };
  for (const ev of fn.events) {
    const base = { schedules: [] as ScheduleEvent[], pubsubSchedules: false };
    if (ev.type === "queue") triggers.push({ ...base, key: next("queue"), kind: "queue", queue: ev.config });
    else if (ev.type === "topic") triggers.push({ ...base, key: next("topic"), kind: "topic", topic: ev.config });
    else if (ev.type === "storage") {
      for (const action of ev.config.events) {
        triggers.push({ ...base, key: next("storage"), kind: "storage", storage: ev.config, action });
      }
    }
  }
  const schedules = eventsOf(fn, "schedule");
  const pubsub = triggers.find((d) => d.kind === "queue" || d.kind === "topic");
  const wantHttp = eventsOf(fn, "http").length > 0 || !triggers.length || needsHttp || (schedules.length > 0 && !pubsub);
  const out: Deployment[] = [];
  if (wantHttp) out.push({ key: name, kind: "http", schedules, pubsubSchedules: false });
  else if (schedules.length && pubsub) {
    pubsub.schedules = schedules;
    pubsub.pubsubSchedules = true;
  }
  if (triggers.length === 1 && !wantHttp) triggers[0].key = name;
  return [...out, ...triggers];
}

function pubsubSource(dep: Deployment): { name: string; existing: boolean } {
  const ev = (dep.queue ?? dep.topic)!;
  return { name: ev.name, existing: ev.existing };
}

export class GcpProvider extends Provider {
  readonly name = "gcp";
  readonly displayName = "Google Cloud Functions";
  override readonly tier = "beta";
  readonly terraformSource = "hashicorp/google";
  override readonly terraformVersion = ">= 6.11";
  override readonly terraformLocalName = "google";
  override readonly defaultRegion = "us-central1";
  override readonly capabilities = new Set<Capability>([HTTP, SCHEDULE, QUEUE, STORAGE, TOPIC, WORKFLOW_NATIVE]);
  override readonly maxNameLength = 63;
  override readonly namePattern = /[^a-z0-9-]/g;
  override readonly runtimes = { nodejs20: "nodejs20", nodejs22: "nodejs22", nodejs24: "nodejs24" };
  override readonly maxTimeout = 3600;
  override readonly notes =
    "Cloud Functions gen2 (Cloud Run functions). Requires options.project. Queues map to Pub/Sub topics; " +
    "workflows via Cloud Workflows.";
  override readonly bundle: BundleTarget = { format: "cjs", platform: "node", entryFile: "index.js", external: [FUNCTIONS_FRAMEWORK] };
  override readonly dependencies = { [FUNCTIONS_FRAMEWORK]: FUNCTIONS_FRAMEWORK_VERSION };
  override readonly remoteInstall = true;

  // ------------------------------------------------------------------ bundle
  entryCode(ctx: EntryContext): string {
    const adapter = JSON.stringify(ctx.runtime("adapters/gcp"));
    return [
      `import { register as __nskitRegister } from ${adapter};`,
      `export { nskitHttp as nskit_http, nskitEvent as nskit_event } from ${adapter};`,
      "",
      "// Declarative registration with the Functions Framework (installed by Cloud Build).",
      "// The plain exports above keep working when the framework is absent (local runs, tests).",
      "let __nskitFramework;",
      "try {",
      `  __nskitFramework = require(${JSON.stringify(FUNCTIONS_FRAMEWORK)});`,
      "} catch {",
      "  __nskitFramework = undefined;",
      "}",
      "__nskitRegister(__nskitFramework);",
    ].join("\n");
  }

  override extraFiles(_config: ServiceConfig, _manifest: BundleManifest): Record<string, string> {
    // `main` tells the Functions Framework / buildpack which file holds the entry points.
    return { "package.json": JSON.stringify({ main: this.bundle.entryFile }, null, 2) + "\n" };
  }

  override providerBlock(ctx: RenderContext): Record<string, unknown> {
    const block: Record<string, unknown> = { region: ctx.region };
    if (ctx.opt("project")) block.project = ctx.opt("project");
    return block;
  }

  override extraValidation(config: ServiceConfig): Issue[] {
    const issues: Issue[] = [];
    const opts = config.provider.options;
    if (!opts.project) issues.push(new Issue("error", "GCP needs provider.options.project (the GCP project id)", "provider.options"));
    if (opts.ingress !== undefined && !INGRESS.includes(String(opts.ingress))) {
      issues.push(new Issue("error", `ingress must be one of ${INGRESS.join(", ")}`, "provider.options.ingress"));
    }
    if (config.provider.iam.statements.length) {
      issues.push(
        new Issue(
          "warning",
          "iam.statements are AWS-style and ignored on GCP; grant roles to options.service_account instead",
          "provider.iam",
        ),
      );
    }
    const runtimes = new Set([config.provider.runtime, ...Object.values(config.functions).map((f) => f.runtime ?? "")]);
    for (const rt of [...runtimes].filter((r) => r in DEPRECATED_RUNTIMES).sort()) {
      issues.push(new Issue("warning", `${rt} is deprecated on Cloud Functions since ${DEPRECATED_RUNTIMES[rt]}`, "provider.runtime"));
    }
    for (const [name, fn] of Object.entries(config.functions)) {
      const where = `functions.${name}`;
      if (fn.iam.statements.length) {
        issues.push(new Issue("warning", "iam.statements are ignored on GCP; use iam.role (a service account email)", where));
      }
      for (const ev of eventsOf(fn, "queue")) {
        if (ev.deadLetter) {
          issues.push(new Issue("warning", "queue.deadLetter is not applied on GCP (Eventarc manages the subscription)", where));
        }
        if (ev.fifo) issues.push(new Issue("warning", "queue.fifo is not supported by Pub/Sub triggers and is ignored", where));
      }
      for (const ev of eventsOf(fn, "http")) {
        if (ev.auth === "jwt" || ev.auth === "key") {
          issues.push(new Issue("error", `http auth '${ev.auth}' is not supported on GCP; use none or iam`, where));
        }
      }
      const hasTrigger = fn.events.some((e) => (TRIGGERS as readonly string[]).includes(e.type));
      if (hasTrigger && (fn.timeout ?? config.provider.timeout) > EVENT_MAX_TIMEOUT) {
        issues.push(new Issue("error", `event-triggered functions are limited to ${EVENT_MAX_TIMEOUT}s on GCP`, where));
      }
    }
    return issues;
  }

  // ------------------------------------------------------------------ render
  renderResources(doc: TerraformDoc, ctx: RenderContext): void {
    const cfg = ctx.config;
    const project = ctx.opt<string>("project", "");
    const region = ctx.region;
    const depends: string[] = [];

    if (ctx.opt("enable_apis")) {
      for (const service of SERVICES) {
        depends.push(
          doc.resource("google_project_service", `api-${service.split(".")[0]}`, {
            project,
            service,
            disable_on_destroy: false,
          }),
        );
      }
    }

    const source = this.source(doc, ctx, project);
    const invoker = doc.resource("google_service_account", "invoker", {
      project,
      account_id: serviceAccountId(ctx.prefix, "inv"),
      display_name: `nskit invoker for ${ctx.prefix}`.slice(0, 100),
    });
    const invokerEmail = ref(invoker, "email");
    const tasks = new Set(Object.values(cfg.workflows).flatMap((wf) => taskFunctions(wf)));
    const plans = Object.fromEntries(ctx.functionItems().map(([name, fn]) => [name, planDeployments(name, fn, tasks.has(name))]));
    const hasStorage = Object.values(cfg.functions).some((fn) => eventsOf(fn, "storage").length > 0);
    const hasTrigger = Object.values(plans).some((deps) => deps.some((d) => d.kind !== "http"));

    if (hasStorage) {
      // Cloud Storage publishes object notifications to Pub/Sub for Eventarc.
      const gcs = doc.data("google_storage_project_service_account", "gcs", project ? { project } : {});
      depends.push(
        doc.resource("google_project_iam_member", "gcs-pubsub", {
          project,
          role: "roles/pubsub.publisher",
          member: "serviceAccount:" + ref(gcs, "email_address"),
        }),
      );
    }
    if (hasTrigger) {
      depends.push(
        doc.resource("google_project_iam_member", "invoker-eventarc", {
          project,
          role: "roles/eventarc.eventReceiver",
          member: "serviceAccount:" + invokerEmail,
        }),
      );
    }

    const fnOut: Record<string, Record<string, unknown>> = {};
    const urls: Record<string, string> = {};
    for (const [name, fn] of ctx.functionItems()) {
      const deployments = plans[name];
      for (const ev of eventsOf(fn, "topic")) {
        if (ev.filter) {
          doc.warnings.push(
            `GCP: topic filter on '${name}' (${ev.name}) is not applied by Pub/Sub triggers; filter the records in your handler`,
          );
        }
      }
      if (deployments.length > 1) {
        doc.warnings.push(
          `GCP: function '${name}' is deployed as ${deployments.length} Cloud Functions: ` +
            deployments.map((d) => ctx.physicalName(d.key)).join(", "),
        );
      }
      const ids: string[] = [];
      const out: Record<string, unknown> = {};
      for (const dep of deployments) {
        const res = this.function(doc, ctx, name, fn, dep, source, invokerEmail, depends);
        ids.push(ref(res, "name"));
        const service = ref(res, "service_config[0].service");
        doc.resource("google_cloud_run_service_iam_member", `${dep.key}-invoker`, {
          project,
          location: region,
          service,
          role: "roles/run.invoker",
          member: "serviceAccount:" + invokerEmail,
        });
        if (dep.kind === "http") {
          urls[name] = ref(res, "url");
          const httpEvents = eventsOf(fn, "http");
          if (httpEvents.some((ev) => ev.auth === "none")) {
            doc.resource("google_cloud_run_service_iam_member", `${dep.key}-public`, {
              project,
              location: region,
              service,
              role: "roles/run.invoker",
              member: "allUsers",
            });
          }
          if (httpEvents.length) {
            out.url = ref(res, "url");
            out.base_url = ref(res, "url");
          }
        }
        dep.schedules.forEach((ev, i) => this.schedule(doc, ctx, name, fn, dep, i, ev, ref(res, "url"), invokerEmail));
      }
      out.id = ids[0];
      out.console =
        `https://console.cloud.google.com/functions/details/${region}/${ctx.physicalName(deployments[0].key)}` +
        `?env=gen2&project=${project}`;
      if (ids.length > 1) out.extra = ids.slice(1);
      fnOut[name] = out;
    }

    const wfOut = this.workflows(doc, ctx, urls, invokerEmail, depends);
    doc.output("nskit", { functions: fnOut, workflows: wfOut, endpoint: null }, { description: "node_serverless_kit deployment summary" });
  }

  // ------------------------------------------------------------------ pieces
  /** Upload the artifact zip; returns the `storage_source` block. */
  private source(doc: TerraformDoc, ctx: RenderContext, project: string): Record<string, string> {
    let bucket: string;
    const existing = ctx.opt<string | undefined>("artifact_bucket");
    if (existing) {
      bucket = escape(String(existing));
    } else {
      const prefix = ctx.prefix.slice(0, 45).replace(/-+$/, "");
      const b = doc.resource("google_storage_bucket", "source", {
        project,
        name: `${prefix}-src-${stableSuffix([project, ctx.prefix], 8)}`,
        location: ctx.region.toUpperCase(),
        uniform_bucket_level_access: true,
        public_access_prevention: "enforced",
        force_destroy: true,
        labels: labels(ctx.tags()),
      });
      bucket = ref(b, "name");
    }
    const obj = doc.resource("google_storage_bucket_object", "source", {
      name: `${ctx.prefix}/source-${ctx.artifact.sha256.slice(0, 16)}.zip`,
      bucket,
      source: "${path.module}/artifact.zip",
      content_type: "application/zip",
    });
    return { bucket: ref(obj, "bucket"), object: ref(obj, "name") };
  }

  private topic(doc: TerraformDoc, ctx: RenderContext, name: string, existing: boolean): string {
    const label = `t-${name}`;
    const project = ctx.opt<string>("project", "");
    if (existing) return doc.data("google_pubsub_topic", label, { project, name });
    if (!doc.hasResource("google_pubsub_topic", label)) {
      doc.resource("google_pubsub_topic", label, { project, name, labels: labels(ctx.tags()) });
    }
    return `google_pubsub_topic.${tfId(label)}`;
  }

  private bucket(doc: TerraformDoc, ctx: RenderContext, ev: StorageEvent): string {
    if (ev.existing) return escape(ev.bucket);
    const label = `b-${ev.bucket}`;
    if (!doc.hasResource("google_storage_bucket", label)) {
      doc.resource("google_storage_bucket", label, {
        project: ctx.opt<string>("project", ""),
        name: ev.bucket,
        location: ctx.region.toUpperCase(),
        uniform_bucket_level_access: true,
        labels: labels(ctx.tags()),
      });
    }
    return ref("google_storage_bucket", tfId(label), "name");
  }

  private function(
    doc: TerraformDoc,
    ctx: RenderContext,
    name: string,
    fn: FunctionConfig,
    dep: Deployment,
    source: Record<string, string>,
    invokerEmail: string,
    depends: string[],
  ): string {
    const env = ctx.environment(name, fn); // NSKIT_FUNCTION stays the logical name
    env.NSKIT_GCP_PROJECT = ctx.opt<string>("project", "");
    const serviceConfig: Record<string, unknown> = {
      available_memory: `${ctx.memoryOf(fn)}M`,
      timeout_seconds: ctx.timeoutOf(fn),
      ingress_settings: String(ctx.opt("ingress", "ALLOW_ALL")),
      all_traffic_on_latest_revision: true,
    };
    if (fn.concurrency) serviceConfig.max_instance_count = fn.concurrency;
    const runtimeSa = fn.iam.role ?? ctx.config.provider.iam.role ?? ctx.opt<string | undefined>("service_account");
    if (runtimeSa) serviceConfig.service_account_email = escape(String(runtimeSa));
    const buildConfig: Record<string, unknown> = {
      runtime: ctx.runtimeIdOf(fn),
      entry_point: dep.kind === "http" ? "nskit_http" : "nskit_event",
      source: { storage_source: source },
    };
    const buildSa = ctx.opt<string | undefined>("build_service_account");
    if (buildSa) {
      const sa = String(buildSa);
      buildConfig.service_account = escape(sa.startsWith("projects/") ? sa : `projects/${ctx.opt("project", "-")}/serviceAccounts/${sa}`);
    }
    const body: Record<string, unknown> = {
      project: ctx.opt<string>("project", ""),
      name: ctx.physicalName(dep.key),
      location: ctx.region,
      description: fn.description.slice(0, 256),
      labels: labels({ ...ctx.tags(fn), "nskit-function": name }),
      build_config: buildConfig,
      service_config: serviceConfig,
    };
    if (dep.kind !== "http") {
      const trigger: Record<string, unknown> = {
        trigger_region: ctx.region,
        retry_policy: "RETRY_POLICY_RETRY",
        service_account_email: invokerEmail,
      };
      if (dep.kind === "queue" || dep.kind === "topic") {
        env.NSKIT_TRIGGER_KIND = dep.kind;
        const src = pubsubSource(dep);
        trigger.event_type = PUBSUB_EVENT;
        trigger.pubsub_topic = ref(this.topic(doc, ctx, src.name, src.existing), "id");
      } else {
        const ev = dep.storage!;
        if (ev.prefix) env.NSKIT_STORAGE_PREFIX = ev.prefix;
        if (ev.suffix) env.NSKIT_STORAGE_SUFFIX = ev.suffix;
        trigger.event_type = STORAGE_EVENTS[dep.action ?? "created"];
        trigger.event_filters = [{ attribute: "bucket", value: this.bucket(doc, ctx, ev) }];
      }
      body.event_trigger = trigger;
    }
    serviceConfig.environment_variables = escapeMap(env);
    if (depends.length) body.depends_on = [...depends];
    Object.assign(body, fn.options); // escape hatch: kms_key_name, service_config overrides, ...
    return doc.resource(FN, dep.key, body);
  }

  private schedule(
    doc: TerraformDoc,
    ctx: RenderContext,
    name: string,
    fn: FunctionConfig,
    dep: Deployment,
    i: number,
    ev: ScheduleEvent,
    url: string,
    invokerEmail: string,
  ): void {
    const payload = Buffer.from(JSON.stringify(envelope("schedule", ev.input ?? null, { source: "gcp.scheduler" })), "utf-8").toString(
      "base64",
    );
    const body: Record<string, unknown> = {
      project: ctx.opt<string>("project", ""),
      name: ctx.physicalName(`${name}-${ev.name ?? i}`),
      region: ctx.region,
      schedule: sched.toCron5(ev),
      time_zone: ev.timezone,
      paused: !ev.enabled,
    };
    if (dep.pubsubSchedules) {
      // No HTTP deployment: publish the envelope to the function's topic.
      const src = pubsubSource(dep);
      body.pubsub_target = { topic_name: ref(this.topic(doc, ctx, src.name, src.existing), "id"), data: payload };
    } else {
      body.attempt_deadline = `${Math.min(1800, Math.max(15, ctx.timeoutOf(fn)))}s`;
      body.http_target = {
        http_method: "POST",
        uri: url,
        body: payload,
        headers: { "Content-Type": "application/json" },
        oidc_token: { service_account_email: invokerEmail, audience: url },
      };
    }
    doc.resource("google_cloud_scheduler_job", `${name}-${i}`, body);
  }

  private workflows(
    doc: TerraformDoc,
    ctx: RenderContext,
    urls: Record<string, string>,
    invokerEmail: string,
    depends: string[],
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const project = ctx.opt<string>("project", "");
    for (const [name, wf] of Object.entries(ctx.config.workflows).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (ctx.workflowEngines[name] !== "native") {
        out[name] = { id: ref(FN, tfId(`${name}-orchestrator`), "name") };
        continue;
      }
      // Placeholders keep Terraform references out of `escape`, then are swapped in.
      const fnNames = Object.keys(urls).sort();
      const placeholder = (f: string) => `__NSKIT_URL_${fnNames.indexOf(f)}__`;
      const { source, warnings } = compileGcpWorkflow(definitionData(wf), placeholder, name);
      doc.warnings.push(...warnings);
      let text = escape(JSON.stringify(source, null, 2));
      for (const f of fnNames) text = text.split(placeholder(f)).join(urls[f]);
      const body: Record<string, unknown> = {
        project,
        name: ctx.physicalName(name),
        region: ctx.region,
        description: wf.description.slice(0, 256),
        service_account: invokerEmail,
        labels: labels(ctx.tags()),
        source_contents: text,
        // Provider >= 6 defaults to true, which would make `nskit remove` fail.
        deletion_protection: false,
      };
      if (depends.length) body.depends_on = [...depends];
      const res = doc.resource("google_workflows_workflow", `wf-${name}`, body);
      out[name] = {
        id: ref(res, "id"),
        console: `https://console.cloud.google.com/workflows/workflow/${ctx.region}/${ctx.physicalName(name)}?project=${project}`,
      };
    }
    return out;
  }
}
