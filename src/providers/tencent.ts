/**
 * Tencent Cloud: SCF + API Gateway + timer / COS triggers.
 *
 * Options (`provider.options`): `profile` (tccli profile for the tencentcloud
 * Terraform provider), `namespace` (SCF namespace, default `default`).
 * Per-function `options` are merged into `tencentcloud_scf_function`
 * (vpc_id, subnet_id, layers, cls_logset_id, ...).
 *
 * Workflows run on the embedded engine (`<workflow>-orchestrator` functions).
 */

import { copyFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { corsOf, eventsOf, memoryOf, type FunctionConfig, type HttpEvent, type ServiceConfig } from "../config/schema.js";
import { envelope } from "../runtime/envelope.js";
import {
  HTTP,
  Issue,
  Provider,
  SCHEDULE,
  STORAGE,
  type BundleTarget,
  type Capability,
  type EntryContext,
  type RenderContext,
} from "./base.js";
import * as sched from "./schedule.js";
import { escape, escapeMap, ref, tfId, type TerraformDoc } from "./terraform-doc.js";

const FUNCTION = "tencentcloud_scf_function";
const BUCKET_RE = /^[a-z0-9][a-z0-9-]*-\d+$/;

/** API Gateway has no greedy params; `/files/{p+}` becomes prefix `/files`. */
export function gatewayPath(p: string): string {
  let segments = p.split("/").filter(Boolean);
  if (segments.length && segments[segments.length - 1].endsWith("+}")) segments = segments.slice(0, -1);
  return "/" + segments.join("/");
}

export class TencentProvider extends Provider {
  readonly name = "tencent";
  readonly displayName = "Tencent Cloud SCF";
  override readonly tier = "beta";
  readonly terraformSource = "tencentcloudstack/tencentcloud";
  override readonly terraformVersion = ">= 1.81.0";
  override readonly terraformLocalName = "tencentcloud";
  override readonly defaultRegion = "ap-guangzhou";
  override readonly capabilities = new Set<Capability>([HTTP, SCHEDULE, STORAGE]);
  override readonly maxNameLength = 60;
  override readonly namePattern = /[^a-z0-9_-]/g;
  // SCF Node.js runtimes: https://www.tencentcloud.com/document/product/583/11060
  override readonly runtimes = { nodejs18: "Nodejs18.15", nodejs20: "Nodejs20.19" };
  override readonly maxTimeout = 900;
  override readonly notes =
    "HTTP via an API Gateway service (one API per route, released to `release`); " +
    "timer and COS triggers; COS bucket names must include the APPID suffix (name-1250000000).";
  override readonly bundle: BundleTarget = { format: "cjs", platform: "node", entryFile: "index.js" };

  // ------------------------------------------------------------------ bundle
  entryCode(ctx: EntryContext): string {
    // SCF handler `index.main_handler`; `handler` is exported too for local tools.
    return `export { main_handler, handler } from ${JSON.stringify(ctx.runtime("adapters/tencent"))};`;
  }

  override providerBlock(ctx: RenderContext): Record<string, unknown> {
    const block: Record<string, unknown> = { region: ctx.region };
    if (ctx.opt("profile")) block.profile = ctx.opt("profile");
    return block;
  }

  override physicalName(service: string, stage: string, logical: string): string {
    // SCF names must start with a letter and must not end with '-' or '_'.
    return super.physicalName(service, stage, logical).replace(/[-_]+$/, "") || "fn";
  }

  override extraValidation(config: ServiceConfig): Issue[] {
    const issues: Issue[] = [];
    if (config.provider.iam.statements.length) {
      issues.push(
        new Issue(
          "warning",
          "iam.statements are not translated to CAM policies on Tencent; set iam.role to an existing CAM role name",
          "provider.iam",
        ),
      );
    }
    for (const [name, fn] of Object.entries(config.functions)) {
      const where = `functions.${name}`;
      for (const ev of eventsOf(fn, "http")) {
        if (ev.auth !== "none") issues.push(new Issue("error", `http auth \`${ev.auth}\` is not supported on Tencent (use none)`, where));
        if (ev.method === "PATCH") issues.push(new Issue("error", "Tencent API Gateway does not support PATCH; use ANY", where));
      }
      for (const ev of eventsOf(fn, "storage")) {
        if (!BUCKET_RE.test(ev.bucket)) {
          issues.push(new Issue("error", `COS bucket '${ev.bucket}' must be '<name>-<APPID>', e.g. uploads-1250000000`, where));
        }
      }
      const memory = memoryOf(config, fn);
      if (memory !== 64 && memory !== 128 && memory % 128 !== 0) {
        issues.push(new Issue("error", `SCF memory must be 64, 128 or a multiple of 128 MB (got ${memory})`, where));
      }
    }
    return issues;
  }

  // ------------------------------------------------------------------ render
  renderResources(doc: TerraformDoc, ctx: RenderContext): void {
    const cfg = ctx.config;
    const zipName = this.artifactCopy(ctx);
    const namespace = ctx.opt<string>("namespace", "default");
    const fnOut: Record<string, Record<string, unknown>> = {};
    let service: string | undefined;
    const apis: string[] = [];
    for (const [name, fn] of ctx.functionItems()) {
      const res = this.scfFunction(doc, ctx, name, fn, zipName);
      const out: Record<string, unknown> = {
        id: ref(res, "name"),
        console: `https://console.cloud.tencent.com/scf/list-detail?ns=${namespace}&id=${ctx.physicalName(name)}`,
      };
      const httpEvents = eventsOf(fn, "http");
      if (httpEvents.length) {
        service ??= this.service(doc, ctx);
        apis.push(...this.apis(doc, ctx, service, name, res, fn, httpEvents));
        out.base_url = "https://" + ref(service, "outer_sub_domain") + "/release";
      }
      fnOut[name] = out;
    }

    let endpoint: string | null = null;
    if (service) {
      doc.resource("tencentcloud_api_gateway_service_release", "release", {
        service_id: ref(service, "id"),
        environment_name: "release",
        release_desc: `node-serverless-kit ${ctx.artifact.sha256.slice(0, 12)}`,
        depends_on: apis,
      });
      endpoint = "https://" + ref(service, "outer_sub_domain") + "/release";
    }

    const wfOut: Record<string, unknown> = {};
    for (const n of Object.keys(cfg.workflows).sort()) wfOut[n] = { id: ref(FUNCTION, tfId(`${n}-orchestrator`), "name") };
    doc.output("nskit", { functions: fnOut, workflows: wfOut, endpoint }, { description: "node-serverless-kit deployment summary" });
  }

  // ------------------------------------------------------------------ pieces
  /** SCF only re-uploads when the `zip_file` *path* changes, so point it at a content-addressed copy. */
  private artifactCopy(ctx: RenderContext): string {
    const name = `artifact-${ctx.artifact.sha256.slice(0, 16)}.zip`;
    const target = path.join(ctx.workDir, name);
    if (existsSync(ctx.workDir)) {
      for (const old of readdirSync(ctx.workDir)) {
        if (/^artifact-.+\.zip$/.test(old) && old !== name) unlinkSync(path.join(ctx.workDir, old));
      }
    }
    if (!existsSync(target) && existsSync(ctx.artifact.path)) copyFileSync(ctx.artifact.path, target);
    return name;
  }

  private scfFunction(doc: TerraformDoc, ctx: RenderContext, name: string, fn: FunctionConfig, zipName: string): string {
    const cfg = ctx.config;
    const triggers: Record<string, unknown>[] = [];
    const configs: Record<string, unknown>[] = [];
    eventsOf(fn, "schedule").forEach((ev, i) => {
      const tname = (ev.name ?? `timer-${i}`).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100);
      const desc = "0 " + sched.namedCron5(ev) + " *";
      triggers.push({ name: tname, type: "timer", trigger_desc: desc });
      if (ev.input !== undefined || !ev.enabled) {
        configs.push({
          trigger_name: tname,
          type: "timer",
          trigger_desc: desc,
          enable: ev.enabled ? "OPEN" : "CLOSE",
          custom_argument: escape(JSON.stringify(envelope("schedule", ev.input ?? null, { source: "tencent.timer" }))),
        });
      }
    });
    for (const ev of eventsOf(fn, "storage")) {
      const label = `b-${ev.bucket}`;
      if (!ev.existing && !doc.hasResource("tencentcloud_cos_bucket", label)) {
        doc.resource("tencentcloud_cos_bucket", label, { bucket: ev.bucket, acl: "private", tags: ctx.tags() });
      }
      for (const action of ev.events) {
        const descObj: Record<string, unknown> = { event: action === "created" ? "cos:ObjectCreated:*" : "cos:ObjectRemove:*" };
        if (ev.prefix || ev.suffix) descObj.filter = { Prefix: ev.prefix ?? "", Suffix: ev.suffix ?? "" };
        triggers.push({
          name: `${ev.bucket}.cos.${ctx.region}.myqcloud.com`,
          type: "cos",
          cos_region: ctx.region,
          trigger_desc: escape(JSON.stringify(descObj)),
        });
      }
    }
    const body: Record<string, unknown> = {
      name: ctx.physicalName(name),
      description: fn.description.replace(/[^\w\s,.一-鿿]/g, " ").slice(0, 1000),
      handler: `${ctx.artifact.entryFile.replace(/\.[cm]?js$/, "")}.main_handler`,
      runtime: ctx.runtimeIdOf(fn),
      mem_size: ctx.memoryOf(fn),
      timeout: ctx.timeoutOf(fn),
      namespace: ctx.opt<string>("namespace", "default"),
      zip_file: "${path.module}/" + zipName,
      enable_public_net: true,
      environment: escapeMap(ctx.environment(name, fn)),
      tags: ctx.tags(fn),
    };
    if (triggers.length) body.triggers = triggers;
    const role = fn.iam.role ?? cfg.provider.iam.role;
    if (role) body.role = escape(role);
    Object.assign(body, fn.options); // escape hatch: vpc_id, subnet_id, layers, cls_*...
    const res = doc.resource(FUNCTION, name, body);
    for (const c of configs) {
      doc.resource("tencentcloud_scf_trigger_config", `${name}-${c.trigger_name as string}`, {
        function_name: ref(res, "name"),
        namespace: ref(res, "namespace"),
        ...c,
      });
    }
    return res;
  }

  private service(doc: TerraformDoc, ctx: RenderContext): string {
    return doc.resource("tencentcloud_api_gateway_service", "http", {
      service_name: ctx.prefix.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 50),
      protocol: "http&https",
      service_desc: `node-serverless-kit ${ctx.service} (${ctx.stage})`,
      net_type: ["OUTER"],
      ip_version: "IPv4",
      tags: ctx.tags(),
    });
  }

  private apis(
    doc: TerraformDoc,
    ctx: RenderContext,
    service: string,
    name: string,
    fnRes: string,
    fn: FunctionConfig,
    events: HttpEvent[],
  ): string[] {
    return events.map((ev, i) => {
      const p = gatewayPath(ev.path);
      const params = [...p.matchAll(/\{([A-Za-z_]\w*)\}/g)].map((m) => m[1]);
      const body: Record<string, unknown> = {
        service_id: ref(service, "id"),
        api_name: `${name}_${i}`.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 60),
        api_desc: escape(`${ev.method} ${ev.path} -> ${name}`),
        auth_type: "NONE",
        protocol: "HTTP",
        enable_cors: corsOf(ev) !== undefined,
        request_config_path: escape(p),
        request_config_method: ev.method,
        service_config_type: "SCF",
        service_config_scf_function_name: ref(fnRes, "name"),
        service_config_scf_function_namespace: ref(fnRes, "namespace"),
        service_config_scf_function_qualifier: "$LATEST",
        service_config_scf_is_integrated_response: true,
        service_config_timeout: Math.min(ctx.timeoutOf(fn), 1800),
        response_type: "JSON",
      };
      if (params.length) {
        body.request_parameters = params.map((pn) => ({ name: pn, position: "PATH", type: "string", required: true, desc: pn }));
      }
      return doc.resource("tencentcloud_api_gateway_api", `${name}-${i}`, body);
    });
  }
}
