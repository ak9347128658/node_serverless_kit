/**
 * Alibaba Cloud: Function Compute 3.0 + HTTP / timer / OSS / MNS-topic triggers.
 *
 * Options (`provider.options`): `profile` (aliyun CLI profile for the alicloud
 * Terraform provider). Per-function `options` are merged into
 * `alicloud_fcv3_function` (vpc_config, log_config, layers, ...).
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
import { escape, escapeMap, ref, tfId, type TerraformDoc } from "./terraform-doc.js";

const FUNCTION = "alicloud_fcv3_function";
const TRIGGER = "alicloud_fcv3_trigger";
const ALL_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
const TRUST = JSON.stringify({
  Version: "1",
  Statement: [{ Action: "sts:AssumeRole", Effect: "Allow", Principal: { Service: ["oss.aliyuncs.com", "mns.aliyuncs.com"] } }],
});

/** FC timer expression: `@every 5m` for rates, 6-field cron (seconds first) with named weekdays otherwise. */
export function timerExpression(ev: ScheduleEvent): string {
  let expr = ev.rate ? sched.everyExpression(ev) : "0 " + sched.namedCron5(ev);
  if (ev.cron && ev.timezone && ev.timezone !== "UTC") expr = `CRON_TZ=${ev.timezone} ${expr}`;
  return expr;
}

export class AlibabaProvider extends Provider {
  readonly name = "alibaba";
  readonly displayName = "Alibaba Cloud Function Compute";
  override readonly tier = "beta";
  readonly terraformSource = "aliyun/alicloud";
  // `http_trigger[0].url_internet` on alicloud_fcv3_trigger is available since 1.234.0.
  override readonly terraformVersion = ">= 1.234.0";
  override readonly terraformLocalName = "alicloud";
  override readonly defaultRegion = "cn-hangzhou";
  override readonly capabilities = new Set<Capability>([HTTP, SCHEDULE, STORAGE, TOPIC]);
  override readonly maxNameLength = 64;
  override readonly namePattern = /[^a-z0-9_-]/g;
  // FC 3.0 built-in runtimes: https://www.alibabacloud.com/help/en/functioncompute/fc/runtime-overview-3
  override readonly runtimes = { nodejs18: "nodejs18", nodejs20: "nodejs20" };
  override readonly maxTimeout = 3600; // FC allows up to 86400s, the config schema caps timeout at 3600
  override readonly notes =
    "FC 3.0 with one HTTP trigger per function (fcapp.run URL); schedules via timer triggers; " +
    "OSS and MNS-topic triggers; workflows run on the embedded engine.";
  override readonly bundle: BundleTarget = { format: "cjs", platform: "node", entryFile: "index.js" };

  // ------------------------------------------------------------------ bundle
  entryCode(ctx: EntryContext): string {
    // FC handler `index.handler`.
    return `export { handler } from ${JSON.stringify(ctx.runtime("adapters/alibaba"))};`;
  }

  override providerBlock(ctx: RenderContext): Record<string, unknown> {
    const block: Record<string, unknown> = { region: ctx.region };
    if (ctx.opt("profile")) block.profile = ctx.opt("profile");
    return block;
  }

  override extraValidation(config: ServiceConfig): Issue[] {
    const issues: Issue[] = [];
    if (config.provider.iam.statements.length) {
      issues.push(
        new Issue(
          "warning",
          "iam.statements are not translated to RAM policies on Alibaba; set iam.role to an existing " +
            "RAM role ARN with the permissions your functions need",
          "provider.iam",
        ),
      );
    }
    for (const [name, fn] of Object.entries(config.functions)) {
      if (fn.iam.statements.length) {
        issues.push(new Issue("warning", "iam.statements are ignored on Alibaba; use iam.role", `functions.${name}.iam`));
      }
      for (const ev of eventsOf(fn, "http")) {
        if (ev.auth !== "none") {
          issues.push(new Issue("error", `http auth \`${ev.auth}\` is not supported on Alibaba (use none)`, `functions.${name}`));
        }
      }
    }
    return issues;
  }

  // ------------------------------------------------------------------ render
  renderResources(doc: TerraformDoc, ctx: RenderContext): void {
    const cfg = ctx.config;
    const needsRole = Object.values(cfg.functions).some((fn) => eventsOf(fn, "storage").length || eventsOf(fn, "topic").length);
    const roleArn = needsRole ? this.triggerRole(doc, ctx) : undefined;
    const account = needsRole ? doc.data("alicloud_account", "current", {}) : undefined;

    const fnOut: Record<string, Record<string, unknown>> = {};
    let endpoint: string | null = null;
    for (const [name, fn] of ctx.functionItems()) {
      const res = this.fcFunction(doc, ctx, name, fn);
      const out: Record<string, unknown> = {
        id: ref(res, "function_name"),
        arn: ref(res, "function_arn"),
        console: `https://fcnext.console.aliyun.com/${ctx.region}/functions/${ctx.physicalName(name)}`,
      };
      const httpEvents = eventsOf(fn, "http");
      if (httpEvents.length) {
        const trig = this.http(doc, name, res, httpEvents);
        const url = ref(trig, "http_trigger[0].url_internet");
        out.url = url;
        out.base_url = url;
        endpoint ??= url;
      }
      eventsOf(fn, "schedule").forEach((ev, i) => this.timer(doc, name, res, i, ev));
      for (const ev of eventsOf(fn, "storage")) this.oss(doc, ctx, name, res, ev, roleArn!, account!);
      for (const ev of eventsOf(fn, "topic")) this.mnsTopic(doc, ctx, name, res, ev, roleArn!, account!);
      fnOut[name] = out;
    }

    const wfOut: Record<string, unknown> = {};
    for (const n of Object.keys(cfg.workflows).sort()) wfOut[n] = { id: ref(FUNCTION, tfId(`${n}-orchestrator`), "function_name") };
    doc.output("nskit", { functions: fnOut, workflows: wfOut, endpoint }, { description: "node_serverless_kit deployment summary" });
  }

  // ------------------------------------------------------------------ pieces
  private triggerRole(doc: TerraformDoc, ctx: RenderContext): string {
    const role = doc.resource("alicloud_ram_role", "triggers", {
      role_name: ctx.physicalName("triggers").slice(0, 64),
      assume_role_policy_document: TRUST,
      description: `node_serverless_kit trigger role for ${ctx.prefix}`,
      force: true,
    });
    doc.resource("alicloud_ram_role_policy_attachment", "triggers-invoke", {
      role_name: ref(role, "role_name"),
      policy_name: "AliyunFCInvocationAccess",
      policy_type: "System",
    });
    return ref(role, "arn");
  }

  private fcFunction(doc: TerraformDoc, ctx: RenderContext, name: string, fn: FunctionConfig): string {
    const cfg = ctx.config;
    const body: Record<string, unknown> = {
      function_name: ctx.physicalName(name),
      description: fn.description.slice(0, 256),
      handler: `${ctx.artifact.entryFile.replace(/\.[cm]?js$/, "")}.handler`,
      runtime: ctx.runtimeIdOf(fn),
      memory_size: ctx.memoryOf(fn),
      timeout: ctx.timeoutOf(fn),
      internet_access: true,
      environment_variables: escapeMap(ctx.environment(name, fn)),
      code: { zip_file: '${filebase64("${path.module}/artifact.zip")}' },
      tags: ctx.tags(fn),
    };
    const role = fn.iam.role ?? cfg.provider.iam.role;
    if (role) body.role = escape(role);
    if (fn.concurrency) body.instance_concurrency = fn.concurrency;
    Object.assign(body, fn.options); // escape hatch: vpc_config, layers, log_config, ...
    return doc.resource(FUNCTION, name, body);
  }

  private http(doc: TerraformDoc, name: string, fnRes: string, events: HttpEvent[]): string {
    const methods: string[] = [];
    for (const ev of events) {
      for (const m of ev.method === "ANY" ? ALL_METHODS : [ev.method]) if (!methods.includes(m)) methods.push(m);
    }
    if (events.some((ev) => corsOf(ev) !== undefined) && !methods.includes("OPTIONS")) methods.push("OPTIONS");
    const config = { authType: "anonymous", methods, disableURLInternet: false };
    return doc.resource(TRIGGER, `${name}-http`, {
      function_name: ref(fnRes, "function_name"),
      trigger_name: "http",
      trigger_type: "http",
      qualifier: "LATEST",
      trigger_config: JSON.stringify(config),
    });
  }

  private timer(doc: TerraformDoc, name: string, fnRes: string, i: number, ev: ScheduleEvent): void {
    const config = {
      cronExpression: timerExpression(ev),
      enable: Boolean(ev.enabled),
      payload: JSON.stringify(envelope("schedule", ev.input ?? null, { source: "alibaba.timer" })),
    };
    doc.resource(TRIGGER, `${name}-timer-${i}`, {
      function_name: ref(fnRes, "function_name"),
      trigger_name: (ev.name ?? `timer-${i}`).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 128),
      trigger_type: "timer",
      qualifier: "LATEST",
      trigger_config: escape(JSON.stringify(config)),
    });
  }

  private oss(
    doc: TerraformDoc,
    ctx: RenderContext,
    name: string,
    fnRes: string,
    ev: StorageEvent,
    role: string,
    account: string,
  ): void {
    const label = `b-${ev.bucket}`;
    if (!ev.existing && !doc.hasResource("alicloud_oss_bucket", label)) {
      doc.resource("alicloud_oss_bucket", label, { bucket: ev.bucket, tags: ctx.tags() });
    }
    const events = ev.events.map((e) => (e === "created" ? "oss:ObjectCreated:*" : "oss:ObjectRemoved:*"));
    const config = { events, filter: { key: { prefix: ev.prefix ?? "", suffix: ev.suffix ?? "" } } };
    const body: Record<string, unknown> = {
      function_name: ref(fnRes, "function_name"),
      trigger_name: `oss-${tfId(ev.bucket)}`.slice(0, 128),
      trigger_type: "oss",
      qualifier: "LATEST",
      invocation_role: role,
      source_arn: `acs:oss:${ctx.region}:${ref(account, "id")}:${ev.bucket}`,
      trigger_config: escape(JSON.stringify(config)),
    };
    if (!ev.existing) body.depends_on = [`alicloud_oss_bucket.${tfId(label)}`];
    doc.resource(TRIGGER, `${name}-oss-${ev.bucket}`, body);
  }

  private mnsTopic(
    doc: TerraformDoc,
    ctx: RenderContext,
    name: string,
    fnRes: string,
    ev: TopicEvent,
    role: string,
    account: string,
  ): void {
    const label = `t-${ev.name}`;
    if (!ev.existing && !doc.hasResource("alicloud_message_service_topic", label)) {
      doc.resource("alicloud_message_service_topic", label, { topic_name: ev.name, tags: ctx.tags() });
    }
    const config: Record<string, unknown> = { notifyContentFormat: "JSON", notifyStrategy: "BACKOFF_RETRY" };
    if (ev.filter && typeof ev.filter.tag === "string") config.filterTag = ev.filter.tag;
    const body: Record<string, unknown> = {
      function_name: ref(fnRes, "function_name"),
      trigger_name: `mns-${tfId(ev.name)}`.slice(0, 128),
      trigger_type: "mns_topic",
      qualifier: "LATEST",
      invocation_role: role,
      source_arn: `acs:mns:${ctx.region}:${ref(account, "id")}:/topics/${ev.name}`,
      trigger_config: escape(JSON.stringify(config)),
    };
    if (!ev.existing) body.depends_on = [`alicloud_message_service_topic.${tfId(label)}`];
    doc.resource(TRIGGER, `${name}-mns-${ev.name}`, body);
  }
}
