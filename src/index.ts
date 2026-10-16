/**
 * node-serverless-kit - write a Node.js function once, deploy it to any cloud.
 *
 * Only the *runtime* API is exported here. It has no dependencies, so it is
 * bundled into every deployment. The CLI, config loader and Terraform
 * renderers live behind `node-serverless-kit/api` and are never loaded at
 * function runtime.
 */

import type { Context } from "./runtime/context.js";
import type { Event } from "./runtime/event.js";
import type { HttpResponse } from "./runtime/response.js";
import type { BatchResult } from "./runtime/batch.js";

export { VERSION, AUTHOR } from "./version.js";
export { BatchFailure, BatchResult, processBatch } from "./runtime/batch.js";
export { Context, type ContextInit } from "./runtime/context.js";
export {
  BadRequest,
  Conflict,
  Forbidden,
  HandlerNotFound,
  HttpError,
  MethodNotAllowed,
  NotFound,
  NskitError,
  ServiceUnavailable,
  TooManyRequests,
  Unauthorized,
  UnprocessableEntity,
  isHttpError,
  type HttpErrorOptions,
} from "./runtime/errors.js";
export {
  Event,
  EventRecord,
  EventType,
  Headers,
  HttpRequest,
  type EventInit,
  type EventRecordInit,
  type HttpRequestInit,
} from "./runtime/event.js";
export { invoke, InvokeError, type InvokeOptions } from "./runtime/invoke.js";
export { getLogger, type Logger, type LogLevel } from "./runtime/log.js";
export { HttpResponse, type CookieOptions } from "./runtime/response.js";
export { WorkflowFailed } from "./runtime/workflow.js";
// For third-party provider adapters: the portable dispatcher and envelope helpers.
export { execute } from "./runtime/dispatch.js";
export { envelope, unwrapEnvelope, ENVELOPE_KEY } from "./runtime/envelope.js";
export { env, getEnv } from "./runtime/util.js";

/** Anything a handler may return (see the handler docs for how each is mapped). */
export type HandlerResult = HttpResponse | BatchResult | string | Uint8Array | object | number | boolean | null | void;

/** The portable handler signature. */
export type Handler<TResult = HandlerResult> = (event: Event, context: Context) => TResult | Promise<TResult>;

/**
 * Identity helper that gives a handler full type inference:
 *
 * ```ts
 * export const hello = defineHandler(async (event, ctx) => ({ hi: event.http?.query.name }));
 * ```
 */
export function defineHandler<TResult = HandlerResult>(fn: Handler<TResult>): Handler<TResult> {
  return fn;
}
