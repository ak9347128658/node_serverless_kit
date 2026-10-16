/**
 * Azure Functions adapter (Node.js v4 programming model).
 *
 * One Function App hosts every function of a service. The generated entry
 * module calls {@link register} with the `app` object of `@azure/functions`
 * and a list of {@link AzureRegistration}s computed at package time; each
 * registration becomes one Azure function (`app.http`, `app.timer`,
 * `app.storageQueue`, `app.storageBlob`, `app.serviceBusTopic`) whose handler
 * converts the native input into a portable {@link Event} and dispatches it to
 * the *logical* nskit function. App settings are shared by the whole app, so
 * `NSKIT_FUNCTION` cannot be used to pick the function.
 *
 * This module never imports `@azure/functions`: the runtime must stay
 * zero-dependency (and isolate-safe), so the glue passes `app` in.
 */

import { Context } from "../context.js";
import { execute } from "../dispatch.js";
import { Event, EventRecord, EventType, HttpRequest, parseTime } from "../event.js";
import type { HttpResponse } from "../response.js";
import { toBytes } from "../util.js";
import { eventFromRequest, runHttp } from "./httpfn.js";

export const PROVIDER = "azure";
type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// ------------------------------------------------------------------ registration model

export interface AzureRegistrationBase {
  /** Azure function name (unique inside the Function App). */
  name: string;
  /** Logical nskit function name (key of the bundle manifest). */
  function: string;
}

export interface HttpRegistration extends AzureRegistrationBase {
  kind: "http";
  route: string;
  methods: string[];
  authLevel: "anonymous" | "function" | "admin";
}

export interface TimerRegistration extends AzureRegistrationBase {
  kind: "timer";
  /** NCRONTAB (6 fields, seconds first). */
  schedule: string;
  /** `input` of the schedule event, delivered as `event.data`. */
  input?: unknown;
  /** `enabled: false` schedules (the provider adds `AzureWebJobs.<name>.Disabled=true`). */
  disabled?: boolean;
}

export interface QueueRegistration extends AzureRegistrationBase {
  kind: "queue";
  queueName: string;
  connection: string;
}

export interface BlobRegistration extends AzureRegistrationBase {
  kind: "blob";
  /** `<container>/<prefix>{name}<suffix>` */
  path: string;
  container: string;
  connection: string;
}

export interface TopicRegistration extends AzureRegistrationBase {
  kind: "topic";
  topicName: string;
  subscriptionName: string;
  connection: string;
}

export type AzureRegistration = HttpRegistration | TimerRegistration | QueueRegistration | BlobRegistration | TopicRegistration;

/** The subset of `@azure/functions`' `app` that nskit uses. */
export interface AzureApp {
  http(name: string, options: Obj & { handler: (req: never, ctx: never) => unknown }): void;
  timer(name: string, options: Obj & { handler: (timer: never, ctx: never) => unknown }): void;
  storageQueue(name: string, options: Obj & { handler: (entry: never, ctx: never) => unknown }): void;
  storageBlob(name: string, options: Obj & { handler: (blob: never, ctx: never) => unknown }): void;
  serviceBusTopic(name: string, options: Obj & { handler: (message: never, ctx: never) => unknown }): void;
}

/** Minimal shape of the v4 `InvocationContext`. */
export interface AzureInvocationContext {
  invocationId?: string;
  functionName?: string;
  triggerMetadata?: Obj;
}

/** Minimal shape of the v4 `HttpRequest`. */
export interface AzureHttpRequest {
  method: string;
  url: string;
  headers: { forEach(cb: (value: string, key: string) => void): void } | Record<string, string>;
  query?: { forEach(cb: (value: string, key: string) => void): void } | Record<string, string>;
  params?: Record<string, string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  text?: () => Promise<string>;
}

/** v4 `Cookie`. */
export interface AzureCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: Date;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  maxAge?: number;
}

/** v4 `HttpResponseInit`. */
export interface AzureHttpResponseInit {
  status: number;
  headers: Record<string, string>;
  body?: Uint8Array | string;
  cookies?: AzureCookie[];
}

// ------------------------------------------------------------------ helpers

function context(fn: string, ctx: AzureInvocationContext | undefined): Context {
  return new Context({ requestId: ctx?.invocationId, functionName: fn, provider: PROVIDER, raw: ctx });
}

function entries(source: unknown): [string, string][] {
  if (!source) return [];
  const out: [string, string][] = [];
  const s = source as { forEach?: (cb: (value: string, key: string) => void) => void };
  if (typeof s.forEach === "function" && !Array.isArray(source)) {
    s.forEach((value, key) => out.push([key, String(value)]));
    return out;
  }
  for (const [k, v] of Object.entries(obj(source))) {
    if (Array.isArray(v)) for (const item of v) out.push([k, String(item)]);
    else if (v !== undefined && v !== null) out.push([k, String(v)]);
  }
  return out;
}

function pathOf(url: string | undefined): string {
  if (!url) return "/";
  try {
    return new URL(url, "http://localhost").pathname || "/";
  } catch {
    return "/";
  }
}

/** Parse one `Set-Cookie` string into the v4 `Cookie` shape (values are re-encoded by the host). */
export function parseSetCookie(header: string): AzureCookie {
  const [pair, ...attrs] = header.split(";");
  const idx = pair.indexOf("=");
  const name = (idx >= 0 ? pair.slice(0, idx) : pair).trim();
  let value = idx >= 0 ? pair.slice(idx + 1).trim() : "";
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep raw */
  }
  const cookie: AzureCookie = { name, value };
  for (const attr of attrs) {
    const eq = attr.indexOf("=");
    const key = (eq >= 0 ? attr.slice(0, eq) : attr).trim().toLowerCase();
    const val = eq >= 0 ? attr.slice(eq + 1).trim() : "";
    if (key === "path") cookie.path = val;
    else if (key === "domain") cookie.domain = val;
    else if (key === "max-age" && /^-?\d+$/.test(val)) cookie.maxAge = Number(val);
    else if (key === "expires" && !Number.isNaN(Date.parse(val))) cookie.expires = new Date(Date.parse(val));
    else if (key === "secure") cookie.secure = true;
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "samesite") {
      const v = val.toLowerCase();
      cookie.sameSite = v === "strict" ? "Strict" : v === "none" ? "None" : "Lax";
    }
  }
  return cookie;
}

// ------------------------------------------------------------------ HTTP

export async function toHttpRequest(req: AzureHttpRequest): Promise<HttpRequest> {
  const headers = entries(req.headers);
  const multiQuery: Record<string, string[]> = {};
  for (const [k, v] of entries(req.query)) (multiQuery[k] ??= []).push(v);
  let body: Uint8Array = new Uint8Array();
  if (typeof req.arrayBuffer === "function") body = new Uint8Array(await req.arrayBuffer());
  else if (typeof req.text === "function") body = toBytes(await req.text());
  const forwarded = headers.find(([k]) => k.toLowerCase() === "x-forwarded-for")?.[1];
  // "1.2.3.4:5555, ..." or "[::1]:5555"
  let sourceIp = forwarded?.split(",")[0].trim();
  if (sourceIp) sourceIp = sourceIp.startsWith("[") ? sourceIp.slice(1, sourceIp.indexOf("]")) : sourceIp.replace(/:\d+$/, "");
  return new HttpRequest({
    method: req.method,
    path: pathOf(req.url),
    headers,
    multiQuery,
    pathParams: { ...(req.params ?? {}) },
    body,
    sourceIp: sourceIp || undefined,
  });
}

export async function toEvent(req: AzureHttpRequest, functionName: string): Promise<Event> {
  return eventFromRequest(await toHttpRequest(req), PROVIDER, functionName, req);
}

/** HTTP trigger: `__nskit` envelopes (invoke / workflow) answer JSON 200/500, everything else is routed normally. */
export async function http(req: AzureHttpRequest, ctx: AzureInvocationContext | undefined, functionName: string): Promise<AzureHttpResponseInit> {
  const event = await toEvent(req, functionName);
  const context_ = context(functionName, ctx);
  if (!event.http) {
    const res = await runHttp(event, context_);
    return { status: res.status, headers: res.headers, body: res.body };
  }
  const resp = (await execute(event, context_, functionName)) as HttpResponse;
  const { status, headers, body } = resp.render();
  const out: AzureHttpResponseInit = { status, headers };
  if (body.length) out.body = body;
  if (resp.cookies.length) out.cookies = resp.cookies.map(parseSetCookie);
  return out;
}

// ------------------------------------------------------------------ other triggers

/** Timer trigger: `event.data` is the schedule's configured `input`. */
export async function timer(timerInfo: unknown, ctx: AzureInvocationContext | undefined, functionName: string, input?: unknown): Promise<void> {
  const event = new Event({
    type: EventType.SCHEDULE,
    provider: PROVIDER,
    functionName,
    data: input ?? null,
    source: "azure.timer",
    raw: timerInfo,
  });
  await execute(event, context(functionName, ctx), functionName);
}

export function toQueueEvent(entry: unknown, ctx: AzureInvocationContext | undefined, functionName: string): Event {
  const meta = obj(ctx?.triggerMetadata);
  const record = new EventRecord({
    id: str(meta.id),
    body: entry,
    attributes: {
      dequeueCount: meta.dequeueCount,
      insertionTime: meta.insertionTime,
      expirationTime: meta.expirationTime,
    },
    source: "azure.storage.queue",
    raw: entry,
  });
  return new Event({
    type: EventType.QUEUE,
    provider: PROVIDER,
    functionName,
    records: [record],
    time: parseTime(meta.insertionTime),
    source: "azure.storage.queue",
    raw: { entry, triggerMetadata: meta },
  });
}

/** Storage Queue trigger: one message per invocation (the host fans out batches). */
export async function queue(entry: unknown, ctx: AzureInvocationContext | undefined, functionName: string): Promise<void> {
  await execute(toQueueEvent(entry, ctx, functionName), context(functionName, ctx), functionName);
}

export function toBlobEvent(content: unknown, ctx: AzureInvocationContext | undefined, functionName: string, container: string): Event {
  const meta = obj(ctx?.triggerMetadata);
  const props = obj(meta.properties);
  const full = str(meta.blobTrigger) ?? str(meta.name) ?? "";
  const key = full.startsWith(container + "/") ? full.slice(container.length + 1) : full;
  const size =
    num(props.contentLength) ?? num(props.length) ?? (content instanceof Uint8Array ? content.length : undefined);
  const uri = str(meta.uri);
  const record = new EventRecord({
    id: uri ?? full,
    bucket: container,
    key,
    size,
    action: "created",
    attributes: { uri, etag: props.eTag ?? props.etag, contentType: props.contentType, metadata: meta.metadata },
    source: "azure.storage.blob",
    raw: content,
  });
  return new Event({
    type: EventType.STORAGE,
    provider: PROVIDER,
    functionName,
    records: [record],
    time: parseTime(props.lastModified ?? props.created),
    source: "azure.storage.blob",
    raw: { triggerMetadata: meta },
  });
}

/** Blob trigger (created / updated blobs). The blob content is on `record.raw`. */
export async function blob(content: unknown, ctx: AzureInvocationContext | undefined, functionName: string, container: string): Promise<void> {
  await execute(toBlobEvent(content, ctx, functionName, container), context(functionName, ctx), functionName);
}

export function toServiceBusEvent(message: unknown, ctx: AzureInvocationContext | undefined, functionName: string): Event {
  const meta = obj(ctx?.triggerMetadata);
  // cardinality "many" delivers arrays with `<key>Array` metadata; "one" (nskit's default) a single message.
  const many = Array.isArray(message) && Array.isArray(meta.messageIdArray);
  const messages = many ? (message as unknown[]) : [message];
  const pick = (key: string, i: number): unknown => (many ? (meta[`${key}Array`] as unknown[] | undefined)?.[i] : meta[key]);
  const records = messages.map((body, i) => {
    const props = obj(pick("applicationProperties", i) ?? pick("userProperties", i));
    return new EventRecord({
      id: str(pick("messageId", i)),
      body,
      attributes: { ...props },
      source: "azure.servicebus",
      raw: body,
    });
  });
  return new Event({
    type: EventType.TOPIC,
    provider: PROVIDER,
    functionName,
    records,
    time: parseTime(pick("enqueuedTimeUtc", 0)),
    source: "azure.servicebus",
    raw: { message, triggerMetadata: meta },
  });
}

/** Service Bus topic subscription trigger. */
export async function serviceBus(message: unknown, ctx: AzureInvocationContext | undefined, functionName: string): Promise<void> {
  await execute(toServiceBusEvent(message, ctx, functionName), context(functionName, ctx), functionName);
}

// ------------------------------------------------------------------ registration

/** Register every nskit trigger with the v4 programming model `app`. */
export function register(app: AzureApp, registrations: AzureRegistration[]): void {
  for (const reg of registrations) {
    const fn = reg.function;
    switch (reg.kind) {
      case "http":
        app.http(reg.name, {
          methods: reg.methods,
          route: reg.route,
          authLevel: reg.authLevel,
          handler: (req: AzureHttpRequest, ctx: AzureInvocationContext) => http(req, ctx, fn),
        });
        break;
      case "timer":
        app.timer(reg.name, {
          schedule: reg.schedule,
          runOnStartup: false,
          handler: (info: unknown, ctx: AzureInvocationContext) => timer(info, ctx, fn, reg.input),
        });
        break;
      case "queue":
        app.storageQueue(reg.name, {
          queueName: reg.queueName,
          connection: reg.connection,
          handler: (entry: unknown, ctx: AzureInvocationContext) => queue(entry, ctx, fn),
        });
        break;
      case "blob":
        app.storageBlob(reg.name, {
          path: reg.path,
          connection: reg.connection,
          handler: (content: unknown, ctx: AzureInvocationContext) => blob(content, ctx, fn, reg.container),
        });
        break;
      case "topic":
        app.serviceBusTopic(reg.name, {
          topicName: reg.topicName,
          subscriptionName: reg.subscriptionName,
          connection: reg.connection,
          handler: (message: unknown, ctx: AzureInvocationContext) => serviceBus(message, ctx, fn),
        });
        break;
      default:
        throw new Error(`unknown Azure registration kind ${JSON.stringify((reg as { kind?: unknown }).kind)}`);
    }
  }
}
