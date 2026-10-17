/**
 * IBM Cloud: Code Engine functions (HTTP endpoints).
 *
 * Every function gets a public HTTPS endpoint and nskit's runtime matches the
 * routes. The artifact zip (`main.js` + `package.json` with `"main": "main.js"`)
 * is sent inline as a base64 data URL in `code_reference`, which Code Engine
 * caps at 1 MiB of text - set `options.code_reference` to a code bundle image
 * for larger bundles.
 *
 * Options (`provider.options`): `project_id` (existing project), `resource_group`,
 * `resource_group_id`, `visibility` (`managed_domain_mappings`: local_public |
 * local_private | local), `code_reference`, `code_secret`.
 * Per-function `options` are merged into `ibm_code_engine_function`
 * (`visibility` there overrides the provider-wide value).
 */

import { eventsOf, memoryOf, type ServiceConfig } from "../config/schema.js";
import type { BundleManifest } from "../runtime/manifest.js";
import { HTTP, Issue, Provider, type BundleTarget, type Capability, type EntryContext, type RenderContext } from "./base.js";
import { escape, ref, tfId, type TerraformDoc } from "./terraform-doc.js";

const FUNCTION = "ibm_code_engine_function";
/** Code Engine function CPU / memory combinations: [vCPU, memory, MB]. */
const SIZES: readonly (readonly [string, string, number])[] = [
  ["0.125", "0.5G", 512],
  ["0.25", "1G", 1024],
  ["0.5", "2G", 2048],
  ["1", "4G", 4096],
];
/** Max length of `code_reference` (characters). */
export const MAX_CODE_REFERENCE = 1_048_576;
const DATA_URL_PREFIX = "data:text/plain;base64,";

export function sizeFor(memoryMb: number): [string, string] {
  for (const [cpu, mem, mb] of SIZES) if (memoryMb <= mb) return [cpu, mem];
  const last = SIZES[SIZES.length - 1];
  return [last[0], last[1]];
}

export class IbmProvider extends Provider {
  readonly name = "ibm";
  readonly displayName = "IBM Cloud Code Engine";
  override readonly tier = "beta";
  readonly terraformSource = "IBM-Cloud/ibm";
  override readonly terraformVersion = ">= 1.70";
  override readonly defaultRegion = "us-south";
  override readonly capabilities = new Set<Capability>([HTTP]);
  override readonly maxNameLength = 63;
  override readonly runtimes = { nodejs22: "nodejs-22", nodejs24: "nodejs-24" };
  override readonly maxTimeout = 120;
  override readonly notes =
    "Every Code Engine function gets a public HTTPS endpoint; routes are matched by the nskit runtime. " +
    "No schedule/queue/storage/topic triggers (the Terraform provider has no function event subscriptions). " +
    "Code is uploaded inline as a base64 data URL (max ~768 KiB zip), so keep bundles small or set " +
    "options.code_reference to a code bundle image. Auth: set IC_API_KEY.";
  override readonly bundle: BundleTarget = { format: "cjs", platform: "node", entryFile: "main.js" };

  // ------------------------------------------------------------------ bundle
  entryCode(ctx: EntryContext): string {
    return `export { main } from ${JSON.stringify(ctx.runtime("adapters/ibm"))};`;
  }

  override extraFiles(_config: ServiceConfig, _manifest: BundleManifest): Record<string, string> {
    return { "package.json": JSON.stringify({ main: this.bundle.entryFile }, null, 2) + "\n" };
  }

  override providerBlock(ctx: RenderContext): Record<string, unknown> {
    const block: Record<string, unknown> = { region: ctx.region };
    if (ctx.opt("resource_group")) block.resource_group = ctx.opt("resource_group");
    return block;
  }

  override extraValidation(config: ServiceConfig): Issue[] {
    const issues: Issue[] = [];
    const maxMb = SIZES[SIZES.length - 1][2];
    for (const [name, fn] of Object.entries(config.functions)) {
      for (const ev of eventsOf(fn, "http")) {
        if (ev.auth !== "none") {
          issues.push(
            new Issue(
              "error",
              `auth \`${ev.auth}\` is not supported on Code Engine functions; validate tokens in the handler`,
              `functions.${name}`,
            ),
          );
        }
      }
      if (memoryOf(config, fn) > maxMb) {
        issues.push(new Issue("error", `Code Engine functions support at most ${maxMb} MB`, `functions.${name}.memory`));
      }
      if (fn.concurrency !== null && fn.concurrency !== undefined && (fn.concurrency < 1 || fn.concurrency > 100)) {
        issues.push(new Issue("error", "Code Engine function concurrency must be 1-100", `functions.${name}.concurrency`));
      }
    }
    return issues;
  }

  // ------------------------------------------------------------------ render
  private project(doc: TerraformDoc, ctx: RenderContext): string {
    const existing = ctx.opt<string | undefined>("project_id");
    if (existing) return escape(String(existing));
    const body: Record<string, unknown> = { name: ctx.prefix };
    if (ctx.opt("resource_group_id")) body.resource_group_id = escape(String(ctx.opt("resource_group_id")));
    return ref(doc.resource("ibm_code_engine_project", "project", body), "project_id");
  }

  private codeReference(doc: TerraformDoc, ctx: RenderContext): { code_reference: string; code_binary: boolean; code_secret?: string } {
    const custom = ctx.opt<string | undefined>("code_reference");
    if (custom) {
      const out: { code_reference: string; code_binary: boolean; code_secret?: string } = {
        code_reference: escape(String(custom)),
        code_binary: true,
      };
      if (ctx.opt("code_secret")) out.code_secret = escape(String(ctx.opt("code_secret")));
      return out;
    }
    const length = DATA_URL_PREFIX.length + Math.ceil(ctx.artifact.size / 3) * 4;
    if (length > MAX_CODE_REFERENCE) {
      doc.warnings.push(
        `artifact.zip is ${(ctx.artifact.size / 1024).toFixed(0)} KiB; as a base64 data URL it exceeds Code Engine's ` +
          `${MAX_CODE_REFERENCE} character code_reference limit. Set package.sourcemap: false / package.minify: true, ` +
          "or build a code bundle image and set options.code_reference.",
      );
    }
    return { code_reference: DATA_URL_PREFIX + '${filebase64("${path.module}/artifact.zip")}', code_binary: true };
  }

  renderResources(doc: TerraformDoc, ctx: RenderContext): void {
    const cfg = ctx.config;
    const project = this.project(doc, ctx);
    const code = this.codeReference(doc, ctx);
    const fnOut: Record<string, Record<string, unknown>> = {};
    let endpoint: string | null = null;
    for (const [name, fn] of ctx.functionItems()) {
      const [cpu, mem] = sizeFor(ctx.memoryOf(fn));
      const env = Object.entries(ctx.environment(name, fn))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => ({ type: "literal", name: k, value: escape(v) }));
      const { visibility, ...rest } = fn.options;
      const body: Record<string, unknown> = {
        project_id: project,
        name: ctx.physicalName(name),
        runtime: ctx.runtimeIdOf(fn),
        ...code,
        code_main: "main",
        scale_cpu_limit: cpu,
        scale_memory_limit: mem,
        scale_max_execution_time: ctx.timeoutOf(fn),
        managed_domain_mappings: String(visibility ?? ctx.opt("visibility", "local_public")),
        run_env_variables: env,
      };
      if (fn.concurrency) body.scale_concurrency = fn.concurrency;
      Object.assign(body, rest);
      const res = doc.resource(FUNCTION, name, body);
      const out: Record<string, unknown> = {
        id: ref(res, "function_id"),
        url: ref(res, "endpoint"),
        console: `https://cloud.ibm.com/codeengine/project/${ctx.region}/${project}/functions`,
      };
      if (eventsOf(fn, "http").length) {
        out.base_url = ref(res, "endpoint");
        endpoint ??= ref(res, "endpoint");
      }
      fnOut[name] = out;
    }
    const wfOut: Record<string, unknown> = {};
    for (const n of Object.keys(cfg.workflows).sort()) wfOut[n] = { id: ref(FUNCTION, tfId(`${n}-orchestrator`), "endpoint") };
    doc.output("nskit", { functions: fnOut, workflows: wfOut, endpoint }, { description: "node_serverless_kit deployment summary" });
  }
}
