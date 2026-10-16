/**
 * Provider plug-in contract.
 *
 * A provider turns a validated {@link ServiceConfig} plus a built artifact into
 * a {@link TerraformDoc}, and tells the bundler how the platform loads code:
 * the module format, the entry file name and the small piece of glue code
 * that forwards the platform's native entrypoint to
 * `src/runtime/adapters/<provider>.ts`.
 *
 * Adding a new cloud = subclass {@link Provider}, write an adapter module and
 * register it in `providers/registry.ts`. See deploy_docs/CONTRIBUTING.md.
 */

import { createHash } from "node:crypto";
import {
  architectureOf,
  memoryOf,
  PREFERRED_RUNTIME,
  runtimeOf,
  timeoutOf,
  type FunctionConfig,
  type ServiceConfig,
  type WorkflowConfig,
} from "../config/schema.js";
import type { BundleManifest } from "../runtime/manifest.js";
import { TerraformDoc } from "./terraform-doc.js";

// Capability flags ------------------------------------------------------------
export const HTTP = "http";
export const SCHEDULE = "schedule";
export const QUEUE = "queue";
export const STORAGE = "storage";
export const TOPIC = "topic";
export const WORKFLOW_NATIVE = "workflow_native";
export type Capability = typeof HTTP | typeof SCHEDULE | typeof QUEUE | typeof STORAGE | typeof TOPIC | typeof WORKFLOW_NATIVE;
export const EVENT_CAPABILITIES: ReadonlySet<Capability> = new Set([HTTP, SCHEDULE, QUEUE, STORAGE, TOPIC]);

export { ORCHESTRATOR_HANDLER } from "../runtime/workflow.js";

export type Tier = "stable" | "beta" | "experimental";

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface Artifact {
  /** Absolute path of `artifact.zip`. */
  path: string;
  sha256: string;
  sha256Base64: string;
  size: number;
  fileCount: number;
  /** Absolute path of the unzipped build directory (entry file, manifest, node_modules, ...). */
  buildDir: string;
  /** Entry file name inside the build dir, e.g. `index.js`. */
  entryFile: string;
}

export class Issue {
  constructor(
    readonly level: "error" | "warning",
    readonly message: string,
    readonly where = "",
  ) {}

  toString(): string {
    return `${this.level.toUpperCase()}: ${this.where ? `[${this.where}] ` : ""}${this.message}`;
  }
}

/** How the bundler should build the deployment entry for this provider. */
export interface BundleTarget {
  /** Module format the platform loads. */
  format: "cjs" | "esm";
  /** esbuild platform: `node` for Node.js runtimes, `neutral`/`browser` for V8 isolates. */
  platform: "node" | "neutral" | "browser";
  /** Output entry file name at the artifact root, e.g. `index.js` or `worker.mjs`. */
  entryFile: string;
  /** Extra esbuild resolve conditions (e.g. `workerd` for Cloudflare). */
  conditions?: string[];
  /** Module names left out of the bundle because the platform provides them (e.g. `@aws-sdk/*` on Lambda). */
  external?: string[];
  /** Node built-ins prefix handling etc. are esbuild defaults; extra raw options may be added here. */
  esbuild?: Record<string, unknown>;
}

export interface EntryContext {
  config: ServiceConfig;
  manifest: BundleManifest;
  /** Import specifier for a runtime module, e.g. `runtime("adapters/aws")`. */
  runtime(module: string): string;
}

export interface RenderContextInit {
  config: ServiceConfig;
  provider: Provider;
  root: string;
  workDir: string;
  artifact: Artifact;
  region: string;
  workflowEngines?: Record<string, "native" | "embedded">;
}

export class RenderContext {
  readonly config: ServiceConfig;
  readonly provider: Provider;
  readonly root: string;
  readonly workDir: string;
  readonly artifact: Artifact;
  readonly region: string;
  readonly workflowEngines: Record<string, "native" | "embedded">;

  constructor(init: RenderContextInit) {
    this.config = init.config;
    this.provider = init.provider;
    this.root = init.root;
    this.workDir = init.workDir;
    this.artifact = init.artifact;
    this.region = init.region;
    this.workflowEngines = init.workflowEngines ?? {};
  }

  get service(): string {
    return this.config.service;
  }

  get stage(): string {
    return this.config.provider.stage;
  }

  get options(): Record<string, unknown> {
    return this.config.provider.options;
  }

  opt<T = unknown>(key: string, fallback?: T): T {
    const v = this.config.provider.options[key];
    return (v === undefined || v === null ? fallback : v) as T;
  }

  physicalName(logical: string): string {
    return this.provider.physicalName(this.service, this.stage, logical);
  }

  get prefix(): string {
    return this.provider.physicalName(this.service, this.stage, "");
  }

  tags(fn?: FunctionConfig): Record<string, string> {
    return {
      "nskit-service": this.service,
      "nskit-stage": this.stage,
      "managed-by": "node-serverless-kit",
      ...this.config.provider.tags,
      ...(fn?.tags ?? {}),
    };
  }

  /** Environment for one function: NSKIT_* variables, provider-wide values, then the function's own. */
  environment(name: string, fn: FunctionConfig): Record<string, string> {
    const env: Record<string, string> = {
      NSKIT_PROVIDER: this.provider.name,
      NSKIT_SERVICE: this.service,
      NSKIT_STAGE: this.stage,
      NSKIT_REGION: this.region,
      NSKIT_FUNCTION: name,
      NSKIT_HANDLER: fn.handler,
    };
    if (this.config.package.sourcemap && this.provider.bundle.platform === "node") {
      env.NODE_OPTIONS = "--enable-source-maps";
    }
    return { ...env, ...this.config.provider.environment, ...fn.environment };
  }

  functionItems(): [string, FunctionConfig][] {
    return Object.entries(this.config.functions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  memoryOf(fn: FunctionConfig): number {
    return memoryOf(this.config, fn);
  }

  timeoutOf(fn: FunctionConfig): number {
    return timeoutOf(this.config, fn);
  }

  runtimeOf(fn: FunctionConfig): string {
    return runtimeOf(this.config, fn);
  }

  architectureOf(fn: FunctionConfig): "x86_64" | "arm64" {
    return architectureOf(this.config, fn);
  }

  /** Provider runtime id for a function, e.g. `nodejs22.x` on AWS. */
  runtimeIdOf(fn: FunctionConfig): string {
    return this.provider.runtimeId(this.runtimeOf(fn));
  }
}

/** Short, stable hash used for naming only (not security). */
export function stableSuffix(parts: string[], length = 6): string {
  return createHash("sha1").update(parts.join("/")).digest("hex").slice(0, length);
}

function runtimeMajor(rt: string): number {
  return Number(rt.replace(/\D/g, "")) || 0;
}

export abstract class Provider {
  abstract readonly name: string;
  abstract readonly displayName: string;
  readonly tier: Tier = "beta";
  abstract readonly terraformSource: string;
  readonly terraformVersion?: string;
  readonly terraformLocalName?: string;
  readonly defaultRegion: string = "";
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([HTTP]);
  readonly maxNameLength: number = 64;
  /** Characters replaced by `-` in physical names. */
  readonly namePattern: RegExp = /[^a-z0-9-]/g;
  /** Canonical runtime (`nodejs22`) -> provider runtime id (`nodejs22.x`). Empty = accept any. */
  readonly runtimes: Record<string, string> = {};
  readonly maxTimeout: number = 900;
  readonly notes: string = "";
  /** How the deployment entry is bundled. */
  readonly bundle: BundleTarget = { format: "cjs", platform: "node", entryFile: "index.js" };
  /** npm packages installed into the artifact's node_modules (e.g. `@azure/functions`). */
  readonly dependencies: Record<string, string> = {};
  /**
   * True when the platform installs `package.json` dependencies itself during a
   * remote build (GCP Cloud Build); the bundler then only writes package.json.
   */
  readonly remoteInstall: boolean = false;

  // ------------------------------------------------------------ naming
  physicalName(service: string, stage: string, logical: string): string {
    const raw = [service, stage, logical].filter(Boolean).join("-");
    const pattern = new RegExp(this.namePattern.source, "g");
    let name = raw.toLowerCase().replace(pattern, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
    if (name.length > this.maxNameLength) {
      const digest = stableSuffix([raw]);
      name = name.slice(0, this.maxNameLength - digest.length - 1).replace(/-+$/, "") + "-" + digest;
    }
    return name;
  }

  /**
   * Runtime used when the config does not pin one: nodejs22, or the newest
   * version this provider supports below it (so switching clouds just works).
   */
  get defaultRuntime(): string {
    const supported = Object.keys(this.runtimes);
    if (!supported.length || supported.includes(PREFERRED_RUNTIME)) return PREFERRED_RUNTIME;
    const preferred = runtimeMajor(PREFERRED_RUNTIME);
    const older = supported.filter((rt) => runtimeMajor(rt) <= preferred);
    const pool = older.length ? older : supported;
    return pool.reduce((best, rt) => (runtimeMajor(rt) > runtimeMajor(best) ? rt : best));
  }

  runtimeId(runtime: string): string {
    const supported = Object.keys(this.runtimes);
    if (supported.length && !(runtime in this.runtimes)) {
      throw new ProviderError(`${this.displayName} does not support ${runtime}; use one of: ${supported.sort().join(", ")}`);
    }
    return this.runtimes[runtime] ?? runtime;
  }

  /** esbuild target for a canonical runtime, e.g. `node22`. */
  esbuildTarget(runtime: string): string {
    return `node${runtimeMajor(runtime) || 20}`;
  }

  region(config: ServiceConfig): string {
    return config.provider.region || this.defaultRegion;
  }

  // ------------------------------------------------------------ validation
  workflowEngine(wf: WorkflowConfig): "native" | "embedded" {
    if (wf.engine === "native") {
      if (!this.capabilities.has(WORKFLOW_NATIVE)) {
        throw new ProviderError(
          `${this.displayName} has no native workflow service supported by nskit; use \`engine: embedded\` or \`auto\``,
        );
      }
      return "native";
    }
    if (wf.engine === "embedded") return "embedded";
    return this.capabilities.has(WORKFLOW_NATIVE) ? "native" : "embedded";
  }

  validate(config: ServiceConfig): Issue[] {
    const issues: Issue[] = [];
    try {
      this.runtimeId(config.provider.runtime);
    } catch (err) {
      issues.push(new Issue("error", (err as Error).message, "provider.runtime"));
    }
    const supportedEvents = [...this.capabilities].filter((c) => EVENT_CAPABILITIES.has(c)).sort();
    for (const [name, fn] of Object.entries(config.functions)) {
      const where = `functions.${name}`;
      if (fn.runtime) {
        try {
          this.runtimeId(fn.runtime);
        } catch (err) {
          issues.push(new Issue("error", (err as Error).message, `${where}.runtime`));
        }
      }
      for (const ev of fn.events) {
        if (!this.capabilities.has(ev.type)) {
          issues.push(
            new Issue(
              "error",
              `${this.displayName} does not support \`${ev.type}\` events in nskit (supported: ${supportedEvents.join(", ")})`,
              where,
            ),
          );
        }
      }
      const timeout = timeoutOf(config, fn);
      if (timeout > this.maxTimeout) {
        issues.push(new Issue("error", `timeout ${timeout}s exceeds ${this.displayName} max ${this.maxTimeout}s`, where));
      }
    }
    for (const [name, wf] of Object.entries(config.workflows)) {
      let engine: string;
      try {
        engine = this.workflowEngine(wf);
      } catch (err) {
        issues.push(new Issue("error", (err as Error).message, `workflows.${name}`));
        continue;
      }
      if (engine === "embedded") {
        issues.push(
          new Issue(
            "warning",
            "runs on the embedded engine inside one function: total runtime is capped by the " +
              `function timeout (${this.maxTimeout}s max on ${this.displayName})`,
            `workflows.${name}`,
          ),
        );
      }
    }
    issues.push(...this.extraValidation(config));
    return issues;
  }

  extraValidation(_config: ServiceConfig): Issue[] {
    return [];
  }

  // ------------------------------------------------------------ terraform
  initDoc(ctx: RenderContext): TerraformDoc {
    const doc = new TerraformDoc();
    const tf = ctx.config.provider.terraform;
    doc.requiredVersion(tf.requiredVersion);
    const local = this.terraformLocalName ?? this.name;
    doc.requiredProvider(local, this.terraformSource, tf.providerVersion ?? this.terraformVersion);
    const state = ctx.config.provider.state;
    if (state.backend) doc.backend(state.backend, state.config);
    const block = this.providerBlock(ctx);
    if (block) doc.provider(local, block);
    return doc;
  }

  providerBlock(ctx: RenderContext): Record<string, unknown> | undefined {
    return ctx.region ? { region: ctx.region } : {};
  }

  render(ctx: RenderContext): TerraformDoc {
    const doc = this.initDoc(ctx);
    this.renderResources(doc, ctx);
    const extra = ctx.config.provider.terraform.extra;
    if (Object.keys(extra).length) doc.merge(extra);
    return doc;
  }

  /**
   * Add every resource for functions, triggers and workflows to `doc`.
   *
   * Must emit an output named `nskit` shaped like
   * `{functions: {<name>: {id, arn?, url?, base_url?, console?}}, workflows: {...}, endpoint}`.
   */
  abstract renderResources(doc: TerraformDoc, ctx: RenderContext): void;

  // ------------------------------------------------------------ bundle
  /** Bundle settings for this config (override to vary by options). */
  bundleTarget(_config: ServiceConfig): BundleTarget {
    return this.bundle;
  }

  /**
   * Source appended to the generated entry module. It must export whatever the
   * platform calls (e.g. `export { handler } from "<adapter>"`).
   */
  abstract entryCode(ctx: EntryContext): string;

  /** Extra files written at the artifact root (host.json, package.json, Dockerfile, ...). */
  extraFiles(_config: ServiceConfig, _manifest: BundleManifest): Record<string, string> {
    return {};
  }

  describe(): Record<string, unknown> {
    return {
      name: this.name,
      displayName: this.displayName,
      tier: this.tier,
      defaultRegion: this.defaultRegion,
      capabilities: [...this.capabilities].sort(),
      runtimes: Object.keys(this.runtimes).sort(),
      maxTimeout: this.maxTimeout,
      terraformProvider: this.terraformSource,
      bundle: `${this.bundle.format}/${this.bundle.platform}`,
      notes: this.notes,
    };
  }
}
