/**
 * One code base, ten clouds. Nothing in this file knows where it runs.
 *
 * `event.provider` / `ctx.region` are informational only - the logic below is
 * identical on every provider. Only web APIs are used (no `node:*` imports), so the
 * same code also runs in Cloudflare Workers' V8 isolates.
 */

import { BadRequest, defineHandler, HttpResponse } from "node-serverless-kit";

/** e.g. "Node.js/22" on Node, "Cloudflare-Workers" in a Worker. */
function runtimeName(): string {
  return (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? "unknown";
}

/** GET /whoami - shows the portable context the runtime builds for you. */
export const whoami = defineHandler((event, ctx) => ({
  provider: event.provider,
  service: ctx.service,
  stage: ctx.stage,
  region: ctx.region,
  function: ctx.functionName,
  requestId: ctx.requestId,
  runtime: runtimeName(),
  app: ctx.env.APP_NAME,
  path: event.http?.path,
  clientIp: event.http?.sourceIp,
}));

/** POST /echo - returns the JSON body plus a few request details. */
export const echo = defineHandler((event) => {
  const http = event.http!;
  const body = http.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("send a JSON object");
  return HttpResponse.json(
    { youSent: body, contentType: http.contentType, query: http.query },
    200,
    { "x-served-by": event.provider },
  );
});

/** Hourly schedule (on the clouds that support schedules). */
export const ticker = defineHandler((event, ctx) => {
  const now = new Date().toISOString();
  ctx.logger.info("tick", { provider: event.provider, at: now, input: event.data });
  return { tickedAt: now, input: event.data };
});
