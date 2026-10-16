/**
 * Shared logic for providers where every invocation arrives as an HTTP-ish
 * request (GCP HTTP functions, IBM Code Engine, DigitalOcean web functions,
 * Cloudflare Workers, OCI behind API Gateway).
 *
 * A request whose JSON body carries the `__nskit` envelope is treated as a
 * non-HTTP event (`invoke()`, workflow task, scheduler with input): the handler
 * result is returned as JSON 200, and failures as JSON 500
 * `{"errorType", "cause"}`.
 */

import { Context } from "../context.js";
import { execute } from "../dispatch.js";
import { unwrapEnvelope } from "../envelope.js";
import { errorMessage, errorName } from "../errors.js";
import { Event, EventType, HttpRequest } from "../event.js";
import { dumps, isHttpResponse, type GatewayResponse } from "../response.js";
import { base64Decode, toBytes, utf8Encode } from "../util.js";

export function eventFromRequest(req: HttpRequest, provider: string, functionName: string, raw?: unknown): Event {
  if (req.method === "POST" && req.body[0] === 0x7b /* "{" */) {
    const wrapped = unwrapEnvelope(req.body);
    if (wrapped) {
      return new Event({
        type: wrapped.kind,
        provider,
        functionName,
        data: wrapped.data,
        source: wrapped.meta.source as string | undefined,
        raw,
      });
    }
  }
  return new Event({ type: EventType.HTTP, provider, functionName, http: req, raw });
}

export function errorBody(err: unknown): { errorType: string; cause: string } {
  return { errorType: errorName(err), cause: errorMessage(err) };
}

const JSON_HEADERS = { "content-type": "application/json" };

export function resultToHttp(result: unknown): GatewayResponse {
  if (isHttpResponse(result)) return result.renderForGateway();
  return { status: 200, headers: { ...JSON_HEADERS }, body: result === undefined ? "null" : dumps(result), isBase64: false };
}

/** Execute and always return an HTTP-shaped result. */
export async function runHttp(event: Event, context: Context): Promise<GatewayResponse> {
  if (event.http) return resultToHttp(await execute(event, context));
  try {
    return resultToHttp(await execute(event, context));
  } catch (err) {
    return { status: 500, headers: { ...JSON_HEADERS }, body: dumps(errorBody(err)), isBase64: false };
  }
}

/** Decode a body that may be base64 when the content type is binary. */
export function decodeBody(body: unknown, headers: Record<string, unknown>, isBase64?: boolean): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  if (typeof body === "object") return utf8Encode(dumps(body));
  const text = String(body);
  let b64 = isBase64;
  if (b64 === undefined) {
    let ctype = "";
    for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === "content-type") ctype = String(v).toLowerCase();
    const textual = !ctype || ctype.startsWith("text/") || /json|xml|form/.test(ctype);
    b64 = !textual;
  }
  if (b64) {
    try {
      return base64Decode(text);
    } catch {
      return toBytes(text);
    }
  }
  return utf8Encode(text);
}
