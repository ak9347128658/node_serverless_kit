// Scheduled jobs in plain JavaScript (ES modules).
//
// For a schedule event:
//   event.type === "schedule"
//   event.data  is the `input` configured in nskit.yml (or null)
//   event.time  is when the platform fired the trigger (a Date, UTC)
//
// A job that throws is retried according to the platform's policy, so make jobs
// idempotent: running the same job twice must be harmless.

import { defineHandler } from "node_serverless_kit";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Runs every 5 minutes - e.g. ping dependencies, refresh a cache. */
export const heartbeat = defineHandler((event, ctx) => {
  ctx.logger.info("heartbeat", { firedAt: event.time.toISOString() });
  return { ok: true, at: event.time.toISOString() };
});

/** Runs every weekday at 09:00 Europe/Berlin (on clouds that support time zones). */
export const dailyReport = defineHandler((event, ctx) => {
  /** @type {{report?: string, days?: number, recipients?: string[]}} */
  const options = /** @type {any} */ (event.data) ?? {};
  const periodEnd = new Date(Math.floor(event.time.getTime() / DAY_MS) * DAY_MS); // midnight UTC
  const periodStart = new Date(periodEnd.getTime() - Number(options.days ?? 1) * DAY_MS);
  const report = {
    report: options.report ?? "daily",
    recipients: options.recipients ?? [],
    period: [periodStart.toISOString(), periodEnd.toISOString()],
    generatedAt: new Date().toISOString(),
  };
  ctx.logger.info("report generated", report);
  return report;
});

/** Daily cleanup - checks the remaining time so it can stop gracefully. */
export const cleanup = defineHandler(async (event, ctx) => {
  const retentionDays = Number(/** @type {any} */ (event.data)?.retentionDays ?? 30);
  let deleted = 0;
  for (let batch = 0; batch < 10; batch++) {
    const remaining = ctx.remainingTimeMs(); // undefined when the platform does not say (e.g. locally)
    if (remaining !== undefined && remaining < 5_000) {
      ctx.logger.warn("stopping early, will continue next run", { deleted });
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 0)); // pretend to delete one batch
    deleted += 100;
  }
  return { retentionDays, deleted };
});
