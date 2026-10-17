/**
 * Huawei Cloud: FunctionGraph + dedicated API Gateway + timer / OBS / SMN triggers.
 *
 * Options (`provider.options`): `apig_instance_id` (required for HTTP events: an
 * existing dedicated APIG instance), `app` (FunctionGraph application, default
 * `default`), `profile`, `enterprise_project_id`. Per-function `options` are
 * merged into `huaweicloud_fgs_function` (vpc_id, network_id, depend_list, ...).
 *
 * Workflows run on the embedded engine (`<workflow>-orchestrator` functions).
 */

import {
  corsOf,
  eventsOf,
  type FunctionConfig,
  type HttpEvent,
  type ScheduleEvent,
  type ServiceConfig,
  type StorageEvent,
  type TopicEvent,
} from "../config/schema.js";
import { envelope } from "../runtime/envelope.js";
import {
  HTTP,
  Issue,
  Provider,
  SCHEDULE,
  STORAGE,
  TOPIC,
  type BundleTarget,
  type Capability,
  type EntryContext,
  type RenderContext,
} from "./base.js";
import * as sched from "./schedule.js";
import { escape, ref, tfId, type TerraformDoc } from "./terraform-doc.js";

const FUNCTION = "huaweicloud_fgs_function";
const TRIGGER = "huaweicloud_fgs_trigger";
const AUTH: Record<string, string> = { none: "NONE", iam: "IAM", key: "APP" };

/** FunctionGraph cron: `sec min hour dom month dow` where dom or dow must be `?`. */
export function quartzCron(ev: ScheduleEvent): string {
  let [minute, hour, dom, month, dow] = sched.namedCron5(ev).split(" ");
  if (dow === "*") dow = "?";
  else if (dom === "*") dom = "?";
  return `0 ${minute} ${hour} ${dom} ${month} ${dow}`;
}

/** FunctionGraph rate schedule: `5m`, `2h`, `1d`. */
export function rateExpression(ev: ScheduleEvent): string {
  const [value, unit] = sched.parseRate(ev.rate ?? "");
  return `${value}${unit[0]}`;
}

function gatewayPath(p: string): [string, "Exact" | "Prefix"] {
  const segments = p.split("/").filter(Boolean);
  if (segments.length && segments[segments.length - 1].endsWith("+}")) return ["/" + segments.slice(0, -1).join("/"), "Prefix"];
  return ["/" + segments.join("/"), "Exact"];
}

/** Stable JSON with sorted keys (user_data must be byte-reproducible). */
function sortedJson(values: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

interface Gateway {
  instance: string;
  group: string;
  env: string;
  url: string;
}

export class HuaweiProvider extends Provider {
  readonly name = "huawei";
  readonly displayName = "Huawei Cloud FunctionGraph";
  override readonly tier = "beta";
  readonly terraformSource = "huaweicloud/huaweicloud";
  override readonly terraformVersion = ">= 1.60.0";
  override readonly terraformLocalName = "huaweicloud";
  override readonly defaultRegion = "cn-north-4";
  override readonly capabilities = new Set<Capability>([HTTP, SCHEDULE, STORAGE, TOPIC]);
  override readonly maxNameLength = 60;
  override readonly namePattern = /[^a-z0-9_-]/g;
  // FunctionGraph runtimes: https://support.huaweicloud.com/intl/en-us/usermanual-functiongraph/functiongraph_01_0151.html
  override readonly runtimes = { nodejs18: "Node.js18.15", nodejs20: "Node.js20.15" };
  override readonly maxTimeout = 900;
  override readonly notes =
    "HTTP needs a dedicated APIG instance (options.apig_instance_id); timers, OBS and SMN triggers; " +
    "workflows run on the embedded engine.";
  override readonly bundle: BundleTarget = { format: "cjs", platform: "node", entryFile: "index.js" };

  // ------------------------------------------------------------------ bundle
  entryCode(ctx: EntryContext): string {
    // FunctionGraph handler `index.handler`.
    return `export { handler } from ${JSON.stringify(ctx.runtime("adapters/huawei"))};`;
  }

  override providerBlock(ctx: RenderContext): Record<string, unknown> {
    const block: Record<string, unknown> = { region: ctx.region };
    for (const key of ["profile", "enterprise_project_id"]) if (ctx.opt(key)) block[key] = ctx.opt(key);
    return block;
  }

  override physicalName(service: string, stage: string, logical: string): string {
    // Names must start with a letter and end with a letter or digit.
    let name = super.physicalName(service, stage, logical);
    if (!/^[a-z]/.test(name)) name = `f${name}`.slice(0, this.maxNameLength);
    return name.replace(/[-_]+$/, "") || "fn";
  }

  override extraValidation(config: ServiceConfig): Issue[] {
    const issues: Issue[] = [];
    const hasHttp = Object.values(config.functions).some((fn) => eventsOf(fn, "http").length);
    if (hasHttp && !config.provider.options.apig_instance_id) {
      issues.push(
        new Issue("error", "HTTP events need a dedicated API Gateway instance: set provider.options.apig_instance_id", "provider.options"),
      );
    }
    if (config.provider.iam.statements.length) {
      issues.push(new Issue("warning", "iam.statements are ignored on Huawei; set iam.role to an IAM agency name", "provider.iam"));
    }
    for (const [name, fn] of Object.entries(config.functions)) {
      for (const ev of eventsOf(fn, "http")) {
        if (!(ev.auth in AUTH)) {
          issues.push(new Issue("error", `http auth \`${ev.auth}\` is not supported on Huawei (none, iam, key)`, `functions.${name}`));
        }
      }
    }
    return issues;
  }

  // ------------------------------------------------------------------ render
  renderResources(doc: TerraformDoc, ctx: RenderContext): void {
    const cfg = ctx.config;
    const fnOut: Record<string, Record<string, unknown>> = {};
    let gateway: Gateway | undefined;
    for (const [name, fn] of ctx.functionItems()) {
      const res = this.fgsFunction(doc, ctx, name, fn);
      const out: Record<string, unknown> = {
        id: ref(res, "name"),
        arn: ref(res, "urn"),
        console: `https://console.huaweicloud.com/functiongraph/?region=${ctx.region}#/serverless/functions`,
      };
      const httpEvents = eventsOf(fn, "http");
      if (httpEvents.length) {
        gateway ??= this.gateway(doc, ctx);
        this.apis(doc, ctx, gateway, name, res, fn, httpEvents);
        out.base_url = gateway.url;
      }
      eventsOf(fn, "schedule").forEach((ev, i) => this.timer(doc, name, res, i, ev));
      for (const ev of eventsOf(fn, "storage")) this.obs(doc, ctx, name, res, ev);
      for (const ev of eventsOf(fn, "topic")) this.smn(doc, ctx, name, res, ev);
      fnOut[name] = out;
    }
    const wfOut: Record<string, unknown> = {};
    for (const n of Object.keys(cfg.workflows).sort()) wfOut[n] = { id: ref(FUNCTION, tfId(`${n}-orchestrator`), "name") };
    doc.output(
      "nskit",
      { functions: fnOut, workflows: wfOut, endpoint: gateway ? gateway.url : null },
      { description: "node_serverless_kit deployment summary" },
    );
  }

  // ------------------------------------------------------------------ pieces
  private fgsFunction(doc: TerraformDoc, ctx: RenderContext, name: string, fn: FunctionConfig): string {
    const cfg = ctx.config;
    const body: Record<string, unknown> = {
      name: ctx.physicalName(name),
      app: ctx.opt<string>("app", "default"),
      description: fn.description.slice(0, 512),
      handler: `${ctx.artifact.entryFile.replace(/\.[cm]?js$/, "")}.handler`,
      runtime: ctx.runtimeIdOf(fn),
      memory_size: ctx.memoryOf(fn),
      timeout: ctx.timeoutOf(fn),
      code_type: "zip",
      code_filename: "artifact.zip",
      func_code: '${filebase64("${path.module}/artifact.zip")}',
      // FunctionGraph exposes user_data entries to the function as environment variables.
      user_data: escape(sortedJson(ctx.environment(name, fn))),
      tags: ctx.tags(fn),
    };
    const agency = fn.iam.role ?? cfg.provider.iam.role;
    if (agency) body.agency = escape(agency);
    if (fn.concurrency) body.concurrency_num = fn.concurrency;
    Object.assign(body, fn.options); // escape hatch: vpc_id, network_id, depend_list, ...
    return doc.resource(FUNCTION, name, body);
  }

  private gateway(doc: TerraformDoc, ctx: RenderContext): Gateway {
    const instance = String(ctx.opt("apig_instance_id"));
    const group = doc.resource("huaweicloud_apig_group", "http", {
      instance_id: instance,
      name: ctx.prefix.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64),
      description: `node_serverless_kit ${ctx.service} (${ctx.stage})`,
      domain_access_enabled: true,
    });
    const env = doc.resource("huaweicloud_apig_environment", "stage", {
      instance_id: instance,
      name: ("nskit_" + ctx.stage.replace(/[^A-Za-z0-9_]/g, "_")).slice(0, 64),
    });
    const groups = doc.data("huaweicloud_apig_groups", "http", { instance_id: instance, group_id: ref(group, "id") });
    return { instance, group, env, url: "https://" + ref(groups, "groups[0].sl_domain") };
  }

  private apis(
    doc: TerraformDoc,
    ctx: RenderContext,
    gw: Gateway,
    name: string,
    fnRes: string,
    fn: FunctionConfig,
    events: HttpEvent[],
  ): void {
    events.forEach((ev, i) => {
      const [p, matching] = gatewayPath(ev.path);
      const body: Record<string, unknown> = {
        instance_id: gw.instance,
        group_id: ref(gw.group, "id"),
        name: `${name}_${i}`.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64),
        type: "Public",
        request_protocol: "BOTH",
        request_method: ev.method,
        request_path: escape(p),
        matching,
        security_authentication: AUTH[ev.auth] ?? "NONE",
        cors: corsOf(ev) !== undefined,
        description: escape(`${ev.method} ${ev.path} -> ${name}`),
        func_graph: {
          function_urn: ref(fnRes, "urn"),
          invocation_type: "sync",
          network_type: "NON-VPC",
          timeout: Math.min(ctx.timeoutOf(fn) * 1000, 600000),
        },
      };
      const params = [...p.matchAll(/\{([A-Za-z_]\w*)\}/g)].map((m) => m[1]);
      if (params.length) {
        body.request_params = params.map((pn) => ({ name: pn, location: "PATH", type: "STRING", required: true, passthrough: true }));
      }
      const api = doc.resource("huaweicloud_apig_api", `${name}-${i}`, body);
      doc.resource("huaweicloud_apig_api_publishment", `${name}-${i}`, {
        instance_id: gw.instance,
        api_id: ref(api, "id"),
        env_id: ref(gw.env, "id"),
      });
    });
  }

  private timer(doc: TerraformDoc, name: string, fnRes: string, i: number, ev: ScheduleEvent): void {
    doc.resource(TRIGGER, `${name}-timer-${i}`, {
      function_urn: ref(fnRes, "urn"),
      type: "TIMER",
      status: ev.enabled ? "ACTIVE" : "DISABLED",
      timer: {
        name: (ev.name ?? `timer-${i}`).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64),
        schedule_type: ev.rate ? "Rate" : "Cron",
        schedule: ev.rate ? rateExpression(ev) : quartzCron(ev),
        additional_information: escape(JSON.stringify(envelope("schedule", ev.input ?? null, { source: "huawei.timer" }))),
      },
    });
  }

  private obs(doc: TerraformDoc, ctx: RenderContext, name: string, fnRes: string, ev: StorageEvent): void {
    const label = `b-${ev.bucket}`;
    const obs: Record<string, unknown> = {
      bucket_name: ev.bucket,
      event_notification_name: `nskit-${name}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64),
      events: ev.events.map((e) => (e === "created" ? "ObjectCreated" : "ObjectRemoved")),
    };
    if (ev.prefix) obs.prefix = escape(ev.prefix);
    if (ev.suffix) obs.suffix = escape(ev.suffix);
    const body: Record<string, unknown> = { function_urn: ref(fnRes, "urn"), type: "OBS", status: "ACTIVE", obs };
    if (!ev.existing) {
      if (!doc.hasResource("huaweicloud_obs_bucket", label)) {
        doc.resource("huaweicloud_obs_bucket", label, { bucket: ev.bucket, acl: "private", tags: ctx.tags() });
      }
      body.depends_on = [`huaweicloud_obs_bucket.${tfId(label)}`];
    }
    doc.resource(TRIGGER, `${name}-obs-${ev.bucket}`, body);
  }

  private smn(doc: TerraformDoc, ctx: RenderContext, name: string, fnRes: string, ev: TopicEvent): void {
    const label = `t-${ev.name}`;
    let topicUrn: string;
    if (ev.existing) {
      topicUrn = ref(doc.data("huaweicloud_smn_topics", label, { name: ev.name }), "topics[0].topic_urn");
    } else {
      if (!doc.hasResource("huaweicloud_smn_topic", label)) {
        doc.resource("huaweicloud_smn_topic", label, { name: ev.name, tags: ctx.tags() });
      }
      topicUrn = ref("huaweicloud_smn_topic", tfId(label), "topic_urn");
    }
    doc.resource(TRIGGER, `${name}-smn-${ev.name}`, {
      function_urn: ref(fnRes, "urn"),
      type: "SMN",
      status: "ACTIVE",
      smn: { topic_urn: topicUrn },
    });
  }
}
