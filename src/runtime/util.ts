/**
 * Small portable helpers used by the runtime.
 *
 * The runtime is bundled into every deployment, including Cloudflare Workers,
 * so it must not depend on Node-only globals being present. `Buffer` and
 * `process` are used when they exist and replaced by web APIs otherwise.
 */

type BufferLike = {
  from(data: string | Uint8Array, encoding?: string): Uint8Array & { toString(encoding?: string): string };
};

const NodeBuffer: BufferLike | undefined = (globalThis as { Buffer?: BufferLike }).Buffer;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export function utf8Encode(text: string): Uint8Array {
  return encoder.encode(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Decode UTF-8, returning `undefined` instead of replacement characters on invalid input. */
export function utf8DecodeStrict(bytes: Uint8Array): string | undefined {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return undefined;
  }
}

export function base64Encode(bytes: Uint8Array): string {
  if (NodeBuffer) return NodeBuffer.from(bytes).toString("base64");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const B64_RE = /^[A-Za-z0-9+/_-]*={0,2}$/;

/** Decode base64 (standard or URL-safe). Throws on input that is not base64. */
export function base64Decode(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "");
  if (!B64_RE.test(clean) || clean.length % 4 === 1) throw new Error("invalid base64");
  const normalized = clean.replace(/-/g, "+").replace(/_/g, "/");
  if (NodeBuffer) return new Uint8Array(NodeBuffer.from(normalized, "base64"));
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

export function toBytes(value: unknown): Uint8Array {
  if (value === undefined || value === null) return new Uint8Array();
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") return utf8Encode(value);
  return utf8Encode(JSON.stringify(value));
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// ------------------------------------------------------------------ environment

let envOverride: Record<string, string | undefined> | undefined;

/**
 * Environment variables. On Node this is `process.env`; Cloudflare Workers pass
 * their bindings per request and the adapter installs them with {@link setEnv}.
 */
/**
 * Per-invocation environment installed by the on-premises supervisor.
 *
 * The supervisor (Node-only) stores an `AsyncLocalStorage` on this symbol.
 * `getEnv` reads it so concurrent functions in one process keep their own
 * variables. Isolates that never set the symbol are unchanged.
 */
const CALL_ENV = Symbol.for("node_serverless_kit.call-env");

function callEnv(): Record<string, string | undefined> | undefined {
  const slot = (globalThis as Record<symbol, { getStore?: () => unknown } | undefined>)[CALL_ENV];
  const store = slot && typeof slot.getStore === "function" ? slot.getStore() : undefined;
  if (store && typeof store === "object") return store as Record<string, string | undefined>;
  return undefined;
}

export function env(): Record<string, string | undefined> {
  const base = envOverride ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const frame = callEnv();
  return frame ? { ...base, ...frame } : base;
}

export function getEnv(name: string, fallback?: string): string | undefined {
  const value = env()[name];
  return value === undefined || value === "" ? fallback : value;
}

/** Merge extra variables over the process environment (used by Workers / tests). */
export function setEnv(values: Record<string, unknown> | undefined): void {
  if (!values) {
    envOverride = undefined;
    return;
  }
  const base = { ...((globalThis as { process?: { env?: Record<string, string> } }).process?.env ?? {}) };
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === "string") base[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") base[k] = String(v);
  }
  envOverride = base;
}

export function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").toLowerCase());
}

export function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** JSON.parse that returns the input unchanged when it does not look like JSON. */
export function maybeJson(value: unknown): unknown {
  let text: string | undefined;
  if (value instanceof Uint8Array) {
    text = utf8DecodeStrict(value);
    if (text === undefined) return value;
  } else if (typeof value === "string") {
    text = value;
  } else {
    return value;
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || ["null", "true", "false"].includes(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}
