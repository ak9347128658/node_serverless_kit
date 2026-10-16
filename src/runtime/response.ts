/** Provider-neutral HTTP response model. */

import { base64Decode, base64Encode, isPlainObject, toBytes, utf8DecodeStrict, utf8Encode } from "./util.js";

const TEXT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-www-form-urlencoded",
  "image/svg+xml",
]);

export function isTextContentType(contentType: string): boolean {
  const ct = contentType.split(";")[0].trim().toLowerCase();
  return ct.startsWith("text/") || TEXT_TYPES.has(ct) || ct.endsWith("+json") || ct.endsWith("+xml");
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  if (value instanceof Uint8Array) return utf8DecodeStrict(value) ?? base64Encode(value);
  return value;
}

/** JSON.stringify that also handles bigint, Map, Set and bytes. */
export function dumps(value: unknown): string {
  const out = JSON.stringify(value, jsonReplacer);
  return out === undefined ? "null" : out;
}

export interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  path?: string;
  domain?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface RenderedResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface GatewayResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  isBase64: boolean;
}

export class HttpResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  cookies: string[];

  constructor(status = 200, body: unknown = undefined, headers: Record<string, string> = {}, cookies: string[] = []) {
    this.status = status;
    this.body = body;
    this.headers = { ...headers };
    this.cookies = [...cookies];
  }

  // ---- constructors -------------------------------------------------
  static json(data: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse {
    return new HttpResponse(status, dumps(data), { "content-type": "application/json", ...headers });
  }

  static text(text: string, status = 200, headers: Record<string, string> = {}): HttpResponse {
    return new HttpResponse(status, text, { "content-type": "text/plain; charset=utf-8", ...headers });
  }

  static html(html: string, status = 200, headers: Record<string, string> = {}): HttpResponse {
    return new HttpResponse(status, html, { "content-type": "text/html; charset=utf-8", ...headers });
  }

  static binary(
    data: Uint8Array | ArrayBuffer,
    contentType = "application/octet-stream",
    status = 200,
    headers: Record<string, string> = {},
  ): HttpResponse {
    return new HttpResponse(status, toBytes(data), { "content-type": contentType, ...headers });
  }

  static redirect(location: string, status = 302): HttpResponse {
    return new HttpResponse(status, "", { location });
  }

  static noContent(): HttpResponse {
    return new HttpResponse(204, "");
  }

  // ---- helpers ------------------------------------------------------
  setHeader(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  setCookie(name: string, value: string, options: CookieOptions = {}): this {
    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? "/"}`];
    parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
    if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
    if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
    if (options.domain) parts.push(`Domain=${options.domain}`);
    if (options.httpOnly ?? true) parts.push("HttpOnly");
    if (options.secure ?? true) parts.push("Secure");
    this.cookies.push(parts.join("; "));
    return this;
  }

  get contentType(): string {
    for (const [k, v] of Object.entries(this.headers)) if (k.toLowerCase() === "content-type") return v;
    return "";
  }

  /**
   * `{status, headers, body}` with lower-cased header names and a content-type
   * guaranteed to be set when there is a body.
   */
  render(): RenderedResponse {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.headers)) headers[k.toLowerCase()] = String(v);
    const body = this.body;
    let raw: Uint8Array;
    if (body === undefined || body === null) {
      raw = new Uint8Array();
    } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
      raw = toBytes(body);
      if (raw.length) headers["content-type"] ??= "application/octet-stream";
    } else if (typeof body === "string") {
      raw = utf8Encode(body);
      if (raw.length) headers["content-type"] ??= "text/plain; charset=utf-8";
    } else {
      raw = utf8Encode(dumps(body));
      headers["content-type"] ??= "application/json";
    }
    return { status: Math.trunc(this.status), headers, body: raw };
  }

  /**
   * Like {@link render} but with a string body plus an `isBase64` flag, which is
   * what API-gateway style integrations expect.
   */
  renderForGateway(): GatewayResponse {
    const { status, headers, body } = this.render();
    if (!body.length) return { status, headers, body: "", isBase64: false };
    if (isTextContentType(headers["content-type"] ?? "")) {
      const text = utf8DecodeStrict(body);
      if (text !== undefined) return { status, headers, body: text, isBase64: false };
    }
    return { status, headers, body: base64Encode(body), isBase64: true };
  }
}

const LAMBDA_RESPONSE_KEYS = new Set(["statusCode", "body", "headers", "multiValueHeaders", "isBase64Encoded", "cookies"]);

/** `{statusCode, body?, headers?, ...}` - an AWS-Lambda-proxy style result, accepted to ease migration. */
function isLambdaProxyResult(value: Record<string, unknown>): boolean {
  return typeof value.statusCode === "number" && Object.keys(value).every((k) => LAMBDA_RESPONSE_KEYS.has(k));
}

export function isHttpResponse(value: unknown): value is HttpResponse {
  return (
    value instanceof HttpResponse ||
    (typeof value === "object" &&
      value !== null &&
      typeof (value as HttpResponse).render === "function" &&
      typeof (value as HttpResponse).renderForGateway === "function" &&
      typeof (value as HttpResponse).status === "number")
  );
}

/**
 * Coerce whatever a handler returned into an {@link HttpResponse}:
 *
 * - `HttpResponse` -> unchanged
 * - `undefined` / `null` -> 204 No Content
 * - string -> text/plain 200
 * - `Uint8Array` / `ArrayBuffer` -> application/octet-stream 200
 * - `{statusCode, body, headers}` (AWS Lambda proxy shape) -> that response
 * - anything else -> JSON 200
 *
 * A WHATWG `Response` is handled by {@link toResponseAsync}.
 */
export function toResponse(result: unknown): HttpResponse {
  if (isHttpResponse(result)) return result;
  if (result === undefined || result === null) return HttpResponse.noContent();
  if (typeof result === "string") return HttpResponse.text(result);
  if (result instanceof Uint8Array || result instanceof ArrayBuffer) return HttpResponse.binary(result);
  if (isPlainObject(result) && isLambdaProxyResult(result)) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((result.headers as Record<string, unknown>) ?? {})) headers[k] = String(v);
    const cookies: string[] = Array.isArray(result.cookies) ? result.cookies.map(String) : [];
    const multi = result.multiValueHeaders as Record<string, unknown[]> | undefined;
    for (const [k, values] of Object.entries(multi ?? {})) {
      if (k.toLowerCase() === "set-cookie") cookies.push(...values.map(String));
      else headers[k] = values.map(String).join(", ");
    }
    let body: unknown = result.body ?? "";
    if (result.isBase64Encoded && typeof body === "string") {
      body = base64Decode(body);
    } else if (typeof body !== "string") {
      body = dumps(body);
    }
    return new HttpResponse(result.statusCode as number, body, headers, cookies);
  }
  return HttpResponse.json(result);
}

interface FetchResponseLike {
  status: number;
  headers: { forEach(cb: (value: string, key: string) => void): void; getSetCookie?: () => string[] };
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isFetchResponse(value: unknown): value is FetchResponseLike {
  const R = (globalThis as { Response?: new (...args: never[]) => unknown }).Response;
  return R !== undefined && value instanceof R;
}

/** {@link toResponse} plus support for returning a WHATWG `Response` from a handler. */
export async function toResponseAsync(result: unknown): Promise<HttpResponse> {
  if (isFetchResponse(result)) {
    const headers: Record<string, string> = {};
    result.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "set-cookie") headers[key] = value;
    });
    const cookies = result.headers.getSetCookie ? result.headers.getSetCookie() : [];
    const body = new Uint8Array(await result.arrayBuffer());
    return new HttpResponse(result.status, body, headers, cookies);
  }
  return toResponse(result);
}
