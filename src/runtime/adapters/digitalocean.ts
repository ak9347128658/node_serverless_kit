/**
 * DigitalOcean Functions adapter (`main(event, context)`).
 *
 * Web functions deployed with `web: raw` receive `event.http` with `method`,
 * `path`, `headers`, `queryString`, `body` and `isBase64Encoded`. With
 * `web: true` the body / query parameters are merged into the event instead.
 * Scheduled triggers deliver their `withBody` payload as the event, which nskit
 * fills with the `__nskit` envelope.
 *
 * The function returns `{statusCode, headers, body}`; binary bodies are base64.
 */

import { Context } from "../context.js";
import { unwrapEnvelope } from "../envelope.js";
import { Event, EventType, HttpRequest } from "../event.js";
import { dumps } from "../response.js";
import { getEnv, utf8Encode } from "../util.js";
import { decodeBody, eventFromRequest, runHttp } from "./httpfn.js";

export const PROVIDER = "digitalocean";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

/** The DigitalOcean Functions `context` argument. */
export interface DoContext {
  activationId?: string;
  requestId?: string;
  functionName?: string;
  deadline?: number;
  getRemainingTimeInMillis?: () => number;
}

export function toRequest(event: Obj): HttpRequest | undefined {
  const http = event.http;
  if (!http || typeof http !== "object" || !obj(http).method) return undefined;
  const h = obj(http);
  const headers = obj(h.headers);
  let body: Uint8Array;
  if (h.body !== undefined && h.body !== null) {
    body = decodeBody(h.body, headers, typeof h.isBase64Encoded === "boolean" ? h.isBase64Encoded : undefined);
  } else {
    // `web: true` (non-raw) merges body params into the event.
    const plain = Object.fromEntries(Object.entries(event).filter(([k]) => k !== "http" && !k.startsWith("__ow_")));
    body = Object.keys(plain).length ? utf8Encode(dumps(plain)) : new Uint8Array();
  }
  const multiQuery: Record<string, string[]> = {};
  for (const [k, v] of new URLSearchParams(String(h.queryString ?? "").replace(/^\?/, ""))) (multiQuery[k] ??= []).push(v);
  let forwarded = "";
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === "x-forwarded-for") forwarded = String(v).split(",")[0].trim();
  return new HttpRequest({
    method: String(h.method),
    path: typeof h.path === "string" && h.path ? h.path : "/",
    headers,
    multiQuery,
    body,
    sourceIp: forwarded || undefined,
  });
}

export function toEvent(event: Obj, fn: string): Event {
  const req = toRequest(event);
  if (req) return eventFromRequest(req, PROVIDER, fn, event);
  const wrapped = unwrapEnvelope(event);
  if (wrapped) {
    const source = typeof wrapped.meta.source === "string" ? wrapped.meta.source : undefined;
    return new Event({ type: wrapped.kind, provider: PROVIDER, functionName: fn, data: wrapped.data, source, raw: event });
  }
  return new Event({ type: EventType.INVOKE, provider: PROVIDER, functionName: fn, data: event, raw: event });
}

export function toContext(ctx: DoContext | undefined, functionName: string): Context {
  const remaining = typeof ctx?.getRemainingTimeInMillis === "function" ? ctx.getRemainingTimeInMillis.bind(ctx) : undefined;
  let deadline: number | undefined;
  if (remaining) deadline = Date.now() + remaining();
  else if (typeof ctx?.deadline === "number") deadline = ctx.deadline;
  return new Context({
    requestId: ctx?.activationId || ctx?.requestId || undefined,
    functionName,
    provider: PROVIDER,
    deadline,
    remainingTimeMs: remaining,
    raw: ctx,
  });
}

export interface DoResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** DigitalOcean entrypoint - the generated entry module re-exports this as `main`. */
export async function main(event?: Obj | null, context?: DoContext): Promise<DoResult> {
  const evt = event ?? {};
  const fn = getEnv("NSKIT_FUNCTION", "")!;
  const res = await runHttp(toEvent(evt, fn), toContext(context, fn));
  return { statusCode: res.status, headers: res.headers, body: res.body };
}
