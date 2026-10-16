/**
 * Provider-neutral event model.
 *
 * Every provider adapter converts its native payload into an {@link Event}, so a
 * handler written against this module runs unchanged on any supported cloud.
 */

import { BadRequest } from "./errors.js";
import { base64Decode, isPlainObject, toBytes, utf8Decode, utf8Encode } from "./util.js";

export const EventType = {
  HTTP: "http",
  SCHEDULE: "schedule",
  QUEUE: "queue",
  STORAGE: "storage",
  TOPIC: "topic",
  INVOKE: "invoke",
  WORKFLOW: "workflow",
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];
export const EVENT_TYPES: readonly EventType[] = Object.values(EventType);

const NO_DEFAULT: unique symbol = Symbol("no-default");
type NoDefault = typeof NO_DEFAULT;

/**
 * Case-insensitive, read-only header map. Multi-value headers are joined with
 * `", "` (RFC 9110 section 5.3).
 */
export class Headers implements Iterable<[string, string]> {
  private readonly data = new Map<string, string>();

  constructor(raw?: Record<string, unknown> | Iterable<[string, unknown]> | Headers | null) {
    if (!raw) return;
    const entries: Iterable<[string, unknown]> =
      raw instanceof Headers
        ? raw.entries()
        : Symbol.iterator in Object(raw) && !isPlainObject(raw)
          ? (raw as Iterable<[string, unknown]>)
          : Object.entries(raw as Record<string, unknown>);
    for (const [key, value] of entries) {
      if (value === undefined || value === null) continue;
      const text = Array.isArray(value) ? value.map(String).join(", ") : String(value);
      const k = String(key).toLowerCase();
      const prev = this.data.get(k);
      this.data.set(k, prev !== undefined ? `${prev}, ${text}` : text);
    }
  }

  get(name: string): string | undefined;
  get(name: string, fallback: string): string;
  get(name: string, fallback?: string): string | undefined {
    return this.data.get(name.toLowerCase()) ?? fallback;
  }

  has(name: string): boolean {
    return this.data.has(name.toLowerCase());
  }

  get size(): number {
    return this.data.size;
  }

  keys(): IterableIterator<string> {
    return this.data.keys();
  }

  entries(): IterableIterator<[string, string]> {
    return this.data.entries();
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.data.entries();
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.data);
  }

  toObject(): Record<string, string> {
    return Object.fromEntries(this.data);
  }
}

function decodeJson(raw: string, what: string): unknown {
  if (raw === "") throw new BadRequest(`${what} is empty, expected JSON`);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new BadRequest(`${what} is not valid JSON`, { details: (err as Error).message });
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    const name = idx > 0 ? part.slice(0, idx).trim() : "";
    if (name) {
      let value = part.slice(idx + 1).trim();
      try {
        value = decodeURIComponent(value);
      } catch {
        /* keep the raw value */
      }
      cookies[name] = value;
    }
  }
  return cookies;
}

export interface HttpRequestInit {
  method?: string;
  path?: string;
  headers?: Record<string, unknown> | Iterable<[string, unknown]> | Headers | null;
  query?: Record<string, string>;
  multiQuery?: Record<string, string[]>;
  pathParams?: Record<string, string>;
  body?: Uint8Array | string | null;
  sourceIp?: string;
  route?: string;
}

export class HttpRequest {
  method: string;
  path: string;
  headers: Headers;
  query: Record<string, string>;
  multiQuery: Record<string, string[]>;
  pathParams: Record<string, string>;
  body: Uint8Array;
  sourceIp?: string;
  /** The route pattern that matched, e.g. `/orders/{id}`. */
  route?: string;

  constructor(init: HttpRequestInit = {}) {
    this.method = (init.method ?? "GET").toUpperCase();
    this.path = init.path || "/";
    this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
    this.query = { ...(init.query ?? {}) };
    this.multiQuery = init.multiQuery
      ? { ...init.multiQuery }
      : Object.fromEntries(Object.entries(this.query).map(([k, v]) => [k, [v]]));
    if (!init.query && init.multiQuery) {
      for (const [k, v] of Object.entries(init.multiQuery)) if (v.length) this.query[k] = v[v.length - 1];
    }
    this.pathParams = { ...(init.pathParams ?? {}) };
    this.body = typeof init.body === "string" ? utf8Encode(init.body) : (init.body ?? new Uint8Array());
    this.sourceIp = init.sourceIp;
    this.route = init.route;
  }

  /** Lower-cased media type without parameters, e.g. `application/json`. */
  get contentType(): string {
    return (this.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  }

  get cookies(): Record<string, string> {
    return parseCookies(this.headers.get("cookie"));
  }

  text(): string {
    return utf8Decode(this.body);
  }

  /**
   * Parse the body as JSON. Throws {@link BadRequest} (HTTP 400) on bad input
   * unless a `fallback` is given.
   */
  json<T = unknown>(): T;
  json<T = unknown>(fallback: T): T;
  json<T = unknown>(fallback: T | NoDefault = NO_DEFAULT): T {
    try {
      return decodeJson(this.text(), "Request body") as T;
    } catch (err) {
      if (fallback !== NO_DEFAULT) return fallback;
      throw err;
    }
  }

  /** Parse an `application/x-www-form-urlencoded` body. */
  form(): Record<string, string> {
    return Object.fromEntries(new URLSearchParams(this.text()));
  }

  /** Decode a gateway body (possibly base64) into bytes. */
  static decodeBody(body: unknown, isBase64 = false): Uint8Array {
    if (body === undefined || body === null) return new Uint8Array();
    if (typeof body === "string") return isBase64 ? base64Decode(body) : utf8Encode(body);
    if (body instanceof Uint8Array) return isBase64 ? base64Decode(utf8Decode(body)) : body;
    return toBytes(body);
  }
}

export interface EventRecordInit {
  id?: string;
  body?: unknown;
  attributes?: Record<string, unknown>;
  source?: string;
  bucket?: string;
  key?: string;
  size?: number;
  action?: "created" | "deleted";
  raw?: unknown;
}

/** One message or object notification inside a batch event. */
export class EventRecord {
  id?: string;
  body: unknown;
  attributes: Record<string, unknown>;
  source?: string;
  /** Storage events only. */
  bucket?: string;
  key?: string;
  size?: number;
  action?: "created" | "deleted";
  raw: unknown;

  constructor(init: EventRecordInit = {}) {
    this.id = init.id;
    this.body = init.body;
    this.attributes = { ...(init.attributes ?? {}) };
    this.source = init.source;
    this.bucket = init.bucket;
    this.key = init.key;
    this.size = init.size;
    this.action = init.action;
    this.raw = init.raw;
  }

  text(): string {
    const body = this.body;
    if (body === undefined || body === null) return "";
    if (body instanceof Uint8Array) return utf8Decode(body);
    if (typeof body === "object") return JSON.stringify(body);
    return String(body);
  }

  json<T = unknown>(): T;
  json<T = unknown>(fallback: T): T;
  json<T = unknown>(fallback: T | NoDefault = NO_DEFAULT): T {
    if (this.body !== null && typeof this.body === "object" && !(this.body instanceof Uint8Array)) {
      return this.body as T;
    }
    try {
      return decodeJson(this.text(), this.id ? `Record ${this.id} body` : "Record body") as T;
    } catch (err) {
      if (fallback !== NO_DEFAULT) return fallback;
      throw err;
    }
  }
}

export interface EventInit {
  type: EventType;
  provider?: string;
  functionName?: string;
  http?: HttpRequest;
  records?: EventRecord[];
  data?: unknown;
  time?: Date;
  source?: string;
  raw?: unknown;
}

export class Event implements Iterable<EventRecord> {
  type: EventType;
  provider: string;
  functionName: string;
  http?: HttpRequest;
  records: EventRecord[];
  data: unknown;
  time: Date;
  source?: string;
  /** The untouched native payload, for provider-specific needs. */
  raw: unknown;

  constructor(init: EventInit) {
    this.type = init.type;
    this.provider = init.provider ?? "local";
    this.functionName = init.functionName ?? "";
    this.http = init.http;
    this.records = init.records ?? [];
    this.data = init.data;
    this.time = init.time ?? new Date();
    this.source = init.source;
    this.raw = init.raw;
  }

  get isHttp(): boolean {
    return this.type === EventType.HTTP;
  }

  get isBatch(): boolean {
    return this.type === EventType.QUEUE || this.type === EventType.TOPIC || this.type === EventType.STORAGE;
  }

  /**
   * Best-effort JSON payload regardless of event type:
   * HTTP: the parsed request body; queue/topic/storage: the first record's
   * body; schedule/invoke/workflow: `data`.
   */
  json<T = unknown>(): T;
  json<T = unknown>(fallback: T): T;
  json<T = unknown>(fallback: T | NoDefault = NO_DEFAULT): T {
    if (this.http) return fallback === NO_DEFAULT ? this.http.json<T>() : this.http.json<T>(fallback);
    if (this.records.length) {
      const first = this.records[0];
      return fallback === NO_DEFAULT ? first.json<T>() : first.json<T>(fallback);
    }
    return this.data as T;
  }

  [Symbol.iterator](): Iterator<EventRecord> {
    return this.records[Symbol.iterator]();
  }

  /** JSON-friendly summary, handy for logging. */
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      type: this.type,
      provider: this.provider,
      functionName: this.functionName,
      time: this.time.toISOString(),
      source: this.source,
    };
    if (this.http) {
      out.http = {
        method: this.http.method,
        path: this.http.path,
        query: this.http.query,
        pathParams: this.http.pathParams,
      };
    }
    if (this.records.length) out.records = this.records.length;
    if (this.data !== undefined) out.data = this.data;
    return out;
  }
}

/** Parse the many timestamp shapes providers emit; fall back to now. */
export function parseTime(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value > 1e11 ? value : value * 1000);
  }
  if (typeof value === "string" && value.trim()) {
    const text = value.trim();
    if (/^\d+$/.test(text)) return parseTime(Number(text));
    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) return new Date(parsed);
  }
  return new Date();
}
