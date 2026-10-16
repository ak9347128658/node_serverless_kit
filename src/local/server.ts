/**
 * `nskit dev` - a local HTTP server that routes requests to your handlers.
 *
 * - Every `http` event in the config becomes a route (`{id}` / `{path+}`),
 *   dispatched through {@link LocalRunner} - the same dispatcher as in the
 *   cloud (routing, CORS preflight, 405, error mapping).
 * - `POST /__nskit/invoke/<function>?type=invoke|schedule|queue|topic|storage`
 *   invokes any function with the JSON body.
 * - `POST /__nskit/workflows/<workflow>` runs a workflow on the embedded engine.
 * - `GET /__nskit/` shows the dashboard for the project (local view);
 *   `GET /__nskit/routes` lists the routes as JSON.
 * - Hot reload: `package.source` is watched and the bundle is rebuilt on change.
 */

import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { eventsOf } from "../config/schema.js";
import { localRecord, renderHtml } from "../dashboard/generator.js";
import type { LocalRunner, RouteMatch } from "./runner.js";

// ------------------------------------------------------------------ .env

/** Parse a dotenv file: `KEY=value`, `export KEY="value"`, `# comments`. Missing file -> `{}`. */
export function loadDotenv(file: string): Record<string, string> {
  if (!file || !existsSync(file)) return {};
  return parseDotenv(readFileSync(file, "utf-8"));
}

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"');
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

// ------------------------------------------------------------------ invoking

export const INVOKE_TYPES = ["invoke", "schedule", "queue", "topic", "storage"] as const;
export type InvokeType = (typeof INVOKE_TYPES)[number];

export class UnknownTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownTargetError";
  }
}

/**
 * Run a non-HTTP event through the runner. `data` is the payload (`event.data`
 * for invoke/schedule, the message list for queue/topic, object descriptor(s)
 * for storage).
 */
export async function invokeEvent(runner: LocalRunner, fn: string, type: string, data: unknown): Promise<unknown> {
  const spec = runner.config.functions[fn];
  if (!spec) {
    throw new UnknownTargetError(`unknown function '${fn}'; known: ${Object.keys(runner.config.functions).sort().join(", ")}`);
  }
  const list = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
  switch (type) {
    case "invoke":
      return runner.invoke(fn, data);
    case "schedule": {
      const input = data ?? eventsOf(spec, "schedule")[0]?.input ?? null;
      return runner.schedule(fn, input);
    }
    case "queue":
      return runner.queue(fn, list(data));
    case "topic":
      return runner.topic(fn, list(data));
    case "storage": {
      const objects = list(data ?? { key: "example.txt" }).map((o) =>
        typeof o === "string" ? { key: o } : (o as { bucket?: string; key: string; size?: number; action?: "created" | "deleted" }),
      );
      return runner.storage(fn, objects);
    }
    default:
      throw new UnknownTargetError(`unsupported event type '${type}'; use one of invoke, schedule, queue, topic, storage`);
  }
}

/** Make a handler result JSON friendly (HttpResponse -> {status, headers, body}, BatchResult -> batchItemFailures). */
export function toPlain(runner: LocalRunner, result: unknown): unknown {
  const api = runner.api;
  if (api.isHttpResponse(result)) {
    const rendered = result.render();
    return { status: rendered.status, headers: rendered.headers, body: decodeBody(rendered.headers["content-type"], rendered.body) };
  }
  if (api.isBatchResult(result)) {
    return { batchItemFailures: result.failed.map((id) => ({ itemIdentifier: id })) };
  }
  if (result instanceof Uint8Array) return new TextDecoder().decode(result);
  return result === undefined ? null : result;
}

export function decodeBody(contentType: string | undefined, body: Uint8Array): unknown {
  const text = new TextDecoder().decode(body);
  if ((contentType ?? "").toLowerCase().includes("json") && text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function errorName(err: unknown): string {
  const name = err && typeof err === "object" ? (err as { name?: unknown }).name : undefined;
  return typeof name === "string" && name ? name : "Error";
}

/** `WorkflowFailed` from the bundle's own copy of the runtime (so no `instanceof`). */
export function isWorkflowFailed(err: unknown): err is { error: string; cause: string; history: unknown[]; message: string } {
  return Boolean(err && typeof err === "object" && (err as { name?: string }).name === "WorkflowFailed" && "error" in err);
}

// ------------------------------------------------------------------ server

export interface DevServerOptions {
  host?: string;
  /** 0 picks a free port. Default 3000. */
  port?: number;
  /** Watch `package.source` and reload on change. Default true. */
  watch?: boolean;
  /** Debounce for file events, ms. Default 150. */
  debounceMs?: number;
  /** `.env` file re-read on every reload (values are applied to `process.env`). */
  envFile?: string;
  /** Log sink; default `console.log`. */
  log?: (message: string) => void;
}

export interface DevServer {
  server: Server;
  url: string;
  runner: LocalRunner;
  /** Rebuild the bundle now (what the watcher calls). */
  reload(): Promise<void>;
  /** Number of completed reloads. */
  readonly reloads: number;
  close(): Promise<void>;
}

const IGNORED_DIRS = new Set(["node_modules", ".nskit", ".git", "dist", "coverage", ".turbo", ".cache"]);

/** True when a watched path (relative to the source dir) should trigger a reload. */
export function isWatchedFile(relative: string): boolean {
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return false;
  // Dot files/dirs and build output are ignored; `.env*` at the root is watched.
  if (parts.some((p) => IGNORED_DIRS.has(p) || p.startsWith("."))) return parts.length === 1 && /^\.env/.test(parts[0]);
  const base = parts[parts.length - 1];
  if (/~$|\.swp$|\.tmp$|^#/.test(base)) return false;
  return true;
}

/** A serial lock: handlers share `process.env`, so invocations run one at a time. */
function createLock() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

function sendJson(res: ServerResponse, status: number, payload: unknown, method = "GET"): void {
  const body = Buffer.from(JSON.stringify(payload, null, 2) + "\n", "utf-8");
  res.writeHead(status, { "content-type": "application/json", "content-length": body.length });
  res.end(method === "HEAD" ? undefined : body);
}

function flattenHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers[k] = Array.isArray(v) ? (k === "cookie" ? v.join("; ") : v.join(", ")) : v;
  }
  return headers;
}

/** The startup banner: every route plus the internal endpoints. */
export function routeTable(runner: LocalRunner, base: string): string[] {
  const routes = runner.routes();
  const width = Math.max(7, ...routes.map((r) => r.method.length + 1));
  const lines = routes.map((r) => `  ${r.method.padEnd(width)} ${base}${r.path}  -> ${r.functionName}`);
  if (!routes.length) lines.push("  (no http routes)");
  lines.push(`  ${"POST".padEnd(width)} ${base}/__nskit/invoke/<function>?type=invoke|schedule|queue|topic|storage`);
  if (Object.keys(runner.config.workflows).length) lines.push(`  ${"POST".padEnd(width)} ${base}/__nskit/workflows/<workflow>`);
  lines.push(`  ${"GET".padEnd(width)} ${base}/__nskit/  (dashboard)`);
  return lines;
}

/** Start the dev server. Resolves once it is listening. */
export async function startDevServer(runner: LocalRunner, options: DevServerOptions = {}): Promise<DevServer> {
  const log = options.log ?? ((m: string) => console.log(m));
  const host = options.host ?? "127.0.0.1";
  const lock = createLock();
  let reloads = 0;
  let pendingReload: Promise<void> | undefined;

  const doReload = (): Promise<void> =>
    lock(async () => {
      const started = Date.now();
      try {
        if (options.envFile) Object.assign(process.env, loadDotenv(options.envFile));
        await runner.reload();
        if (options.envFile) Object.assign(process.env, loadDotenv(options.envFile));
        reloads++;
        log(`  reloaded in ${Date.now() - started} ms`);
      } catch (err) {
        reloads++;
        log(`  reload failed (still serving the previous build): ${(err as Error).message}`);
      }
    });

  const reload = (): Promise<void> => {
    pendingReload = doReload().finally(() => {
      pendingReload = undefined;
    });
    return pendingReload;
  };

  const handleInternal = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const parts = url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
    const method = req.method ?? "GET";
    if (!parts.length || parts[0] === "dashboard") {
      const html = renderHtml([localRecord(runner.project)], { title: `${runner.config.service} (local)` });
      const body = Buffer.from(html, "utf-8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": body.length });
      res.end(method === "HEAD" ? undefined : body);
      return;
    }
    if (parts[0] === "routes" && parts.length === 1) {
      sendJson(res, 200, runner.routes(), method);
      return;
    }
    const raw = await readBody(req);
    let data: unknown = null;
    if (raw.length) {
      const text = new TextDecoder().decode(raw);
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (parts[0] === "invoke" && parts.length === 2) {
      const type = url.searchParams.get("type") ?? "invoke";
      try {
        const result = await lock(() => invokeEvent(runner, parts[1], type, data));
        log(`  invoke ${parts[1]} (${type})`);
        sendJson(res, 200, { result: toPlain(runner, result) }, method);
      } catch (err) {
        if (err instanceof UnknownTargetError) sendJson(res, 404, { error: err.message }, method);
        else sendJson(res, 500, { errorType: errorName(err), cause: (err as Error)?.message ?? String(err) }, method);
      }
      return;
    }
    if (parts[0] === "workflows" && parts.length === 2) {
      const name = parts[1];
      if (!(name in runner.config.workflows)) {
        sendJson(res, 404, { error: `unknown workflow '${name}'; known: ${Object.keys(runner.config.workflows).sort().join(", ")}` }, method);
        return;
      }
      try {
        const out = await lock(() => runner.workflow(name, data));
        log(`  workflow ${name} SUCCEEDED`);
        sendJson(res, 200, { status: "SUCCEEDED", output: out.output, history: out.history }, method);
      } catch (err) {
        if (isWorkflowFailed(err)) {
          log(`  workflow ${name} FAILED ${err.error}`);
          sendJson(res, 500, { status: "FAILED", error: err.error, cause: err.cause, history: err.history }, method);
        } else {
          sendJson(res, 500, { status: "FAILED", error: errorName(err), cause: (err as Error)?.message ?? String(err) }, method);
        }
      }
      return;
    }
    sendJson(res, 404, { error: `unknown internal path ${url.pathname}` }, method);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (pendingReload) await pendingReload;
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/__nskit" || url.pathname.startsWith("/__nskit/")) {
      await handleInternal(req, res, url);
      return;
    }
    const { route, pathMatched } = runner.matchRoute(method, url.pathname);
    if (!route && !pathMatched) {
      sendJson(res, 404, { error: "Not Found", status: 404, routes: runner.routes().map((r: RouteMatch) => `${r.method} ${r.path}`) }, method);
      log(`  ${method} ${url.pathname} -> 404`);
      return;
    }
    const body = await readBody(req);
    const resp = await lock(() =>
      runner.http(method, url.pathname + url.search, {
        headers: flattenHeaders(req),
        body: body.length ? body : undefined,
        sourceIp: req.socket.remoteAddress ?? "127.0.0.1",
      }),
    );
    const headers: Record<string, string | string[]> = { ...resp.headers };
    if (resp.cookies.length) headers["set-cookie"] = resp.cookies;
    headers["content-length"] = String(resp.body.length);
    res.writeHead(resp.status, headers);
    res.end(method === "HEAD" ? undefined : Buffer.from(resp.body));
    log(`  ${method} ${url.pathname} -> ${resp.functionName ?? "-"} [${resp.status}]`);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`  internal error: ${(err as Error)?.stack ?? String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "Internal Server Error", status: 500, detail: (err as Error)?.message });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 3000, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : options.port;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

  // ---------------------------------------------------------------- watching
  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  const sourceDir = runner.project.sourceDir;
  const envFile = options.envFile ? path.resolve(options.envFile) : undefined;
  if (options.watch ?? true) {
    const schedule = (what: string) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        log(`  change detected (${what}), rebuilding...`);
        void reload();
      }, options.debounceMs ?? 150);
    };
    try {
      watcher = watch(sourceDir, { recursive: true }, (_event, filename) => {
        const rel = filename ? String(filename) : "";
        if (!rel || !isWatchedFile(rel)) return;
        if (envFile && path.resolve(sourceDir, rel) !== envFile && /^\.env/.test(path.basename(rel))) return;
        schedule(rel.split(path.sep).join("/"));
      });
      watcher.on("error", (err) => log(`  file watching stopped: ${err.message}`));
    } catch (err) {
      log(`  file watching unavailable (${(err as Error).message}); restart to pick up changes`);
    }
  }

  return {
    server,
    url,
    runner,
    reload,
    get reloads() {
      return reloads;
    },
    close: async () => {
      if (timer) clearTimeout(timer);
      watcher?.close();
      if (pendingReload) await pendingReload.catch(() => undefined);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
