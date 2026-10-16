/**
 * IBM Cloud Code Engine functions adapter (`main(params)`).
 *
 * Code Engine passes HTTP request data in reserved `__ce_*` parameters
 * (`__ce_method`, `__ce_path`, `__ce_headers`, `__ce_query`, `__ce_body`);
 * `__ow_*` from the older Cloud Functions / OpenWhisk platform is accepted too.
 * JSON request bodies are additionally "unfolded" into top-level params and
 * `__ce_body` carries them base64-encoded; binary bodies are base64, text and
 * form bodies are plain strings.
 *
 * The function returns `{statusCode, headers, body}`: a JSON object for
 * `application/json`, a string for `text/*`, base64 for every other type.
 */

import { Context } from "../context.js";
import { unwrapEnvelope } from "../envelope.js";
import { Event, EventType, HttpRequest } from "../event.js";
import { dumps, type GatewayResponse } from "../response.js";
import { base64Decode, base64Encode, getEnv, utf8DecodeStrict, utf8Encode } from "../util.js";
import { decodeBody, eventFromRequest, runHttp } from "./httpfn.js";

export const PROVIDER = "ibm";
const PREFIXES = ["__ce_", "__ow_"];

type Params = Record<string, unknown>;

function get(params: Params, key: string): unknown {
  for (const prefix of PREFIXES) if (prefix + key in params) return params[prefix + key];
  return undefined;
}

const isReserved = (key: string) => PREFIXES.some((p) => key.startsWith(p));

function parseQuery(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Params)) out[k] = Array.isArray(v) ? v.map(String) : [String(v)];
  } else if (typeof raw === "string" && raw) {
    for (const [k, v] of new URLSearchParams(raw.replace(/^\?/, ""))) (out[k] ??= []).push(v);
  }
  return out;
}

function headerValue(headers: Params, name: string): string {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return String(v ?? "");
  return "";
}

/** Base64 text that decodes to valid UTF-8, else `undefined`. */
function base64Text(text: string): Uint8Array | undefined {
  const trimmed = text.trim();
  if (!trimmed || /^[[{"]/.test(trimmed)) return undefined;
  try {
    const bytes = base64Decode(trimmed);
    return utf8DecodeStrict(bytes) === undefined ? undefined : bytes;
  } catch {
    return undefined;
  }
}

/** Decode `__ce_body` following Code Engine's per-content-type encoding. */
export function requestBody(body: unknown, headers: Params): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array();
  if (typeof body === "object") return utf8Encode(dumps(body));
  const text = String(body);
  const ctype = headerValue(headers, "content-type").split(";")[0].trim().toLowerCase();
  // JSON (also the default when no content type is sent) arrives base64-encoded.
  if (!ctype || ctype === "application/json" || ctype.endsWith("+json")) return base64Text(text) ?? utf8Encode(text);
  if (ctype.startsWith("text/") || ctype === "application/x-www-form-urlencoded") return utf8Encode(text);
  return decodeBody(text, headers, true);
}

export function toRequest(params: Params): HttpRequest | undefined {
  const method = get(params, "method");
  if (!method || typeof method !== "string") return undefined;
  const headers = { ...((get(params, "headers") as Params | undefined) ?? {}) };
  const multiQuery = parseQuery(get(params, "query"));
  const raw = get(params, "body");
  let body: Uint8Array;
  if (raw !== undefined && raw !== null) {
    body = requestBody(raw, headers);
  } else {
    // No raw body: rebuild it from the unfolded params (query parameters are unfolded too, so skip those).
    const plain = Object.fromEntries(Object.entries(params).filter(([k]) => !isReserved(k) && !(k in multiQuery)));
    const upper = method.toUpperCase();
    body = Object.keys(plain).length && upper !== "GET" && upper !== "HEAD" ? utf8Encode(dumps(plain)) : new Uint8Array();
  }
  const forwarded = headerValue(headers, "x-forwarded-for").split(",")[0].trim();
  return new HttpRequest({
    method,
    path: (get(params, "path") as string | undefined) || "/",
    headers,
    multiQuery,
    body,
    sourceIp: forwarded || undefined,
  });
}

export function toEvent(params: Params, fn: string): Event {
  const req = toRequest(params);
  if (req) return eventFromRequest(req, PROVIDER, fn, params);
  // Direct invocation without HTTP metadata: params are the payload.
  const wrapped = unwrapEnvelope(params);
  if (wrapped) {
    const source = typeof wrapped.meta.source === "string" ? wrapped.meta.source : undefined;
    return new Event({ type: wrapped.kind, provider: PROVIDER, functionName: fn, data: wrapped.data, source, raw: params });
  }
  return new Event({ type: EventType.INVOKE, provider: PROVIDER, functionName: fn, data: params, raw: params });
}

function requestId(params: Params): string | undefined {
  const headers = (get(params, "headers") as Params | undefined) ?? {};
  return headerValue(headers, "x-request-id") || getEnv("CE_REQUEST_ID") || undefined;
}

export interface CodeEngineResult {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Shape a rendered response the way Code Engine expects for its content type. */
export function toNative(res: GatewayResponse): CodeEngineResult {
  const headers = { ...res.headers };
  const ctype = (headerValue(headers, "content-type").split(";")[0] ?? "").trim().toLowerCase();
  let body: unknown = res.body;
  if (res.body && !res.isBase64) {
    if (ctype === "application/json" || ctype.endsWith("+json")) {
      try {
        const parsed = JSON.parse(res.body);
        if (parsed !== null && typeof parsed === "object") body = parsed;
      } catch {
        /* keep the text */
      }
    } else if (ctype && !ctype.startsWith("text/")) {
      // Code Engine base64-decodes bodies of every non-text, non-JSON type.
      body = base64Encode(utf8Encode(res.body));
    }
  }
  return { statusCode: res.status, headers, body };
}

/** Code Engine entrypoint - the generated entry module re-exports this as `main`. */
export async function main(params?: Params | null): Promise<CodeEngineResult> {
  const p = params ?? {};
  const fn = getEnv("NSKIT_FUNCTION") ?? getEnv("CE_FUNCTION", "")!;
  const event = toEvent(p, fn);
  const context = new Context({ requestId: requestId(p), functionName: fn, provider: PROVIDER, raw: p });
  return toNative(await runHttp(event, context));
}
