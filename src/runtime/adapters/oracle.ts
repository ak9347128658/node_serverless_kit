/**
 * Oracle Cloud (OCI) Functions adapter, driven by the Fn Project Node FDK.
 *
 * The generated `func.js` calls `fdk.handle((input, ctx) => handler(input, ctx, fdk.rawResult), {inputMode: "buffer"})`.
 * This module never imports `@fnproject/fdk` itself: the FDK is installed in
 * the container image and only touched from that glue file.
 *
 * Invocations come from:
 *
 * - OCI API Gateway: the FDK context carries `Fn-Http-Method`,
 *   `Fn-Http-Request-Url` and `Fn-Http-H-<name>` headers; the response status
 *   and headers go back as `Fn-Http-Status` / `Fn-Http-H-<name>`;
 * - OCI Events (Object Storage): a CloudEvents JSON body;
 * - direct invoke (`oci fn function invoke`, `fn invoke`) / the `__nskit` envelope.
 */

import { Context } from "../context.js";
import { actionFrom, unwrapEnvelope } from "../envelope.js";
import { Event, EventRecord, EventType, HttpRequest, parseTime } from "../event.js";
import type { GatewayResponse } from "../response.js";
import { base64Decode, getEnv, maybeJson, toBytes, utf8DecodeStrict, utf8Encode } from "../util.js";
import { eventFromRequest, runHttp } from "./httpfn.js";

export const PROVIDER = "oracle";
const HEADER_PREFIX = "fn-http-h-";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** The parts of the Fn FDK `Context` the adapter uses. */
export interface FdkContext {
  /** Request headers, canonical keys (`Fn-Http-Method`), each a list of values. */
  headers?: Record<string, string | string[]>;
  callID?: string;
  deadline?: Date | null;
  memory?: number;
  fnName?: string;
  setResponseHeader?(key: string, ...values: string[]): void;
  responseContentType?: string | null;
}

/** `fdk.rawResult` - passed in by the generated glue so the body is written untouched. */
export type RawResult = (body: Uint8Array) => unknown;

function lowerHeaders(ctx: FdkContext | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(ctx?.headers ?? {})) {
    if (v === undefined || v === null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.map(String) : [String(v)];
  }
  return out;
}

/** HTTP request behind OCI API Gateway, or `undefined` for a non-HTTP invocation. */
export function toRequest(ctx: FdkContext | undefined, body: Uint8Array): HttpRequest | undefined {
  const headers = lowerHeaders(ctx);
  const method = headers["fn-http-method"]?.[0];
  if (!method) return undefined;
  const rawUrl = headers["fn-http-request-url"]?.[0] || "/";
  const url = new URL(rawUrl, "http://oci.invalid");
  const multiQuery: Record<string, string[]> = {};
  for (const [k, v] of url.searchParams) (multiQuery[k] ??= []).push(v);
  const httpHeaders: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith(HEADER_PREFIX) && k.length > HEADER_PREFIX.length) httpHeaders[k.slice(HEADER_PREFIX.length)] = v;
  }
  const forwarded = (httpHeaders["x-forwarded-for"]?.[0] ?? httpHeaders["x-real-ip"]?.[0] ?? "").split(",")[0].trim();
  return new HttpRequest({
    method,
    path: url.pathname || "/",
    headers: httpHeaders,
    multiQuery,
    body,
    sourceIp: forwarded || undefined,
  });
}

function cloudEvent(payload: Obj, fn: string): Event | undefined {
  const etype = String(payload.eventType ?? payload.type ?? "");
  if (!etype.includes("objectstorage")) return undefined;
  const data = obj(payload.data);
  const details = obj(data.additionalDetails);
  const source = str(payload.source) ?? "objectstorage";
  const record = new EventRecord({
    id: str(payload.eventID) ?? str(payload.id),
    bucket: str(details.bucketName),
    key: str(data.resourceName),
    action: actionFrom(etype),
    attributes: { eventType: etype, namespace: details.namespace },
    source,
    raw: payload,
  });
  return new Event({
    type: EventType.STORAGE,
    provider: PROVIDER,
    functionName: fn,
    records: [record],
    source,
    time: parseTime(payload.eventTime ?? payload.time),
    raw: payload,
  });
}

function payloadOf(body: Uint8Array): unknown {
  if (!body.length) return null;
  const text = utf8DecodeStrict(body);
  return text === undefined ? body : maybeJson(text);
}

export function toEvent(ctx: FdkContext | undefined, input: unknown, fn: string): Event {
  const body = toBytes(input);
  const req = toRequest(ctx, body);
  if (req) return eventFromRequest(req, PROVIDER, fn, ctx);
  const payload = payloadOf(body);
  const wrapped = unwrapEnvelope(payload);
  if (wrapped) {
    const source = str(wrapped.meta.source);
    return new Event({ type: wrapped.kind, provider: PROVIDER, functionName: fn, data: wrapped.data, source, raw: payload });
  }
  if (payload && typeof payload === "object" && !(payload instanceof Uint8Array) && !Array.isArray(payload)) {
    const storage = cloudEvent(payload as Obj, fn);
    if (storage) return storage;
  }
  return new Event({ type: EventType.INVOKE, provider: PROVIDER, functionName: fn, data: payload, raw: payload });
}

export function toContext(ctx: FdkContext | undefined, functionName: string): Context {
  const deadline = ctx?.deadline instanceof Date && !Number.isNaN(ctx.deadline.getTime()) ? ctx.deadline.getTime() : undefined;
  return new Context({
    requestId: ctx?.callID || undefined,
    functionName,
    provider: PROVIDER,
    memoryMb: typeof ctx?.memory === "number" && Number.isFinite(ctx.memory) ? ctx.memory : undefined,
    deadline,
    remainingTimeMs: deadline !== undefined ? () => Math.max(0, deadline - Date.now()) : undefined,
    raw: ctx,
  });
}

/** Write status and headers onto the FDK context (`Fn-Http-Status`, `Fn-Http-H-*`, `Content-Type`). */
function applyResponse(ctx: FdkContext | undefined, res: GatewayResponse, viaGateway: boolean): void {
  if (!ctx || typeof ctx.setResponseHeader !== "function") return;
  let contentType: string | undefined;
  for (const [k, v] of Object.entries(res.headers)) {
    if (k.toLowerCase() === "content-type") contentType = v;
    else if (viaGateway) ctx.setResponseHeader(`Fn-Http-H-${k}`, v);
  }
  ctx.setResponseHeader("Content-Type", contentType ?? "application/octet-stream");
  if (viaGateway) ctx.setResponseHeader("Fn-Http-Status", String(res.status));
}

/**
 * FDK entrypoint used by the generated `func.js`.
 *
 * Returns `rawResult(bytes)` when the FDK's `rawResult` is passed, otherwise the
 * rendered `{status, headers, body, isBase64}` (handy in tests). A failed
 * non-HTTP invocation (Events, direct invoke) throws so Fn reports the call as failed.
 */
export async function handler(input: unknown, ctx?: FdkContext, rawResult?: RawResult): Promise<unknown> {
  const fn = getEnv("NSKIT_FUNCTION") ?? ctx?.fnName ?? "";
  const body = toBytes(input);
  const viaGateway = toRequest(ctx, body) !== undefined;
  const event = toEvent(ctx, body, fn);
  const res = await runHttp(event, toContext(ctx, fn));
  if (!viaGateway && res.status >= 500) {
    throw new Error(res.isBase64 ? `function failed with status ${res.status}` : res.body);
  }
  applyResponse(ctx, res, viaGateway);
  if (!rawResult) return res;
  return rawResult(res.isBase64 ? base64Decode(res.body) : utf8Encode(res.body));
}
