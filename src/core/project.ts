/** A loaded project: config + provider + working directory, ready to build/deploy. */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { loadConfig, type LoadedConfig, type LoadOptions } from "../config/loader.js";
import {
  corsOf,
  eventsOf,
  memoryOf,
  timeoutOf,
  type EventSpec,
  type FunctionConfig,
  type HttpEvent,
  type ServiceConfig,
} from "../config/schema.js";
import { HTTP, Issue, ORCHESTRATOR_HANDLER, type Provider } from "../providers/base.js";
import { available, getProvider } from "../providers/registry.js";
import type { BundleManifest } from "../runtime/manifest.js";
import { VERSION } from "../version.js";
import { definitionData } from "../workflows/index.js";

export const WORK_DIR = ".nskit";
export const SOURCE_EXTENSIONS = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"];

export function orchestratorName(workflow: string): string {
  return `${workflow}-orchestrator`;
}

/** `src/orders.getOrder` -> `{ module: "src/orders", exportPath: ["getOrder"] }`. */
export function parseHandlerRef(ref: string): { module: string; exportPath: string[] } {
  // The module is everything up to the first "." that follows the last "/"
  // (so `lib/api.handlers.list` exports `handlers.list` from `lib/api`).
  const slash = ref.lastIndexOf("/");
  const dot = ref.indexOf(".", slash + 1);
  if (dot <= 0) throw new Error(`handler '${ref}' must be '<module path>.<export>'`);
  return { module: ref.slice(0, dot), exportPath: ref.slice(dot + 1).split(".") };
}

/** Resolve a handler module path to an existing source file, or `undefined`. */
export function resolveHandlerFile(sourceDir: string, module: string): string | undefined {
  const base = path.resolve(sourceDir, module);
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of SOURCE_EXTENSIONS) if (existsSync(base + ext)) return base + ext;
  for (const ext of SOURCE_EXTENSIONS) {
    const index = path.join(base, "index" + ext);
    if (existsSync(index)) return index;
  }
  return undefined;
}

export interface LocatedHandler {
  file: string;
  module: string;
  exportPath: string[];
}

/**
 * Find the source file for a handler reference. File names may contain dots
 * (`src/orders.service.list`), so every split point after the last `/` is
 * tried, longest module path first.
 */
export function locateHandler(sourceDir: string, ref: string): LocatedHandler | undefined {
  const slash = ref.lastIndexOf("/");
  const dots: number[] = [];
  for (let i = ref.length - 1; i > slash; i--) if (ref[i] === ".") dots.push(i);
  for (const dot of dots) {
    const module = ref.slice(0, dot);
    const file = resolveHandlerFile(sourceDir, module);
    if (file) return { file, module, exportPath: ref.slice(dot + 1).split(".") };
  }
  return undefined;
}

export type WorkflowEngines = Record<string, "native" | "embedded">;

export class Project {
  constructor(
    readonly loaded: LoadedConfig,
    readonly provider: Provider,
    readonly config: ServiceConfig,
    readonly engines: WorkflowEngines,
  ) {}

  static load(configPath?: string, options: LoadOptions = {}): Project {
    const loaded = loadConfig(configPath, { ...options, knownProviders: [...available(), ...(options.knownProviders ?? [])] });
    return Project.fromLoaded(loaded);
  }

  static fromLoaded(loaded: LoadedConfig): Project {
    const provider = getProvider(loaded.config.provider.name);
    let config = loaded.config;
    if (!config.provider.runtime) {
      // Not pinned by the user: pick what this cloud supports.
      config = { ...config, provider: { ...config.provider, runtime: provider.defaultRuntime } };
    }
    const [expanded, engines] = expand(config, provider);
    return new Project(loaded, provider, expanded, engines);
  }

  // ---------------------------------------------------------------- paths
  get root(): string {
    return this.loaded.root;
  }

  get workDir(): string {
    return path.join(this.root, WORK_DIR, `${this.config.provider.name}-${this.config.provider.stage}`);
  }

  get sourceDir(): string {
    return path.resolve(this.root, this.config.package.source);
  }

  get region(): string {
    return this.provider.region(this.config);
  }

  // ---------------------------------------------------------------- checks
  validate(): Issue[] {
    const issues = this.provider.validate(this.config);
    const source = this.sourceDir;
    if (!existsSync(source) || !statSync(source).isDirectory()) {
      issues.push(new Issue("error", `package.source ${source} is not a directory`, "package.source"));
      return issues;
    }
    for (const [name, fn] of Object.entries(this.config.functions)) {
      if (fn.handler === ORCHESTRATOR_HANDLER) continue;
      if (!locateHandler(source, fn.handler)) {
        const { module } = parseHandlerRef(fn.handler);
        issues.push(
          new Issue(
            "error",
            `handler module '${module}' not found under ${source} (tried ${SOURCE_EXTENSIONS.join(", ")} and index files)`,
            `functions.${name}.handler`,
          ),
        );
      }
    }
    return issues;
  }

  // ---------------------------------------------------------------- bundle manifest
  bundleManifest(): BundleManifest {
    const functions: BundleManifest["functions"] = {};
    for (const [name, fn] of Object.entries(this.config.functions).sort(([a], [b]) => a.localeCompare(b))) {
      functions[name] = {
        handler: fn.handler,
        routes: eventsOf(fn, "http").map((ev) => {
          const cors = corsOf(ev);
          return { method: ev.method, path: ev.path, cors: cors ?? null };
        }),
        timeout: timeoutOf(this.config, fn),
        memory: memoryOf(this.config, fn),
        resourceName: this.provider.physicalName(this.config.service, this.config.provider.stage, name),
      };
    }
    const workflows: BundleManifest["workflows"] = {};
    for (const [name, wf] of Object.entries(this.config.workflows).sort(([a], [b]) => a.localeCompare(b))) {
      if (this.engines[name] === "embedded") {
        workflows[name] = { orchestrator: orchestratorName(name), definition: definitionData(wf) };
      }
    }
    return {
      service: this.config.service,
      stage: this.config.provider.stage,
      provider: this.config.provider.name,
      region: this.region,
      version: VERSION,
      functions,
      workflows,
    };
  }
}

/** Add generated functions (embedded workflow orchestrators) to the config. */
export function expand(config: ServiceConfig, provider: Provider): [ServiceConfig, WorkflowEngines] {
  const engines: WorkflowEngines = {};
  const functions: Record<string, FunctionConfig> = { ...config.functions };
  let changed = false;
  for (const [name, wf] of Object.entries(config.workflows)) {
    let engine: "native" | "embedded";
    try {
      engine = provider.workflowEngine(wf);
    } catch {
      engine = "embedded"; // reported properly by Provider.validate
    }
    engines[name] = engine;
    if (engine !== "embedded") continue;
    const orch = orchestratorName(name);
    if (orch in functions) continue;
    const events: EventSpec[] = [];
    if (provider.capabilities.has(HTTP) && wf.options.http !== false) {
      const http: HttpEvent = {
        method: "POST",
        path: `/workflows/${name}`,
        cors: false,
        auth: "none",
        authorizer: {},
      };
      events.push({ type: "http", config: http });
    }
    functions[orch] = {
      handler: ORCHESTRATOR_HANDLER,
      description: `Embedded orchestrator for workflow ${name}`,
      timeout: Math.min(wf.timeout ?? provider.maxTimeout, provider.maxTimeout),
      environment: {},
      tags: { "nskit-workflow": name },
      events,
      iam: { statements: [] },
      options: {},
    };
    changed = true;
  }
  return [changed ? { ...config, functions } : config, engines];
}
