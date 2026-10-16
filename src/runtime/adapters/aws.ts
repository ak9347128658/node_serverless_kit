/**
 * AWS Lambda adapter.
 *
 * Handles API Gateway HTTP API (payload v2), REST API / ALB (payload v1),
 * Lambda Function URLs, SQS, SNS, S3, EventBridge, Step Functions and direct
 * invocation.
 */

import { isBatchResult } from "../batch.js";
import { Context } from "../context.js";
import { execute } from "../dispatch.js";
import { actionFrom, unwrapEnvelope } from "../envelope.js";
import { Event, EventRecord, EventType, HttpRequest, parseTime } from "../event.js";
import type { HttpResponse } from "../response.js";
import { getEnv, maybeJson } from "../util.js";

export const PROVIDER = "aws";
type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function decodeKey(key: string): string {
  try {
    return decodeURIComponent(key.replace(/\+/g, " "));
  } catch {
    return key;
  }
}

function httpV2(evt: Obj): HttpRequest {
  const http = obj(obj(evt.requestContext).http);
  const headers: Obj = { ...obj(evt.headers) };
  if (Array.isArray(evt.cookies) && evt.cookies.length) headers.cookie = evt.cookies.join("; ");
  const query = Object.fromEntries(Object.entries(obj(evt.queryStringParameters)).map(([k, v]) => [k, String(v)]));
  const multiQuery = Object.fromEntries(Object.entries(query).map(([k, v]) => [k, v.split(",")]));
  const routeKey = str(evt.routeKey) ?? "";
  return new HttpRequest({
    method: str(http.method) ?? "GET",
    path: str(evt.rawPath) || str(http.path) || "/",
    headers,
    query,
    multiQuery,
    pathParams: obj(evt.pathParameters) as Record<string, string>,
    body: HttpRequest.decodeBody(evt.body, Boolean(evt.isBase64Encoded)),
    sourceIp: str(http.sourceIp),
    route: routeKey.includes(" ") ? routeKey.split(" ").slice(1).join(" ") : undefined,
  });
}

function httpV1(evt: Obj): HttpRequest {
  const rc = obj(evt.requestContext);
  const multiHeaders = obj(evt.multiValueHeaders);
  const headers = Object.keys(multiHeaders).length ? multiHeaders : obj(evt.headers);
  const multiQuery = Object.fromEntries(
    Object.entries(obj(evt.multiValueQueryStringParameters)).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : [String(v)]]),
  );
  let query = Object.fromEntries(Object.entries(obj(evt.queryStringParameters)).map(([k, v]) => [k, String(v)]));
  if (!Object.keys(query).length && Object.keys(multiQuery).length) {
    query = Object.fromEntries(Object.entries(multiQuery).map(([k, v]) => [k, v[v.length - 1]]));
  }
  return new HttpRequest({
    method: str(evt.httpMethod) ?? "GET",
    path: str(evt.path) || "/",
    headers,
    query,
    multiQuery: Object.keys(multiQuery).length ? multiQuery : Object.fromEntries(Object.entries(query).map(([k, v]) => [k, [v]])),
    pathParams: obj(evt.pathParameters) as Record<string, string>,
    body: HttpRequest.decodeBody(evt.body, Boolean(evt.isBase64Encoded)),
    sourceIp: str(obj(rc.identity).sourceIp),
    route: str(evt.resource),
  });
}

function recordsEvent(evt: Obj): Event | undefined {
  const records = evt.Records;
  if (!Array.isArray(records) || !records.length) return undefined;
  const first = obj(records[0]);
  const source = str(first.eventSource) ?? str(first.EventSource) ?? "";
  if (source === "aws:sqs") {
    return new Event({
      type: EventType.QUEUE,
      provider: PROVIDER,
      source: str(first.eventSourceARN),
      raw: evt,
      records: records.map((r: Obj) => {
        const attrs: Obj = { ...obj(r.attributes) };
        for (const [k, v] of Object.entries(obj(r.messageAttributes))) attrs[k] = obj(v).stringValue;
        return new EventRecord({ id: str(r.messageId), body: r.body, attributes: attrs, source: str(r.eventSourceARN), raw: r });
      }),
    });
  }
  if (source === "aws:sns") {
    const firstSns = obj(first.Sns);
    return new Event({
      type: EventType.TOPIC,
      provider: PROVIDER,
      source: str(firstSns.TopicArn),
      time: parseTime(firstSns.Timestamp),
      raw: evt,
      records: records.map((r: Obj) => {
        const sns = obj(r.Sns);
        const attrs = Object.fromEntries(Object.entries(obj(sns.MessageAttributes)).map(([k, v]) => [k, obj(v).Value]));
        return new EventRecord({ id: str(sns.MessageId), body: sns.Message, attributes: attrs, source: str(sns.TopicArn), raw: r });
      }),
    });
  }
  if (source === "aws:s3") {
    return new Event({
      type: EventType.STORAGE,
      provider: PROVIDER,
      source: "aws:s3",
      time: parseTime(first.eventTime),
      raw: evt,
      records: records.map((r: Obj) => {
        const s3 = obj(r.s3);
        const o = obj(s3.object);
        return new EventRecord({
          id: str(o.sequencer),
          bucket: str(obj(s3.bucket).name),
          key: decodeKey(str(o.key) ?? ""),
          size: typeof o.size === "number" ? o.size : undefined,
          action: actionFrom(str(r.eventName)),
          attributes: { etag: o.eTag, eventName: r.eventName },
          source: "aws:s3",
          raw: r,
        });
      }),
    });
  }
  return undefined;
}

export function toEvent(evt: unknown, ctx?: { functionName?: string }): Event {
  const fn = getEnv("NSKIT_FUNCTION") ?? ctx?.functionName ?? "";
  const wrapped = unwrapEnvelope(evt);
  if (wrapped) {
    return new Event({ type: wrapped.kind, provider: PROVIDER, functionName: fn, data: wrapped.data, source: str(wrapped.meta.source), raw: evt });
  }
  if (evt && typeof evt === "object" && !Array.isArray(evt)) {
    const e = evt as Obj;
    const rc = e.requestContext;
    if (rc && typeof rc === "object" && obj(rc).http && typeof obj(rc).http === "object") {
      return new Event({ type: EventType.HTTP, provider: PROVIDER, functionName: fn, http: httpV2(e), raw: evt });
    }
    if ("httpMethod" in e) return new Event({ type: EventType.HTTP, provider: PROVIDER, functionName: fn, http: httpV1(e), raw: evt });
    const batch = recordsEvent(e);
    if (batch) {
      batch.functionName = fn;
      return batch;
    }
    if (e.source === "aws.events" || e["detail-type"] === "Scheduled Event") {
      return new Event({
        type: EventType.SCHEDULE,
        provider: PROVIDER,
        functionName: fn,
        data: e.detail,
        time: parseTime(e.time),
        source: str(e.source),
        raw: evt,
      });
    }
  }
  return new Event({ type: EventType.INVOKE, provider: PROVIDER, functionName: fn, data: maybeJson(evt), raw: evt });
}

interface LambdaContext {
  awsRequestId?: string;
  functionName?: string;
  memoryLimitInMB?: string | number;
  getRemainingTimeInMillis?: () => number;
  callbackWaitsForEmptyEventLoop?: boolean;
}

export function toContext(ctx: LambdaContext | undefined, functionName: string): Context {
  if (!ctx) return new Context({ functionName, provider: PROVIDER });
  const remaining = typeof ctx.getRemainingTimeInMillis === "function" ? ctx.getRemainingTimeInMillis.bind(ctx) : undefined;
  return new Context({
    requestId: ctx.awsRequestId,
    functionName,
    provider: PROVIDER,
    memoryMb: ctx.memoryLimitInMB ? Number(ctx.memoryLimitInMB) : undefined,
    deadline: remaining ? Date.now() + remaining() : undefined,
    remainingTimeMs: remaining,
    raw: ctx,
  });
}

export function toNative(result: unknown, event: Event): unknown {
  if (event.http) {
    const resp = result as HttpResponse;
    const { status, headers, body, isBase64 } = resp.renderForGateway();
    const out: Obj = { statusCode: status, headers, body, isBase64Encoded: isBase64 };
    if (resp.cookies.length) {
      if (obj(event.raw).version === "2.0") out.cookies = [...resp.cookies];
      else out.multiValueHeaders = { "set-cookie": [...resp.cookies] };
    }
    return out;
  }
  if (isBatchResult(result)) return { batchItemFailures: result.failed.map((id) => ({ itemIdentifier: id })) };
  return result;
}

/** Lambda entrypoint - the generated entry module re-exports this as `handler`. */
export async function handler(evt: unknown, ctx?: LambdaContext): Promise<unknown> {
  const event = toEvent(evt, ctx);
  const context = toContext(ctx, event.functionName);
  const result = await execute(event, context);
  return toNative(result, event);
}

