/**
 * The `__nskit` envelope.
 *
 * Payloads node-serverless-kit itself produces (schedule inputs, workflow
 * tasks, `invoke()` calls) are wrapped as `{"__nskit": "<kind>", "data": ...}`
 * so adapters on HTTP-only clouds (GCP, IBM, DigitalOcean, Cloudflare, Oracle)
 * can recover the real event type.
 */

import { EVENT_TYPES, EventType } from "./event.js";
import { maybeJson } from "./util.js";

export const ENVELOPE_KEY = "__nskit";

export interface Envelope {
  [ENVELOPE_KEY]: string;
  data: unknown;
  [meta: string]: unknown;
}

export function envelope(kind: string, data?: unknown, meta: Record<string, unknown> = {}): Envelope {
  return { [ENVELOPE_KEY]: kind, data: data ?? null, ...meta };
}

export interface Unwrapped {
  kind: EventType;
  data: unknown;
  meta: Record<string, unknown>;
}

export function unwrapEnvelope(value: unknown): Unwrapped | undefined {
  const obj = typeof value === "string" || value instanceof Uint8Array ? maybeJson(value) : value;
  if (obj && typeof obj === "object" && !Array.isArray(obj) && ENVELOPE_KEY in obj) {
    const record = obj as Record<string, unknown>;
    const rawKind = String(record[ENVELOPE_KEY]);
    const kind = (EVENT_TYPES as readonly string[]).includes(rawKind) ? (rawKind as EventType) : EventType.INVOKE;
    const meta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) if (k !== ENVELOPE_KEY && k !== "data") meta[k] = v;
    return { kind, data: record.data, meta };
  }
  return undefined;
}

/** Map provider-specific object event names to `created` / `deleted`. */
export function actionFrom(name: string | undefined): "created" | "deleted" {
  const lowered = (name ?? "").toLowerCase();
  return ["delete", "remove", "archive"].some((w) => lowered.includes(w)) ? "deleted" : "created";
}

/** First key of `obj` whose value is neither undefined nor null. */
export function first<T = unknown>(obj: Record<string, unknown> | undefined | null, ...keys: string[]): T | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const v = obj[key];
    if (v !== undefined && v !== null) return v as T;
  }
  return undefined;
}
