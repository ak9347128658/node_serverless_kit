/**
 * On-premises adapter.
 *
 * The supervisor (Node.js, next to the bundle) turns HTTP requests, broker
 * deliveries, schedules and direct invokes into the payload described below
 * and calls {@link handler}. Nothing in this module uses Node built-ins: the
 * same code path runs inside the deployed process and in unit tests.
 *
 * HTTP:
 * `{ http: { method, path, headers, query, body, isBase64Encoded, sourceIp } }`
 *
 * Queue / topic:
 * `{ type: "queue"|"topic", queue?, topic?, records: [{ id, body, attributes }] }`
 *
 * Storage:
 * `{ type: "storage", records: [{ id, bucket, key, size, action, eventTime }] }`
 *
 * Schedule, invoke and workflow tasks use the `__nskit` envelope.
 */

import { Context } from "../context.js";
import { execute } from "../dispatch.js";
import { unwrapEnvelope } from "../envelope.js";
import { Event, EventRecord, EventType, HttpRequest, parseTime } from "../event.js";
import { getEnv } from "../util.js";
import { eventFromRequest, runHttp } from "./httpfn.js";

export const PROVIDER = "onprem";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

export interface OnpremCall {
  functionName?: string;
  requestId?: string;
  timeoutMs?: number;
}

/** What the supervisor passes for one HTTP request. */
export interface OnpremHttp {
  method?: string;
  path?: string;
  headers?: Record<string, unknown>;
  /** Raw query string without the leading `?`. `query` is also accepted. */
  query?: string;
  queryString?: string;
  body?: unknown;
  isBase64Encoded?: boolean;
  sourceIp?: string;
}

function httpOf(raw: Obj): OnpremHttp | undefined {
  const http = raw.http;
  if (!http || typeof http !== "object") return undefined;
  return http as OnpremHttp;
}

export function toRequest(raw: Obj): HttpRequest | undefined {
  const http = httpOf(raw);
  if (!http?.method) return undefined;
  const headers = obj(http.headers);
  const queryText = String(http.queryString ?? http.query ?? "").replace(/^\?/, "");
  const multiQuery: Record<string, string[]> = {};
  for (const [key, value] of new URLSearchParams(queryText)) (multiQuery[key] ??= []).push(value);
  return new HttpRequest({
    method: String(http.method),
    path: typeof http.path === "string" && http.path ? http.path : "/",
    headers,
    multiQuery,
    body: HttpRequest.decodeBody(http.body ?? "", http.isBase64Encoded === true),
    sourceIp: http.sourceIp ? String(http.sourceIp) : undefined,
  });
}

function recordOf(raw: Obj, index: number): EventRecord {
  const attributes = obj(raw.attributes);
  const action = raw.action === "deleted" || raw.action === "created" ? raw.action : undefined;
  return new EventRecord({
    id: raw.id === undefined || raw.id === null ? String(index + 1) : String(raw.id),
    body: raw.body,
    attributes,
    bucket: raw.bucket === undefined || raw.bucket === null ? undefined : String(raw.bucket),
    key: raw.key === undefined || raw.key === null ? undefined : String(raw.key),
    size: typeof raw.size === "number" ? raw.size : undefined,
    action,
    source: raw.source === undefined || raw.source === null ? undefined : String(raw.source),
    raw,
  });
}

export function toEvent(raw: unknown, functionName: string): Event {
  const record = obj(raw);
  const request = toRequest(record);
  if (request) return eventFromRequest(request, PROVIDER, functionName, raw);

  const wrapped = unwrapEnvelope(raw);
  if (wrapped) {
    const source = typeof wrapped.meta.source === "string" ? wrapped.meta.source : undefined;
    const time = wrapped.meta.time ? parseTime(wrapped.meta.time) : undefined;
    return new Event({
      type: wrapped.kind,
      provider: PROVIDER,
      functionName,
      data: wrapped.data,
      source,
      time,
      raw,
    });
  }

  const kind = String(record.type ?? "");
  if (kind === EventType.QUEUE || kind === EventType.TOPIC || kind === EventType.STORAGE) {
    const records = Array.isArray(record.records) ? record.records.map((item, i) => recordOf(obj(item), i)) : [];
    const source =
      kind === EventType.QUEUE
        ? `onprem:queue:${String(record.queue ?? "")}`
        : kind === EventType.TOPIC
          ? `onprem:topic:${String(record.topic ?? "")}`
          : "onprem:storage";
    return new Event({ type: kind, provider: PROVIDER, functionName, records, source, raw });
  }

  return new Event({ type: EventType.INVOKE, provider: PROVIDER, functionName, data: raw ?? null, raw });
}

export function toContext(call: OnpremCall | undefined, functionName: string): Context {
  const timeout = call?.timeoutMs;
  return new Context({
    requestId: call?.requestId,
    functionName: call?.functionName || functionName,
    provider: PROVIDER,
    service: getEnv("NSKIT_SERVICE"),
    stage: getEnv("NSKIT_STAGE"),
    region: getEnv("NSKIT_REGION"),
    deadline: typeof timeout === "number" && timeout > 0 ? Date.now() + timeout : undefined,
    raw: call,
  });
}

/**
 * Entry point the supervisor calls. HTTP results are a gateway response
 * (`{status, headers, body, isBase64}`). Queue, topic and storage results are
 * returned as-is so the supervisor can ack a {@link BatchResult} per record.
 */
export async function handler(raw: unknown, call: OnpremCall = {}): Promise<unknown> {
  const functionName = call.functionName || getEnv("NSKIT_FUNCTION", "") || "";
  const event = toEvent(raw, functionName);
  const context = toContext(call, functionName);
  if (event.http) return runHttp(event, context);
  return execute(event, context);
}
