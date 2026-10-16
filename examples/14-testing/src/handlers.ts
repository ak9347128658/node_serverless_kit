/** Handlers under test (see tests/). */

import { BadRequest, BatchResult, defineHandler } from "node-serverless-kit";
import { discountRate } from "./discounts.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** POST /price {"amount": 100, "code": "WELCOME10"} (the code may also come from ?code=) */
export const price = defineHandler(async (event) => {
  const http = event.http!;
  const body = http.json<{ amount?: unknown; code?: string }>();
  const amount = body?.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    throw new BadRequest("amount must be a non-negative number");
  }
  const code = (body.code ?? http.query.code ?? "").toUpperCase();
  const rate = code ? await discountRate(code) : 0;
  return { amount, discount: round2(amount * rate), total: round2(amount * (1 - rate)), code: code || null };
});

/** Queue: messages must be JSON objects with an `id`. */
export const ingest = defineHandler((event) => {
  const result = new BatchResult();
  for (const record of event.records) {
    const payload = record.json<unknown>(null);
    if (typeof payload !== "object" || payload === null || !("id" in payload)) result.fail(record);
  }
  return result;
});

/** Topic subscriber that relies on message attributes. */
export const shippedOnly = defineHandler((event) =>
  event.records
    .filter((r) => r.attributes.event_type === "order.shipped")
    .map((r) => r.json<{ orderId: number }>().orderId),
);

/** Workflow task. */
export const enrich = defineHandler((event) => ({ ...(event.data as object), enriched: true }));

/** Workflow task. */
export const score = defineHandler((event) => {
  const data = event.data as { vip?: boolean };
  return { ...data, score: data.vip ? 90 : 40 };
});
