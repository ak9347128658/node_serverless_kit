/**
 * Run functions and workflows locally - from tests, `nskit invoke`, `nskit dev`
 * and `nskit workflow run`.
 *
 * Two loading modes:
 *
 * - `bundle` (CLI default): the project is bundled with esbuild exactly like a
 *   deployment and the bundle's own copy of the runtime is used.
 * - `import`: handler modules are loaded with `import()` in the current
 *   process. Use this from Vitest/Jest so mocks (`vi.mock`) apply; under plain
 *   Node it works for JavaScript projects.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LoadOptions } from "../config/loader.js";
import type { ServiceConfig } from "../config/schema.js";
import { runtimeSpecifier } from "../core/paths.js";
import { locateHandler, Project } from "../core/project.js";
import { bundleEntry, entrySource } from "../packaging/builder.js";
import { ORCHESTRATOR_HANDLER } from "../providers/base.js";
import * as localRuntime from "../runtime/adapters/local.js";
import type { BundleManifest, HandlerTable } from "../runtime/manifest.js";
import { definitionData } from "../workflows/index.js";

export type RuntimeApi = typeof localRuntime;

export interface LocalRunnerOptions extends LoadOptions {
  /** How handler modules are loaded. Default: `import`. */
  mode?: "import" | "bundle";
  /** Extra environment variables for every invocation. */
  env?: Record<string, string>;
  /** Replace workflow `wait` sleeping (default: no real waiting). */
  sleep?: (seconds: number) => Promise<void>;
}

export interface HttpCallOptions {
  headers?: Record<string, string>;
  query?: Record<string, string>;
  /** Raw body (string or bytes). */
  body?: string | Uint8Array;
  /** JSON body; sets content-type. */
  json?: unknown;
  sourceIp?: string;
}

export interface LocalHttpResponse {
  status: number;
  headers: Record<string, string>;
  cookies: string[];
  body: Uint8Array;
  /** Body decoded as UTF-8. */
  text: string;
  /** Body parsed as JSON (throws if it is not JSON). */
  json<T = unknown>(): T;
  /** The function that served the request. */
  functionName?: string;
}

export interface WorkflowRunResult {
  output: unknown;
  history: { ts: string; state: string; type: string; event: string; [k: string]: unknown }[];
}

export interface RouteMatch {
  functionName: string;
  method: string;
  path: string;
}

function decoder(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export class LocalRunner {
  private runtime?: RuntimeApi;
  private readonly sleep: (seconds: number) => Promise<void>;

  private constructor(
    readonly project: Project,
    private readonly mode: "import" | "bundle",
    private readonly env: Record<string, string>,
    sleep?: (seconds: number) => Promise<void>,
  ) {
    this.sleep = sleep ?? (async () => undefined);
  }

  /** Load `nskit.yml` (or the given file) and prepare a runner. */
  static async fromConfig(configPath?: string, options: LocalRunnerOptions = {}): Promise<LocalRunner> {
    const project = Project.load(configPath, options);
    const runner = new LocalRunner(project, options.mode ?? "import", { ...(options.env ?? {}) }, options.sleep);
    await runner.reload();
    return runner;
  }

  get config(): ServiceConfig {
    return this.project.config;
  }

  get api(): RuntimeApi {
    if (!this.runtime) throw new Error("LocalRunner is not loaded; call reload()");
    return this.runtime;
  }

  /** The manifest used locally (provider `local`, every workflow embedded). */
  manifest(): BundleManifest {
    const manifest = this.project.bundleManifest();
    const workflows: BundleManifest["workflows"] = {};
    for (const [name, wf] of Object.entries(this.config.workflows)) {
      workflows[name] = { orchestrator: `${name}-orchestrator`, definition: definitionData(wf) };
    }
    return { ...manifest, provider: "local", workflows };
  }

  /** (Re)load handler code - call after source changes. */
  async reload(): Promise<void> {
    this.applyBaseEnv();
    const manifest = this.manifest();
    if (this.mode === "bundle") {
      this.runtime = await this.loadBundle(manifest);
    } else {
      this.runtime = localRuntime;
      this.runtime.installBundle({ manifest, handlers: this.importHandlers(manifest) });
    }
  }

  /** A Context with the function's configured memory and a deadline from its timeout, like in the cloud. */
  private context(name: string): InstanceType<RuntimeApi["Context"]> {
    const spec = this.api.getManifest().functions[name];
    const timeoutMs = (spec?.timeout ?? this.config.provider.timeout) * 1000;
    return new this.api.Context({
      functionName: name,
      provider: "local",
      memoryMb: spec?.memory ?? this.config.provider.memory,
      deadline: Date.now() + timeoutMs,
    });
  }

  /** Replace the extra environment variables (e.g. after `.env` changed); applied on the next call. */
  setEnv(values: Record<string, string>): void {
    for (const key of Object.keys(this.env)) delete process.env[key];
    for (const key of Object.keys(this.env)) delete this.env[key];
    Object.assign(this.env, values);
    this.applyBaseEnv();
  }

  private applyBaseEnv(): void {
    this.restoreFunctionEnv();
    const cfg = this.config;
    Object.assign(process.env, {
      NSKIT_PROVIDER: "local",
      NSKIT_SERVICE: cfg.service,
      NSKIT_STAGE: cfg.provider.stage,
      NSKIT_REGION: this.project.region,
      ...cfg.provider.environment,
      ...this.env,
    });
    delete process.env.NSKIT_FUNCTION;
    delete process.env.NSKIT_HANDLER;
  }

  private importHandlers(manifest: BundleManifest): HandlerTable {
    const table: HandlerTable = {};
    for (const spec of Object.values(manifest.functions)) {
      const ref = spec.handler;
      if (ref === ORCHESTRATOR_HANDLER) {
        table[ref] = () => import("../runtime/workflow.js").then((m) => m.orchestrate);
        continue;
      }
      const located = locateHandler(this.project.sourceDir, ref);
      if (!located) continue; // reported by resolveHandler at call time
      table[ref] = async () => {
        const mod = (await import(pathToFileURL(located.file).href)) as Record<string, unknown>;
        let value: unknown = mod;
        for (const key of located.exportPath) {
          value = (value as Record<string, unknown> | undefined)?.[key];
          // CJS modules imported from ESM expose named exports on `default`.
          if (value === undefined && key === located.exportPath[0]) value = (mod.default as Record<string, unknown>)?.[key];
        }
        return value;
      };
    }
    return table;
  }

  private async loadBundle(manifest: BundleManifest): Promise<RuntimeApi> {
    const dir = path.join(this.project.root, ".nskit", "local");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "nskit_manifest.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(path.join(dir, "package.json"), '{"type":"commonjs"}\n');
    const glue = `export * from ${JSON.stringify(runtimeSpecifier("adapters/local"))};`;
    const entry = path.join(dir, "nskit-entry.ts");
    writeFileSync(entry, entrySource(this.project, { entryDir: dir, manifest, glue }));
    const outFile = path.join(dir, "bundle.cjs");
    await bundleEntry(this.project, entry, outFile, { format: "cjs", platform: "node", entryFile: "bundle.cjs" }, `node${process.versions.node.split(".")[0]}`);
    const req = createRequire(outFile);
    delete req.cache[outFile];
    return req(outFile) as RuntimeApi;
  }

  /** Values the current function's environment replaced, restored before the next function runs. */
  private fnEnvBackup: Record<string, string | undefined> = {};

  private restoreFunctionEnv(): void {
    for (const [key, value] of Object.entries(this.fnEnvBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    this.fnEnvBackup = {};
  }

  private withFunctionEnv(name: string): void {
    const fn = this.config.functions[name];
    if (!fn) throw new Error(`unknown function '${name}'; known: ${Object.keys(this.config.functions).sort().join(", ")}`);
    // Like separate cloud functions, one function's environment must not leak into the next one's.
    this.restoreFunctionEnv();
    const vars: Record<string, string> = { ...fn.environment, NSKIT_FUNCTION: name, NSKIT_HANDLER: fn.handler };
    for (const key of Object.keys(vars)) this.fnEnvBackup[key] = process.env[key];
    Object.assign(process.env, vars);
  }

  // ---------------------------------------------------------------- HTTP

  /** Every HTTP route of the service, sorted so static segments win. */
  routes(): RouteMatch[] {
    const routes: RouteMatch[] = [];
    for (const [name, spec] of Object.entries(this.api.getManifest().functions)) {
      for (const r of spec.routes ?? []) routes.push({ functionName: name, method: r.method, path: r.path });
    }
    const score = (p: string) => p.split("/").map((s) => (s.startsWith("{") ? (s.endsWith("+}") ? 2 : 1) : 0));
    return routes.sort((a, b) => {
      const sa = score(a.path);
      const sb = score(b.path);
      for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
        const d = (sa[i] ?? -1) - (sb[i] ?? -1);
        if (d) return d;
      }
      return a.path.localeCompare(b.path);
    });
  }

  /** Find the function serving `method path` (exact path match, like an API gateway). */
  matchRoute(method: string, urlPath: string): { route?: RouteMatch; pathMatched: boolean } {
    let pathMatched = false;
    for (const route of this.routes()) {
      if (this.api.matchPath(route.path, urlPath, false) === null) continue;
      pathMatched = true;
      if (this.api.methodMatches(route.method, method) || method.toUpperCase() === "OPTIONS") return { route, pathMatched };
    }
    return { pathMatched };
  }

  /** Send an HTTP request to the service, routed like the API gateway would. */
  async http(method: string, url: string, options: HttpCallOptions = {}): Promise<LocalHttpResponse> {
    const parsed = new URL(url, "http://localhost");
    const query: Record<string, string> = { ...Object.fromEntries(parsed.searchParams), ...(options.query ?? {}) };
    const multiQuery: Record<string, string[]> = {};
    for (const [k, v] of parsed.searchParams) (multiQuery[k] ??= []).push(v);
    for (const [k, v] of Object.entries(options.query ?? {})) multiQuery[k] = [v];
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    let body = options.body;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
    }
    const { route, pathMatched } = this.matchRoute(method, parsed.pathname);
    if (!route) {
      const status = pathMatched ? 405 : 404;
      const payload = JSON.stringify({ error: pathMatched ? "Method Not Allowed" : "Not Found", status });
      return this.toLocal(new this.api.HttpResponse(status, payload, { "content-type": "application/json" }));
    }
    this.withFunctionEnv(route.functionName);
    const request = new this.api.HttpRequest({
      method,
      path: parsed.pathname,
      headers,
      query,
      multiQuery,
      body: body ?? undefined,
      sourceIp: options.sourceIp ?? "127.0.0.1",
    });
    const event = new this.api.Event({ type: "http", provider: "local", functionName: route.functionName, http: request });
    const context = this.context(route.functionName);
    const resp = (await this.api.execute(event, context, route.functionName)) as InstanceType<RuntimeApi["HttpResponse"]>;
    return { ...this.toLocal(resp), functionName: route.functionName };
  }

  private toLocal(resp: InstanceType<RuntimeApi["HttpResponse"]>): LocalHttpResponse {
    const rendered = resp.render();
    const text = decoder(rendered.body);
    return {
      status: rendered.status,
      headers: rendered.headers,
      cookies: [...resp.cookies],
      body: rendered.body,
      text,
      json: <T>() => JSON.parse(text) as T,
    };
  }

  // ---------------------------------------------------------------- other events

  private async run(name: string, init: ConstructorParameters<RuntimeApi["Event"]>[0]): Promise<unknown> {
    this.withFunctionEnv(name);
    const event = new this.api.Event({ provider: "local", functionName: name, ...init });
    return this.api.execute(event, this.context(name), name);
  }

  /** Direct invocation, like `invoke()` from another function. */
  invoke<T = unknown>(name: string, data?: unknown): Promise<T> {
    return this.run(name, { type: "invoke", data: data ?? null }) as Promise<T>;
  }

  /** Scheduled invocation with the schedule's `input`. */
  schedule<T = unknown>(name: string, input?: unknown): Promise<T> {
    return this.run(name, { type: "schedule", data: input ?? null, source: "local.scheduler" }) as Promise<T>;
  }

  /** Queue batch. Messages may be strings, objects (JSON-encoded) or `{id, body, attributes}`. */
  queue<T = unknown>(name: string, messages: unknown[]): Promise<T> {
    return this.run(name, { type: "queue", records: this.records(messages, "queue"), source: "local:queue" }) as Promise<T>;
  }

  /** Topic (pub/sub) delivery. */
  topic<T = unknown>(name: string, messages: unknown[]): Promise<T> {
    return this.run(name, { type: "topic", records: this.records(messages, "topic"), source: "local:topic" }) as Promise<T>;
  }

  /** Storage notification(s). */
  storage<T = unknown>(
    name: string,
    objects: { bucket?: string; key: string; size?: number; action?: "created" | "deleted" }[],
  ): Promise<T> {
    const records = objects.map(
      (o, i) =>
        new this.api.EventRecord({
          id: String(i + 1),
          bucket: o.bucket ?? "local-bucket",
          key: o.key,
          size: o.size ?? 0,
          action: o.action ?? "created",
          source: "local:storage",
        }),
    );
    return this.run(name, { type: "storage", records, source: "local:storage" }) as Promise<T>;
  }

  private records(messages: unknown[], kind: string) {
    return messages.map((m, i) => {
      if (m && typeof m === "object" && "body" in (m as object)) {
        const r = m as { id?: string; body: unknown; attributes?: Record<string, unknown> };
        return new this.api.EventRecord({ id: r.id ?? String(i + 1), body: typeof r.body === "string" ? r.body : JSON.stringify(r.body), attributes: r.attributes, source: `local:${kind}` });
      }
      return new this.api.EventRecord({ id: String(i + 1), body: typeof m === "string" ? m : JSON.stringify(m), source: `local:${kind}` });
    });
  }

  // ---------------------------------------------------------------- workflows

  /** Run a workflow with the embedded engine; task functions run in-process. */
  async workflow(name: string, input?: unknown): Promise<WorkflowRunResult> {
    const spec = this.api.getManifest().workflows[name];
    if (!spec) throw new Error(`unknown workflow '${name}'; known: ${Object.keys(this.config.workflows).sort().join(", ")}`);
    const taskRunner = (fn: string, data: unknown) => {
      this.withFunctionEnv(fn);
      return this.api.inProcessRunner("local")(fn, data);
    };
    const engine = new this.api.WorkflowEngine(spec.definition, taskRunner, { sleep: this.sleep });
    const output = await engine.run(input ?? null);
    return { output, history: engine.history };
  }
}
