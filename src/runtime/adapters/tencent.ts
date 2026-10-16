/**
 * Tencent Cloud SCF adapter (Node.js runtimes).
 *
 * SCF calls `index.main_handler(event, context)` with the event already parsed
 * from JSON. Handles API Gateway events (integrated response), timer triggers,
 * COS triggers and direct invocation.
 */

import { Context } from "../context.js";
import { execute } from "../dispatch.js";
import { actionFrom, unwrapEnvelope } from "../envelope.js";
import { Event, EventRecord, EventType, HttpRequest, parseTime } from "../event.js";
import type { HttpResponse } from "../response.js";
import { getEnv, maybeJson } from "../util.js";

export const PROVIDER = "tencent";
type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

/** The subset of the SCF Node.js context nskit reads. */
export interface ScfContext {
  request_id?: string;
  function_name?: string;
  memory_limit_in_mb?: number | string;
  time_limit_in_ms?: number | string;
  tencentcloud_region?: string;
  getRemainingTimeInMillis?: () => number;
  [key: string]: unknown;
}

function decodePlus(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

function httpRequest(evt: Obj): HttpRequest {
  const rc = obj(evt.requestContext);
  let query: Record<string, string> = {};
  let multiQuery: Record<string, string[]> = {};
  const rawQuery = evt.queryString;
  if (rawQuery && typeof rawQuery === "object" && !Array.isArray(rawQuery)) {
    for (const [key, value] of Object.entries(rawQuery as Obj)) {
      const values = Array.isArray(value) ? value.map(String) : [String(value)];
      multiQuery[key] = values;
      query[key] = values.length ? values[values.length - 1] : "";
    }
  } else if (typeof rawQuery === "string" && rawQuery) {
    for (const [key, value] of new URLSearchParams(rawQuery)) (multiQuery[key] ??= []).push(value);
    query = Object.fromEntries(Object.entries(multiQuery).map(([k, v]) => [k, v[v.length - 1]]));
  }
  const qsp = obj(evt.queryStringParameters);
  if (!Object.keys(query).length && Object.keys(qsp).length) {
    query = Object.fromEntries(Object.entries(qsp).map(([k, v]) => [k, String(v)]));
    multiQuery = Object.fromEntries(Object.entries(query).map(([k, v]) => [k, [v]]));
  }
  return new HttpRequest({
    method: str(evt.httpMethod) ?? str(rc.httpMethod) ?? "GET",
    path: str(evt.path) || str(rc.path) || "/",
    headers: obj(evt.headers),
    query,
    multiQuery,
    pathParams: Object.fromEntries(Object.entries(obj(evt.pathParameters)).map(([k, v]) => [k, String(v)])),
    body: HttpRequest.decodeBody(evt.body, Boolean(evt.isBase64Encoded)),
    sourceIp: str(rc.sourceIp),
  });
}

function cosEvent(evt: Obj, fn: string): Event {
  const items = (evt.Records as unknown[]).map(obj);
  const records = items.map((r) => {
    const cos = obj(r.cos);
    const o = obj(cos.cosObject);
    let key = str(o.key) ?? "";
    // COS keys look like "/<appid>/<bucket>/<path>"; strip that prefix.
    const parts = key.replace(/^\/+/, "").split("/");
    if (parts.length >= 3 && /^\d+$/.test(parts[0])) key = parts.slice(2).join("/");
    const eventName = str(obj(r.event).eventName) ?? "";
    return new EventRecord({
      id: str(obj(o.meta)["x-cos-request-id"]),
      bucket: str(obj(cos.cosBucket).name),
      key: decodePlus(key),
      size: num(o.size),
      action: actionFrom(eventName),
      attributes: { eventName, url: o.url },
      source: "cos",
      raw: r,
    });
  });
  return new Event({
    type: EventType.STORAGE,
    provider: PROVIDER,
    functionName: fn,
    records,
    source: "cos",
    time: parseTime(obj(items[0]?.event).eventTime),
    raw: evt,
  });
}

export function toEvent(native: unknown, ctx?: ScfContext): Event {
  const fn = getEnv("NSKIT_FUNCTION") ?? str(ctx?.function_name) ?? "";
  const evt = maybeJson(native);
  const wrapped = unwrapEnvelope(evt);
  if (wrapped) {
    return new Event({ type: wrapped.kind, provider: PROVIDER, functionName: fn, data: wrapped.data, source: str(wrapped.meta.source), raw: evt });
  }
  if (evt && typeof evt === "object" && !Array.isArray(evt) && !(evt instanceof Uint8Array)) {
    const e = evt as Obj;
    if ("httpMethod" in e && ("requestContext" in e || "path" in e)) {
      return new Event({ type: EventType.HTTP, provider: PROVIDER, functionName: fn, http: httpRequest(e), raw: evt });
    }
    if (e.Type === "Timer") {
      const message = e.Message;
      const inner = message ? unwrapEnvelope(message) : undefined;
      return new Event({
        type: EventType.SCHEDULE,
        provider: PROVIDER,
        functionName: fn,
        data: inner ? inner.data : message ? maybeJson(message) : undefined,
        time: parseTime(e.Time),
        source: str(e.TriggerName),
        raw: evt,
      });
    }
    const records = e.Records;
    if (Array.isArray(records) && records.length && "cos" in obj(records[0])) return cosEvent(e, fn);
  }
  return new Event({ type: EventType.INVOKE, provider: PROVIDER, functionName: fn, data: evt, raw: native });
}

export function toContext(ctx: ScfContext | undefined, functionName: string): Context {
  if (!ctx) return new Context({ functionName, provider: PROVIDER });
  const limitMs = num(ctx.time_limit_in_ms);
  const memory = num(ctx.memory_limit_in_mb);
  const remaining = typeof ctx.getRemainingTimeInMillis === "function" ? ctx.getRemainingTimeInMillis.bind(ctx) : undefined;
  return new Context({
    requestId: ctx.request_id ? String(ctx.request_id) : undefined,
    functionName,
    provider: PROVIDER,
    region: str(ctx.tencentcloud_region) || undefined,
    memoryMb: memory || undefined,
    deadline: limitMs ? Date.now() + limitMs : undefined,
    remainingTimeMs: remaining,
    raw: ctx,
  });
}

export function toNative(result: unknown, event: Event): unknown {
  if (event.http) {
    const resp = result as HttpResponse;
    const { status, headers, body, isBase64 } = resp.renderForGateway();
    if (resp.cookies.length) headers["set-cookie"] = resp.cookies.join(", ");
    return { isBase64Encoded: isBase64, statusCode: status, headers, body };
  }
  return result;
}

/** SCF entrypoint - the generated entry module re-exports this as `main_handler`. */
export async function mainHandler(native: unknown, ctx?: ScfContext): Promise<unknown> {
  const event = toEvent(native, ctx);
  const context = toContext(ctx, event.functionName);
  const result = await execute(event, context);
  return toNative(result, event);
}

export { mainHandler as main_handler, mainHandler as handler };
