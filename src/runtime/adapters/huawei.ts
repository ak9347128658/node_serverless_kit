/**
 * Huawei Cloud FunctionGraph adapter (Node.js runtimes).
 *
 * FunctionGraph calls `index.handler(event, context)` with the event already
 * parsed from JSON and a context exposing getter methods (`getRequestID()`,
 * `getRemainingTimeInMilliSeconds()`, ...). Handles dedicated APIG events, timer
 * triggers, OBS triggers, SMN topic triggers and direct invocation.
 */

import { Context } from "../context.js";
import { execute } from "../dispatch.js";
import { actionFrom, unwrapEnvelope } from "../envelope.js";
import { Event, EventRecord, EventType, HttpRequest, parseTime } from "../event.js";
import type { HttpResponse } from "../response.js";
import { getEnv, maybeJson } from "../util.js";

export const PROVIDER = "huawei";
type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

/** The subset of the FunctionGraph Node.js context nskit reads. */
export interface FgsContext {
  getRequestID?: () => string;
  getRemainingTimeInMilliSeconds?: () => number;
  getFunctionName?: () => string;
  getMemorySize?: () => number | string;
  [key: string]: unknown;
}

/** Call a context getter; FunctionGraph helpers are best effort. */
function call(ctx: FgsContext | undefined, method: keyof FgsContext): unknown {
  const fn = ctx?.[method];
  if (typeof fn !== "function") return undefined;
  try {
    return (fn as () => unknown).call(ctx);
  } catch {
    return undefined;
  }
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
  const query: Record<string, string> = {};
  const multiQuery: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(obj(evt.queryStringParameters))) {
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    multiQuery[key] = values;
    query[key] = values.length ? values[values.length - 1] : "";
  }
  return new HttpRequest({
    method: str(evt.httpMethod) ?? "GET",
    path: str(evt.path) || "/",
    headers: obj(evt.headers),
    query,
    multiQuery,
    pathParams: Object.fromEntries(Object.entries(obj(evt.pathParameters)).map(([k, v]) => [k, String(v)])),
    body: HttpRequest.decodeBody(evt.body, Boolean(evt.isBase64Encoded)),
    sourceIp: str(rc.sourceIp),
  });
}

function obsEvent(evt: Obj, fn: string): Event {
  const items = (evt.Records as unknown[]).map(obj);
  const records = items.map((r) => {
    const obs = obj(r.obs ?? r.s3);
    const o = obj(obs.object);
    return new EventRecord({
      id: str(o.sequencer),
      bucket: str(obj(obs.bucket).name),
      key: decodePlus(str(o.key) ?? ""),
      size: num(o.size),
      action: actionFrom(str(r.eventName)),
      attributes: { eventName: r.eventName, etag: o.eTag },
      source: "obs",
      raw: r,
    });
  });
  return new Event({
    type: EventType.STORAGE,
    provider: PROVIDER,
    functionName: fn,
    records,
    source: "obs",
    time: parseTime(items[0]?.eventTime),
    raw: evt,
  });
}

function smnEvent(evt: Obj, fn: string): Event {
  const items = (evt.record as unknown[]).map(obj);
  const records = items.map((r) => {
    const smn = obj(r.smn);
    return new EventRecord({
      id: str(smn.message_id),
      body: smn.message,
      attributes: { subject: smn.subject, ...obj(smn.message_attributes) },
      source: str(smn.topic_urn),
      raw: r,
    });
  });
  const first = obj(items[0]?.smn);
  return new Event({
    type: EventType.TOPIC,
    provider: PROVIDER,
    functionName: fn,
    records,
    source: str(first.topic_urn),
    time: parseTime(first.timestamp),
    raw: evt,
  });
}

export function toEvent(native: unknown, ctx?: FgsContext): Event {
  const fn = getEnv("NSKIT_FUNCTION") ?? str(call(ctx, "getFunctionName")) ?? "";
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
    if (String(e.trigger_type ?? "").toUpperCase() === "TIMER") {
      const userEvent = e.user_event;
      const inner = userEvent ? unwrapEnvelope(userEvent) : undefined;
      return new Event({
        type: EventType.SCHEDULE,
        provider: PROVIDER,
        functionName: fn,
        data: inner ? inner.data : userEvent ? maybeJson(userEvent) : undefined,
        time: parseTime(e.time),
        source: str(e.trigger_name),
        raw: evt,
      });
    }
    const records = e.Records;
    if (Array.isArray(records) && records.length && ("obs" in obj(records[0]) || "s3" in obj(records[0]))) return obsEvent(e, fn);
    const smn = e.record;
    if (Array.isArray(smn) && smn.length && "smn" in obj(smn[0])) return smnEvent(e, fn);
  }
  return new Event({ type: EventType.INVOKE, provider: PROVIDER, functionName: fn, data: evt, raw: native });
}

export function toContext(ctx: FgsContext | undefined, functionName: string): Context {
  if (!ctx) return new Context({ functionName, provider: PROVIDER });
  const memory = num(call(ctx, "getMemorySize"));
  const remainingMs = num(call(ctx, "getRemainingTimeInMilliSeconds"));
  const remaining =
    typeof ctx.getRemainingTimeInMilliSeconds === "function" ? () => num(call(ctx, "getRemainingTimeInMilliSeconds")) ?? 0 : undefined;
  const requestId = call(ctx, "getRequestID");
  return new Context({
    requestId: requestId ? String(requestId) : undefined,
    functionName,
    provider: PROVIDER,
    memoryMb: memory || undefined,
    deadline: remainingMs ? Date.now() + remainingMs : undefined,
    remainingTimeMs: remaining,
    raw: ctx,
  });
}

export function toNative(result: unknown, event: Event): unknown {
  if (event.http) {
    const resp = result as HttpResponse;
    const { status, headers, body, isBase64 } = resp.renderForGateway();
    if (resp.cookies.length) headers["set-cookie"] = resp.cookies.join(", ");
    return { statusCode: status, isBase64Encoded: isBase64, headers, body };
  }
  return result;
}

/** FunctionGraph entrypoint - the generated entry module re-exports this as `handler`. */
export async function handler(native: unknown, ctx?: FgsContext): Promise<unknown> {
  const event = toEvent(native, ctx);
  const context = toContext(ctx, event.functionName);
  const result = await execute(event, context);
  return toNative(result, event);
}
