/**
 * Google Cloud Functions (2nd gen) adapter for the Node.js Functions Framework.
 *
 * Two entry points are registered by the generated entry module (see
 * `providers/gcp.ts`):
 *
 * - `nskit_http` - `(req, res)` Express-style HTTP function. A POST body that
 *   carries the `__nskit` envelope (Cloud Scheduler, Cloud Workflows,
 *   `invoke()`) is dispatched as a *non-HTTP* event and answered with the raw
 *   JSON result, or a 500 `{"errorType", "cause"}` that the workflow compiler
 *   understands.
 * - `nskit_event` - CloudEvent function: Pub/Sub `messagePublished` (queue /
 *   topic) and Cloud Storage `finalized` / `deleted`. A rejected promise makes
 *   Eventarc redeliver the event.
 *
 * This module is zero-dependency: the Functions Framework is only touched
 * through the objects it passes in (and the `register` helper, which receives
 * the framework module from the entry glue).
 */

import { Context } from "../context.js";
import { execute } from "../dispatch.js";
import { actionFrom, first, unwrapEnvelope } from "../envelope.js";
import { Event, EventRecord, EventType, HttpRequest, parseTime } from "../event.js";
import { dumps, type HttpResponse } from "../response.js";
import { base64Decode, getEnv, maybeJson, utf8DecodeStrict } from "../util.js";
import { decodeBody, errorBody } from "./httpfn.js";

export const PROVIDER = "gcp";
export const HTTP_ENTRY = "nskit_http";
export const EVENT_ENTRY = "nskit_event";
type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The subset of an Express / Node `IncomingMessage` the adapter reads. */
export interface GcpRequest {
  method?: string;
  url?: string;
  originalUrl?: string;
  path?: string;
  headers?: Record<string, string | string[] | undefined>;
  rawBody?: Uint8Array;
  body?: unknown;
  ip?: string;
  socket?: { remoteAddress?: string };
}

/** The subset of an Express / Node `ServerResponse` the adapter writes. */
export interface GcpResponse {
  statusCode: number;
  setHeader(name: string, value: string | string[]): unknown;
  end(body?: Uint8Array | string): unknown;
}

/** A CloudEvent as passed by the Functions Framework (or a plain object with the same keys). */
export interface GcpCloudEvent {
  id?: string;
  type?: string;
  source?: string;
  subject?: string;
  time?: string;
  data?: unknown;
  [key: string]: unknown;
}

function functionName(): string {
  return getEnv("NSKIT_FUNCTION", "")!;
}

function header(headers: GcpRequest["headers"], name: string): string | undefined {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : value;
}

function requestId(headers: GcpRequest["headers"]): string | undefined {
  for (const key of ["function-execution-id", "x-cloud-trace-context"]) {
    const value = header(headers, key);
    if (value) return value.split("/")[0];
  }
  return undefined;
}

function context(fn: string, id: string | undefined, raw: unknown): Context {
  return new Context({ requestId: id, functionName: fn, provider: PROVIDER, raw });
}

// ------------------------------------------------------------------ HTTP

function requestBody(req: GcpRequest): Uint8Array {
  if (req.rawBody instanceof Uint8Array) return req.rawBody;
  const body = req.body;
  if (body === undefined || body === null) return new Uint8Array();
  // Express sets `{}` when no body parser matched (e.g. GET): that is "no body".
  if (typeof body === "object" && !(body instanceof Uint8Array) && !Object.keys(body).length) return new Uint8Array();
  return decodeBody(body, (req.headers ?? {}) as Record<string, unknown>, false);
}

/** Translate a Functions Framework (Express) request into a portable HTTP event. */
export function toHttpEvent(req: GcpRequest, fn = functionName()): Event {
  const url = req.originalUrl ?? req.url ?? req.path ?? "/";
  const qIdx = url.indexOf("?");
  const path = (qIdx >= 0 ? url.slice(0, qIdx) : url) || "/";
  const multiQuery: Record<string, string[]> = {};
  if (qIdx >= 0) {
    for (const [k, v] of new URLSearchParams(url.slice(qIdx + 1))) (multiQuery[k] ??= []).push(v);
  }
  const headers = req.headers ?? {};
  const forwarded = header(headers, "x-forwarded-for")?.split(",")[0].trim();
  const http = new HttpRequest({
    method: req.method ?? "GET",
    path,
    headers,
    multiQuery,
    body: requestBody(req),
    sourceIp: forwarded || req.ip || req.socket?.remoteAddress,
  });
  return new Event({ type: EventType.HTTP, provider: PROVIDER, functionName: fn, http, raw: req });
}

function send(res: GcpResponse, status: number, headers: Record<string, string>, body: Uint8Array | string, cookies: string[] = []): void {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (cookies.length) res.setHeader("set-cookie", [...cookies]);
  res.end(body);
}

const JSON_HEADERS = { "content-type": "application/json" };

/** `nskit_http` entry point: `(req, res)`. */
export async function nskitHttp(req: GcpRequest, res: GcpResponse): Promise<void> {
  const fn = functionName();
  const id = requestId(req.headers);
  const body = requestBody(req);
  const wrapped = (req.method ?? "GET").toUpperCase() === "POST" && body[0] === 0x7b /* "{" */ ? unwrapEnvelope(body) : undefined;
  if (wrapped) {
    const event = new Event({
      type: wrapped.kind,
      provider: PROVIDER,
      functionName: fn,
      data: wrapped.data,
      source: str(wrapped.meta.source),
      raw: req,
    });
    let result: unknown;
    try {
      result = await execute(event, context(fn, id, req));
    } catch (err) {
      send(res, 500, JSON_HEADERS, dumps(errorBody(err)));
      return;
    }
    send(res, 200, JSON_HEADERS, result === undefined ? "null" : dumps(result));
    return;
  }
  const event = toHttpEvent(req, fn);
  const resp = (await execute(event, context(fn, id, req))) as HttpResponse;
  const rendered = resp.render();
  send(res, rendered.status, rendered.headers, rendered.body, resp.cookies);
}

// ------------------------------------------------------------------ CloudEvents

function storageWanted(key: string): boolean {
  const prefix = getEnv("NSKIT_STORAGE_PREFIX", "")!;
  const suffix = getEnv("NSKIT_STORAGE_SUFFIX", "")!;
  return key.startsWith(prefix) && key.endsWith(suffix);
}

function eventData(ce: GcpCloudEvent): Obj {
  let data: unknown = ce.data;
  if (typeof data === "string" || data instanceof Uint8Array) data = maybeJson(data);
  return obj(data);
}

/** Pub/Sub message data is base64; return text when it is UTF-8, raw bytes otherwise. */
function messageBody(data: unknown): string | Uint8Array | undefined {
  if (typeof data !== "string") return undefined;
  let bytes: Uint8Array;
  try {
    bytes = base64Decode(data);
  } catch {
    return data;
  }
  return utf8DecodeStrict(bytes) ?? bytes;
}

/** Translate a CloudEvent; returns `undefined` when filtered out (storage prefix / suffix). */
export function toCloudEvent(ce: GcpCloudEvent, fn = functionName()): Event | undefined {
  const type = String(ce.type ?? "");
  const source = str(ce.source);
  const time = parseTime(ce.time);
  const data = eventData(ce);
  if (type.startsWith("google.cloud.pubsub.topic")) {
    const msg = obj(data.message);
    const body = messageBody(msg.data);
    const wrapped = typeof body === "string" ? unwrapEnvelope(body) : undefined;
    if (wrapped) {
      // Cloud Scheduler -> Pub/Sub target (event-only functions).
      return new Event({
        type: wrapped.kind,
        provider: PROVIDER,
        functionName: fn,
        data: wrapped.data,
        time,
        source: str(wrapped.meta.source) ?? source,
        raw: ce,
      });
    }
    const kind = getEnv("NSKIT_TRIGGER_KIND") === "queue" ? EventType.QUEUE : EventType.TOPIC;
    const record = new EventRecord({
      id: str(first(msg, "messageId", "message_id")) ?? str(ce.id),
      body,
      attributes: { ...obj(msg.attributes) },
      source: str(data.subscription) ?? source,
      raw: msg,
    });
    return new Event({ type: kind, provider: PROVIDER, functionName: fn, records: [record], time, source, raw: ce });
  }
  if (type.startsWith("google.cloud.storage.object")) {
    const key = String(data.name ?? "");
    if (!storageWanted(key)) return undefined;
    const size = data.size;
    const record = new EventRecord({
      id: String(first(data, "generation") ?? ce.id ?? ""),
      bucket: str(data.bucket),
      key,
      size: size !== undefined && size !== null && size !== "" ? Number(size) : undefined,
      action: actionFrom(type.split(".").pop()),
      attributes: { contentType: data.contentType, eventType: type },
      source,
      raw: data,
    });
    return new Event({ type: EventType.STORAGE, provider: PROVIDER, functionName: fn, records: [record], time, source, raw: ce });
  }
  return new Event({ type: EventType.INVOKE, provider: PROVIDER, functionName: fn, data: ce.data ?? data, time, source, raw: ce });
}

/** `nskit_event` entry point: CloudEvent function. Rejects on failure so Eventarc retries. */
export async function nskitEvent(ce: GcpCloudEvent): Promise<unknown> {
  const fn = functionName();
  const event = toCloudEvent(ce, fn);
  if (!event) return undefined;
  return execute(event, context(fn, str(ce.id), ce));
}

/** The part of `@google-cloud/functions-framework` used for declarative registration. */
export interface FunctionsFramework {
  http(name: string, handler: (req: never, res: never) => unknown): void;
  cloudEvent(name: string, handler: (ce: never) => unknown): void;
}

/** Register both entry points with the Functions Framework (called by the generated entry module). */
export function register(ff: FunctionsFramework | undefined | null): void {
  if (!ff || typeof ff.http !== "function" || typeof ff.cloudEvent !== "function") return;
  ff.http(HTTP_ENTRY, nskitHttp as (req: never, res: never) => unknown);
  ff.cloudEvent(EVENT_ENTRY, nskitEvent as (ce: never) => unknown);
}
