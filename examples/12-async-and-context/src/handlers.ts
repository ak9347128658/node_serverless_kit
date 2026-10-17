/**
 * Async handlers, the invocation context and structured logging.
 *
 * - Handlers may be async; nskit awaits them on every cloud.
 * - `ctx.logger` writes one JSON object per line (`NSKIT_LOG_FORMAT=text` for humans).
 *   Every line carries `function`, `requestId` and `provider` plus your fields, so
 *   CloudWatch, Cloud Logging and Application Insights can query them.
 * - `ctx.waitUntil(promise)` keeps work running after the response where the platform
 *   allows it (Cloudflare Workers); elsewhere nskit awaits it before the invocation ends.
 * - `ctx.remainingTimeMs()` tells long jobs when to stop (undefined if the platform doesn't say).
 */

import { defineHandler, getLogger } from "node_serverless_kit";

// A module-level logger for code outside a handler (cold-start work, shared helpers).
const log = getLogger("async-context", { component: "startup" });
log.debug("module loaded");

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Stand-in for an async HTTP / database call (fetch, a DB driver, ...). */
async function fetchSource(source: string, delayMs: number): Promise<{ source: string; latencyMs: number }> {
  await sleep(delayMs);
  return { source, latencyMs: delayMs };
}

// Recorded by background tasks; module state lives as long as the warm instance.
const recorded: { requestId: string; elapsedMs: number }[] = [];

async function recordMetrics(requestId: string, elapsedMs: number): Promise<void> {
  await sleep(5); // e.g. POST to a metrics endpoint
  recorded.push({ requestId, elapsedMs });
}

/** GET /aggregate - fan out to three "services" concurrently. */
export const aggregate = defineHandler(async (_event, ctx) => {
  const started = Date.now();
  const results = await Promise.all([fetchSource("inventory", 50), fetchSource("pricing", 80), fetchSource("reviews", 30)]);
  const elapsedMs = Date.now() - started; // ~80 ms in total instead of ~160 ms sequentially
  ctx.logger.info("aggregated", { sources: results.length, elapsedMs });
  // Don't make the caller wait for bookkeeping.
  ctx.waitUntil(recordMetrics(ctx.requestId, elapsedMs));
  return { results, elapsedMs };
});

/** POST /inspect - everything the runtime tells you about this invocation. */
export const inspect = defineHandler((event, ctx) => {
  ctx.logger.debug("full event", { event: event.toJSON() });
  const headers = Object.fromEntries([...(event.http?.headers ?? [])].filter(([k]) => k.startsWith("x-")));
  return {
    event: event.toJSON(), // type, provider, functionName, time, http summary ...
    context: {
      requestId: ctx.requestId, // use it in error messages and logs
      functionName: ctx.functionName,
      provider: ctx.provider,
      service: ctx.service,
      stage: ctx.stage,
      region: ctx.region,
      memoryMb: ctx.memoryMb ?? null,
      remainingTimeMs: ctx.remainingTimeMs() ?? null,
    },
    headers,
  };
});

/** Invoke-only: what `ctx.waitUntil` tasks have recorded on this instance. */
export const metrics = defineHandler(() => ({ recorded: recorded.length, last: recorded.at(-1) ?? null }));

/** Scheduled: process work in chunks and stop before the platform timeout. */
export const batchJob = defineHandler(async (_event, ctx) => {
  let processed = 0;
  for (let i = 0; i < 100; i++) {
    const remaining = ctx.remainingTimeMs();
    if (remaining !== undefined && remaining < 3_000) {
      ctx.logger.warn("time budget almost used, stopping", { processed });
      break;
    }
    await sleep(0); // do one chunk of real work here
    processed++;
  }
  ctx.logger.info("batch finished", { processed });
  return { processed };
});
