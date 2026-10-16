/**
 * Cloudflare Workers adapter (ES module Workers, V8 isolates).
 *
 * The generated entry module does `export default createWorker({ schedules })`,
 * so the Worker exposes the three module-syntax handlers:
 *
 * - `fetch(request, env, ctx)`      -> HTTP events, or `__nskit` envelope events
 *                                      (`invoke()`, workflow tasks) posted as JSON
 * - `scheduled(controller, env, ctx)` -> schedule events; the schedule `input` is
 *                                      found by matching `controller.cron` against
 *                                      the crons configured for this function
 * - `queue(batch, env, ctx)`         -> Cloudflare Queues batches; a `BatchResult`
 *                                      (or `BatchFailure`) retries only the failed
 *                                      messages and acknowledges the rest
 *
 * Every Worker script of a service runs the same bundle; the `NSKIT_FUNCTION`
 * plain-text binding picks the function. String bindings are installed as
 * environment variables with `setEnv`, so `getEnv()` / `ctx.env` work as on
 * every other cloud. Non-string bindings (KV, R2, D1, service bindings...) are
 * available as `ctx.raw.env`.
 */

import { BatchFailure, isBatchResult } from "../batch.js";
import { Context } from "../context.js";
import { execute } from "../dispatch.js";
import { envelope } from "../envelope.js";
import { Event, EventRecord, EventType, HttpRequest, parseTime } from "../event.js";
import { isHttpResponse, type GatewayResponse } from "../response.js";
import { base64Decode, getEnv, maybeJson, setEnv, utf8Encode } from "../util.js";
import { eventFromRequest, runHttp } from "./httpfn.js";

export const PROVIDER = "cloudflare";

/** Where the current Worker `env` is kept, for code that needs non-string bindings (e.g. service bindings). */
export const ENV_KEY = Symbol.for("node-serverless-kit.cloudflare-env");

type Obj = Record<string, unknown>;

/** The subset of the Workers `ExecutionContext` the adapter uses. */
export interface ExecutionContextLike {
  waitUntil?(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export interface ScheduledControllerLike {
  cron?: string;
  scheduledTime?: number;
  noRetry?(): void;
}

export interface QueueMessageLike {
  id: string;
  timestamp?: Date | number | string;
  body: unknown;
  attempts?: number;
  ack?(): void;
  retry?(options?: { delaySeconds?: number }): void;
}

export interface MessageBatchLike {
  queue: string;
  messages: readonly QueueMessageLike[];
  ackAll?(): void;
  retryAll?(options?: { delaySeconds?: number }): void;
}

export interface WorkerOptions {
  /** `{function: {cron expression: schedule input}}`, generated from `nskit.yml`. */
  schedules?: Record<string, Record<string, unknown>>;
}

export interface WorkerModule {
  fetch(request: Request, env?: Obj, ctx?: ExecutionContextLike): Promise<Response>;
  scheduled(controller: ScheduledControllerLike, env?: Obj, ctx?: ExecutionContextLike): Promise<void>;
  queue(batch: MessageBatchLike, env?: Obj, ctx?: ExecutionContextLike): Promise<void>;
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/** Collapse whitespace so `controller.cron` matches the configured expression. */
export function normalizeCron(cron: string): string {
  return cron.trim().split(/\s+/).join(" ").toUpperCase();
}

let installedEnv: Obj | undefined;

/** Install the Worker's string bindings as environment variables (once per `env` object). */
export function installEnv(env: Obj | undefined): void {
  (globalThis as unknown as Record<symbol, unknown>)[ENV_KEY] = env;
  if (!env) {
    installedEnv = undefined;
    return;
  }
  if (env === installedEnv) return;
  installedEnv = env;
  setEnv(env);
}

/** The `env` object of the current Worker invocation (bindings included). */
export function workerEnv(): Obj | undefined {
  return (globalThis as unknown as Record<symbol, Obj | undefined>)[ENV_KEY];
}

/** Name of the service binding through which a Worker reaches another function's Worker. */
export function bindingName(fn: string): string {
  return "NSKIT_BINDING_" + fn.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

interface Fetcher {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/**
 * Invoke another function of this service through its service binding (no
 * public URL needed). Returns `undefined` when no binding exists for `fn`, so
 * callers can fall back to other mechanisms.
 */
export async function invokeViaBinding(fn: string, payload: unknown): Promise<{ result: unknown } | undefined> {
  const binding = workerEnv()?.[bindingName(fn)] as Fetcher | undefined;
  if (!binding || typeof binding.fetch !== "function") return undefined;
  const resp = await binding.fetch("https://nskit.internal/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope("invoke", payload)),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`invoke of ${fn} via service binding returned ${resp.status}: ${text.slice(0, 500)}`);
  return { result: text ? maybeJson(text) : undefined };
}

function functionName(): string {
  return getEnv("NSKIT_FUNCTION", "")!;
}

function makeContext(fn: string, env: Obj | undefined, ctx: ExecutionContextLike | undefined, requestId?: string): Context {
  const waitUntil = typeof ctx?.waitUntil === "function" ? ctx.waitUntil.bind(ctx) : undefined;
  return new Context({ requestId, functionName: fn, provider: PROVIDER, waitUntil, raw: { env, ctx } });
}

// ------------------------------------------------------------------ HTTP

/** Convert a Fetch API `Request` into the portable {@link HttpRequest} (reads the body). */
export async function toRequest(request: Request): Promise<HttpRequest> {
  const url = new URL(request.url);
  const multiQuery: Record<string, string[]> = {};
  for (const [k, v] of url.searchParams) (multiQuery[k] ??= []).push(v);
  const query = Object.fromEntries(Object.entries(multiQuery).map(([k, v]) => [k, v[v.length - 1]]));
  const headers: [string, string][] = [];
  request.headers.forEach((value, key) => headers.push([key, value]));
  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" || !request.body ? new Uint8Array() : new Uint8Array(await request.arrayBuffer());
  return new HttpRequest({
    method,
    path: url.pathname || "/",
    headers,
    query,
    multiQuery,
    body,
    sourceIp: request.headers.get("cf-connecting-ip") ?? undefined,
  });
}

function webResponse(status: number, headers: Record<string, string>, body: Uint8Array, cookies: readonly string[] = []): Response {
  const out = new Headers();
  for (const [k, v] of Object.entries(headers)) out.set(k, v);
  for (const cookie of cookies) out.append("set-cookie", cookie);
  const payload = body.length && !NULL_BODY_STATUS.has(status) ? body : null;
  return new Response(payload as BodyInit | null, { status, headers: out });
}

/** Convert an nskit result (an `HttpResponse` or a gateway-style response) into a Fetch API `Response`. */
export function toResponse(result: unknown): Response {
  if (isHttpResponse(result)) {
    const { status, headers, body } = result.render();
    return webResponse(status, headers, body, result.cookies);
  }
  const gw = result as GatewayResponse;
  const body = gw.isBase64 ? base64Decode(gw.body) : utf8Encode(gw.body);
  return webResponse(gw.status, gw.headers, body);
}

export async function fetchHandler(request: Request, env?: Obj, ctx?: ExecutionContextLike): Promise<Response> {
  installEnv(env);
  const fn = functionName();
  const req = await toRequest(request);
  const event = eventFromRequest(req, PROVIDER, fn, request);
  const context = makeContext(fn, env, ctx, req.headers.get("cf-ray") || undefined);
  // HTTP keeps the HttpResponse (cookies, binary bodies); envelope events become JSON 200 / 500.
  const result = event.http ? await execute(event, context) : await runHttp(event, context);
  return toResponse(result);
}

// ------------------------------------------------------------------ cron triggers

export function scheduleEvent(
  controller: ScheduledControllerLike,
  fn: string,
  schedules: Record<string, Record<string, unknown>> = {},
): Event {
  const cron = String(controller?.cron ?? "");
  const configured = schedules[fn] ?? {};
  const wanted = normalizeCron(cron);
  const key = Object.keys(configured).find((c) => normalizeCron(c) === wanted);
  return new Event({
    type: EventType.SCHEDULE,
    provider: PROVIDER,
    functionName: fn,
    data: key === undefined ? null : (configured[key] ?? null),
    time: parseTime(controller?.scheduledTime),
    source: cron || undefined,
    raw: controller,
  });
}

export async function scheduledHandler(
  controller: ScheduledControllerLike,
  env: Obj | undefined,
  ctx: ExecutionContextLike | undefined,
  schedules: Record<string, Record<string, unknown>> = {},
): Promise<void> {
  installEnv(env);
  const fn = functionName();
  await execute(scheduleEvent(controller, fn, schedules), makeContext(fn, env, ctx));
}

// ------------------------------------------------------------------ queues

export function queueEvent(batch: MessageBatchLike, fn: string): Event {
  const first = batch.messages[0];
  return new Event({
    type: EventType.QUEUE,
    provider: PROVIDER,
    functionName: fn,
    source: batch.queue,
    time: first?.timestamp !== undefined ? parseTime(first.timestamp) : undefined,
    raw: batch,
    records: batch.messages.map(
      (m) =>
        new EventRecord({
          id: m.id,
          body: m.body instanceof ArrayBuffer ? new Uint8Array(m.body) : m.body,
          attributes: { attempts: m.attempts, timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp },
          source: batch.queue,
          raw: m,
        }),
    ),
  });
}

function settle(batch: MessageBatchLike, failed: readonly string[]): void {
  const failedIds = new Set(failed);
  for (const m of batch.messages) {
    if (failedIds.has(m.id)) m.retry?.();
    else m.ack?.();
  }
}

export async function queueHandler(batch: MessageBatchLike, env?: Obj, ctx?: ExecutionContextLike): Promise<void> {
  installEnv(env);
  const fn = functionName();
  let result: unknown;
  try {
    result = await execute(queueEvent(batch, fn), makeContext(fn, env, ctx));
  } catch (err) {
    // Partial failure: retry only those messages. Anything else fails the batch and Queues redelivers it.
    if (err instanceof BatchFailure || (err as { name?: string })?.name === "BatchFailure") {
      settle(batch, (err as BatchFailure).failedIds ?? []);
      return;
    }
    throw err;
  }
  if (isBatchResult(result) && result.failed.length) settle(batch, result.failed);
}

// ------------------------------------------------------------------ entry

/** Build the default export of the Worker module. */
export function createWorker(options: WorkerOptions = {}): WorkerModule {
  const schedules = options.schedules ?? {};
  return {
    fetch: (request, env, ctx) => fetchHandler(request, env, ctx),
    scheduled: (controller, env, ctx) => scheduledHandler(controller, env, ctx, schedules),
    queue: (batch, env, ctx) => queueHandler(batch, env, ctx),
  };
}
