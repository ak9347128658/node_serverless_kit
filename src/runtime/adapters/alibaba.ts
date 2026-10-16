/**
 * Alibaba Cloud Function Compute 3.0 adapter (built-in Node.js runtimes).
 *
 * FC calls `index.handler(event, context)` with `event` as a Buffer holding the
 * raw payload. Handles HTTP triggers (JSON event with `rawPath`, `headers`,
 * `queryParameters`, `body`, `isBase64Encoded`, `requestContext.http`), timer
 * triggers, OSS triggers, MNS topic triggers (JSON notify format) and direct
 * invocation.
 */

import { Context } from "../context.js";
import { execute } from "../dispatch.js";
import { actionFrom, unwrapEnvelope } from "../envelope.js";
import { Event, EventRecord, EventType, HttpRequest, parseTime } from "../event.js";
import type { HttpResponse } from "../response.js";
import { getEnv, maybeJson } from "../util.js";

export const PROVIDER = "alibaba";
type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

/** The subset of the FC 3.0 Node.js context nskit reads. */
export interface FcContext {
  requestId?: string;
  region?: string;
  accountId?: string;
  function?: { name?: string; handler?: string; memory?: number | string; timeout?: number | string };
  [key: string]: unknown;
}

function httpRequest(evt: Obj): HttpRequest {
  const http = obj(obj(evt.requestContext).http);
  const query: Record<string, string> = {};
  const multiQuery: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(obj(evt.queryParameters))) {
    // FC 3.0 joins repeated keys with "," in a single string; FC 2.0 / custom gateways may send arrays.
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    multiQuery[key] = values;
    query[key] = values.length ? values[values.length - 1] : "";
  }
  return new HttpRequest({
    method: str(http.method) ?? "GET",
    path: str(evt.rawPath) || str(http.path) || "/",
    headers: obj(evt.headers),
    query,
    multiQuery,
    body: HttpRequest.decodeBody(evt.body, Boolean(evt.isBase64Encoded)),
    sourceIp: str(http.sourceIp),
  });
}

function ossEvent(evt: Obj, fn: string): Event {
  const items = (evt.events as unknown[]).map(obj);
  const records = items.map((r) => {
    const oss = obj(r.oss);
    const o = obj(oss.object);
    return new EventRecord({
      id: str(obj(r.responseElements).requestId),
      bucket: str(obj(oss.bucket).name),
      key: str(o.key) ?? "",
      size: num(o.size),
      action: actionFrom(str(r.eventName)),
      attributes: { eventName: r.eventName, etag: o.eTag },
      source: "acs:oss",
      raw: r,
    });
  });
  return new Event({
    type: EventType.STORAGE,
    provider: PROVIDER,
    functionName: fn,
    records,
    source: "acs:oss",
    time: parseTime(items[0]?.eventTime),
    raw: evt,
  });
}

function mnsEvent(evt: Obj, fn: string): Event {
  const attributes: Obj = {};
  for (const [k, v] of Object.entries(evt)) if (k !== "Message") attributes[k] = v;
  const record = new EventRecord({
    id: str(evt.MessageId),
    body: evt.Message,
    attributes,
    source: `${str(evt.TopicOwner) ?? ""}:${str(evt.TopicName) ?? ""}`,
    raw: evt,
  });
  return new Event({
    type: EventType.TOPIC,
    provider: PROVIDER,
    functionName: fn,
    records: [record],
    source: str(evt.TopicName),
    time: parseTime(evt.PublishTime),
    raw: evt,
  });
}

/** FC passes a Buffer; tests and local tools may pass a string or an object. */
function decodeNative(native: unknown): unknown {
  return maybeJson(native);
}

export function toEvent(native: unknown, ctx?: FcContext): Event {
  const fn = getEnv("NSKIT_FUNCTION") ?? ctx?.function?.name ?? "";
  const evt = decodeNative(native);
  const wrapped = unwrapEnvelope(evt);
  if (wrapped) {
    return new Event({ type: wrapped.kind, provider: PROVIDER, functionName: fn, data: wrapped.data, source: str(wrapped.meta.source), raw: evt });
  }
  if (evt && typeof evt === "object" && !Array.isArray(evt) && !(evt instanceof Uint8Array)) {
    const e = evt as Obj;
    const rc = e.requestContext;
    if (rc && typeof rc === "object" && obj(rc).http && typeof obj(rc).http === "object") {
      return new Event({ type: EventType.HTTP, provider: PROVIDER, functionName: fn, http: httpRequest(e), raw: evt });
    }
    if ("triggerTime" in e && "triggerName" in e) {
      const payload = e.payload;
      const inner = payload ? unwrapEnvelope(payload) : undefined;
      return new Event({
        type: EventType.SCHEDULE,
        provider: PROVIDER,
        functionName: fn,
        data: inner ? inner.data : payload ? maybeJson(payload) : undefined,
        time: parseTime(e.triggerTime),
        source: str(e.triggerName),
        raw: evt,
      });
    }
    const events = e.events;
    if (Array.isArray(events) && events.length && "oss" in obj(events[0])) return ossEvent(e, fn);
    if ("TopicName" in e && "Message" in e) return mnsEvent(e, fn);
  }
  return new Event({ type: EventType.INVOKE, provider: PROVIDER, functionName: fn, data: evt, raw: native });
}

export function toContext(ctx: FcContext | undefined, functionName: string): Context {
  if (!ctx) return new Context({ functionName, provider: PROVIDER });
  const memory = num(ctx.function?.memory);
  const timeout = num(ctx.function?.timeout);
  return new Context({
    requestId: str(ctx.requestId),
    functionName,
    provider: PROVIDER,
    region: str(ctx.region) || undefined,
    memoryMb: memory || undefined,
    deadline: timeout ? Date.now() + timeout * 1000 : undefined,
    raw: ctx,
  });
}

export function toNative(result: unknown, event: Event): unknown {
  if (event.http) {
    const resp = result as HttpResponse;
    const { status, headers, body, isBase64 } = resp.renderForGateway();
    // FC's response struct takes one string per header.
    if (resp.cookies.length) headers["set-cookie"] = resp.cookies.join(", ");
    return { statusCode: status, headers, body, isBase64Encoded: isBase64 };
  }
  return result;
}

/** FC 3.0 entrypoint - the generated entry module re-exports this as `handler`. */
export async function handler(native: unknown, ctx?: FcContext): Promise<unknown> {
  const event = toEvent(native, ctx);
  const context = toContext(ctx, event.functionName);
  const result = await execute(event, context);
  return toNative(result, event);
}
