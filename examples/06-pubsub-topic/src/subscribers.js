// @ts-check
/**
 * Two independent subscribers to the same `order-events` topic (fan-out).
 *
 * Every published message is delivered to *each* subscriber. Messages carry
 * attributes (SNS message attributes, Pub/Sub attributes, Service Bus application
 * properties) available as `record.attributes`.
 *
 * The YAML adds a filter policy so `notifyCustomer` only receives `order.shipped`
 * events. Filters are enforced by AWS SNS; on clouds where nskit cannot configure
 * them, `wants()` repeats the check in code, so the handler behaves the same everywhere.
 *
 * Plain JavaScript with `// @ts-check` + JSDoc: editors still type-check it.
 */

import { defineHandler } from "node-serverless-kit";

/**
 * @param {import("node-serverless-kit").EventRecord} record
 * @param {Set<string>} allowed
 */
function wants(record, allowed) {
  return allowed.has(String(record.attributes.event_type ?? ""));
}

/** Receives every order event. */
export const updateAnalytics = defineHandler((event, ctx) => {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const record of event.records) {
    const kind = String(record.attributes.event_type ?? "unknown");
    counts[kind] = (counts[kind] ?? 0) + 1;
    ctx.logger.info("analytics", { messageId: record.id, eventType: kind });
  }
  return { counts };
});

/** Receives only shipped orders (filter policy + defensive check). */
export const notifyCustomer = defineHandler((event, ctx) => {
  /** @type {unknown[]} */
  const notified = [];
  for (const record of event.records) {
    if (!wants(record, new Set(["order.shipped"]))) continue;
    /** @type {{orderId?: string, email?: string}} */
    const order = record.json();
    ctx.logger.info("emailing customer", { orderId: order.orderId, email: order.email });
    notified.push(order.orderId);
  }
  return { notified };
});
