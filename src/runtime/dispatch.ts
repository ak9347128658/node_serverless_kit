/**
 * Calls the user's handler with a normalized event and normalizes the result.
 *
 * This is the single choke point shared by every provider adapter, so
 * behaviour (error mapping, CORS, routing, logging) is identical on every cloud.
 */

import { isBatchResult } from "./batch.js";
import { Context } from "./context.js";
import { isHttpError } from "./errors.js";
import { Event, EventType } from "./event.js";
import { resolveFunction, resolveHandler, type CorsSpec, type FunctionSpec, type RouteSpec } from "./manifest.js";
import { HttpResponse, toResponseAsync } from "./response.js";
import { matchPath, methodMatches } from "./routing.js";
import { getEnv, truthy } from "./util.js";

export const DEFAULT_CORS: Required<CorsSpec> = {
  origins: ["*"],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  headers: ["Content-Type", "Authorization", "X-Requested-With"],
  exposeHeaders: [],
  allowCredentials: false,
  maxAge: 600,
};

/** Providers that report partial batch failures natively (or show them, locally). */
const PARTIAL_BATCH_PROVIDERS = new Set(["aws", "local"]);

// ---------------------------------------------------------------- routing / CORS

interface RouteSelection {
  route?: RouteSpec;
  early?: HttpResponse;
}

/**
 * Match the request against configured routes, filling `pathParams`. Returns a
 * 405 response when the path matched but no route allows the method.
 */
function selectRoute(spec: FunctionSpec, event: Event): RouteSelection {
  const req = event.http;
  if (!req || !spec.routes.length) return {};
  let pathMatched: RouteSpec | undefined;
  // Exact matches win over tolerant ones (e.g. GET /hello vs GET /hello/{name}).
  for (const tolerant of [false, true]) {
    for (const route of spec.routes) {
      const params = matchPath(route.path, req.path, tolerant);
      if (params === null) continue;
      pathMatched ??= route;
      if (methodMatches(route.method, req.method) || req.method === "OPTIONS") {
        if (!Object.keys(req.pathParams).length) req.pathParams = params;
        req.route = route.path;
        return { route };
      }
    }
    if (pathMatched) break;
  }
  if (pathMatched) {
    const allowed = [
      ...new Set(spec.routes.filter((r) => matchPath(r.path, req.path) !== null).map((r) => r.method.toUpperCase())),
    ].sort();
    return {
      route: pathMatched,
      early: HttpResponse.json({ error: "Method Not Allowed", status: 405 }, 405, { allow: allowed.join(", ") }),
    };
  }
  return {};
}

function corsConfig(route: RouteSpec | undefined, spec: FunctionSpec): Required<CorsSpec> | undefined {
  const cors = route ? route.cors : spec.routes.find((r) => r.cors)?.cors;
  if (!cors) return undefined;
  const merged = { ...DEFAULT_CORS };
  for (const [k, v] of Object.entries(cors)) {
    if (v !== undefined && v !== null) (merged as Record<string, unknown>)[k] = v;
  }
  return merged;
}

export function applyCors(
  resp: HttpResponse,
  cors: Required<CorsSpec>,
  origin: string | undefined,
  preflight: boolean,
): HttpResponse {
  const origins = cors.origins?.length ? cors.origins : ["*"];
  let allowOrigin: string;
  if (origins.includes("*") && !cors.allowCredentials) allowOrigin = "*";
  else if (origin && (origins.includes(origin) || origins.includes("*"))) allowOrigin = origin;
  else return resp;
  const headers: Record<string, string> = { "access-control-allow-origin": allowOrigin };
  if (allowOrigin !== "*") headers.vary = "Origin";
  if (cors.allowCredentials) headers["access-control-allow-credentials"] = "true";
  if (cors.exposeHeaders?.length) headers["access-control-expose-headers"] = cors.exposeHeaders.join(", ");
  if (preflight) {
    headers["access-control-allow-methods"] = (cors.methods ?? []).join(", ");
    headers["access-control-allow-headers"] = (cors.headers ?? []).join(", ");
    headers["access-control-max-age"] = String(cors.maxAge ?? 600);
  }
  const existing = new Set(Object.keys(resp.headers).map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(headers)) if (!existing.has(k)) resp.headers[k] = v;
  return resp;
}

// ---------------------------------------------------------------- execution

export function errorResponse(err: unknown, context: Context): HttpResponse {
  if (isHttpError(err)) return HttpResponse.json(err.toBody(), err.status, err.headers);
  const body: Record<string, unknown> = { error: "Internal Server Error", status: 500, requestId: context.requestId };
  if (truthy(getEnv("NSKIT_DEBUG"))) {
    body.detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  return HttpResponse.json(body, 500);
}

interface Prepared {
  spec: FunctionSpec;
  route?: RouteSpec;
  cors?: Required<CorsSpec>;
  early?: HttpResponse;
  started: number;
}

function prepare(event: Event, context: Context, functionName?: string): Prepared {
  const started = Date.now();
  const spec = resolveFunction(functionName || event.functionName || undefined);
  event.functionName ||= spec.name;
  context.functionName ||= spec.name;
  const prep: Prepared = { spec, started };
  if (event.http) {
    const sel = selectRoute(spec, event);
    prep.route = sel.route;
    prep.early = sel.early;
    prep.cors = corsConfig(prep.route, spec);
    if (!prep.early && prep.cors && event.http.method === "OPTIONS") prep.early = new HttpResponse(204, "");
  }
  return prep;
}

async function finish(
  prep: Prepared,
  event: Event,
  context: Context,
  result: unknown,
  error: unknown,
  failed: boolean,
): Promise<unknown> {
  if (context.pending.length) await Promise.allSettled(context.pending.splice(0));
  const durationMs = Date.now() - prep.started;
  if (!event.http) {
    if (failed) {
      context.logger.error("handler failed", { eventType: event.type, durationMs, error });
      throw error;
    }
    context.logger.debug("handler ok", { eventType: event.type, durationMs });
    // AWS reports partial failures natively; local runs show them; elsewhere the
    // whole batch must fail so the platform redelivers it.
    if (isBatchResult(result) && !PARTIAL_BATCH_PROVIDERS.has(event.provider)) {
      result.throwIfFailed();
      return undefined;
    }
    return result;
  }
  let resp: HttpResponse;
  if (failed) {
    if (!isHttpError(error) || error.status >= 500) {
      context.logger.error("handler failed", { method: event.http.method, path: event.http.path, error });
    }
    resp = errorResponse(error, context);
  } else {
    try {
      resp = await toResponseAsync(result);
    } catch (err) {
      context.logger.error("could not serialize handler result", { error: err });
      resp = errorResponse(err, context);
    }
  }
  if (prep.cors) applyCors(resp, prep.cors, event.http.headers.get("origin"), event.http.method === "OPTIONS");
  context.logger.info("request", {
    method: event.http.method,
    path: event.http.path,
    status: resp.status,
    durationMs,
  });
  return resp;
}

/**
 * Run the handler for `event`.
 *
 * For HTTP events always resolves to an {@link HttpResponse}; for everything
 * else resolves to the handler's raw result and rejects on failure so the
 * platform's retry policy applies.
 */
export async function execute(event: Event, context: Context, functionName?: string): Promise<unknown> {
  let prep: Prepared;
  try {
    prep = prepare(event, context, functionName);
  } catch (err) {
    if (!event.http) throw err;
    context.logger.error("function resolution failed", { error: err });
    return errorResponse(err, context);
  }
  if (prep.early) return finish(prep, event, context, prep.early, undefined, false);
  let result: unknown;
  try {
    const fn = await resolveHandler(prep.spec.handler);
    result = await fn(event, context);
  } catch (err) {
    return finish(prep, event, context, undefined, err, true);
  }
  return finish(prep, event, context, result, undefined, false);
}

/** `execute` for HTTP events, typed. */
export async function executeHttp(event: Event, context: Context, functionName?: string): Promise<HttpResponse> {
  return (await execute(event, context, functionName)) as HttpResponse;
}

export function isHttp(event: Event): boolean {
  return event.type === EventType.HTTP;
}
