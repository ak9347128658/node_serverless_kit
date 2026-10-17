/**
 * Minimal HS256 JWT verification with WebCrypto (`crypto.subtle`).
 *
 * WebCrypto exists on Node.js 18+ and in V8 isolates (Cloudflare Workers), so this
 * runs unchanged on every cloud - no `node:crypto`, no npm dependency. For RS256 /
 * JWKS tokens from an identity provider use a library such as `jose`, or the API
 * gateway's JWT authorizer on AWS (`auth: jwt`).
 */

import { Unauthorized } from "node_serverless_kit";

export interface JwtClaims {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  [claim: string]: unknown;
}

export interface VerifyOptions {
  issuer?: string;
  audience?: string;
  /** Seconds since the epoch; defaults to now. */
  now?: number;
  /** Allowed clock skew in seconds. */
  leeway?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlDecode(segment: string): Uint8Array<ArrayBuffer> {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson<T>(segment: string): T {
  try {
    return JSON.parse(decoder.decode(base64UrlDecode(segment))) as T;
  } catch {
    throw new Unauthorized("malformed token");
  }
}

const keys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    keys.set(secret, key);
  }
  return key;
}

/** Verify an HS256 token and return its claims; throws {@link Unauthorized} (HTTP 401) otherwise. */
export async function verifyHs256(token: string, secret: string, options: VerifyOptions = {}): Promise<JwtClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Unauthorized("malformed token");
  const [headerB64, payloadB64, signatureB64] = parts;
  const header = decodeJson<{ alg?: string }>(headerB64);
  if (header.alg !== "HS256") throw new Unauthorized(`unsupported token algorithm ${String(header.alg)}`);
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = base64UrlDecode(signatureB64);
  } catch {
    throw new Unauthorized("malformed token");
  }
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), signature, encoder.encode(`${headerB64}.${payloadB64}`));
  if (!valid) throw new Unauthorized("invalid token signature");

  const claims = decodeJson<JwtClaims>(payloadB64);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const leeway = options.leeway ?? 30;
  if (typeof claims.exp === "number" && now > claims.exp + leeway) throw new Unauthorized("token expired");
  if (typeof claims.nbf === "number" && now + leeway < claims.nbf) throw new Unauthorized("token not yet valid");
  if (options.issuer && claims.iss !== options.issuer) throw new Unauthorized("unexpected token issuer");
  if (options.audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(options.audience)) throw new Unauthorized("unexpected token audience");
  }
  return claims;
}

/** `Authorization: Bearer <token>` -> token, or a 401 with a `WWW-Authenticate` challenge. */
export function bearerToken(authorization: string | undefined): string {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!match) throw new Unauthorized("missing bearer token", { headers: { "www-authenticate": 'Bearer realm="books-api"' } });
  return match[1];
}
