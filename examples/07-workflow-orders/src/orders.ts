/**
 * Task functions of the `order-pipeline` workflow.
 *
 * Each task receives the current workflow state as `event.data` and returns the
 * value that the state's `resultPath` stores. Thrown errors are matched by their
 * `name` against `retry` / `catch` rules, on AWS Step Functions, GCP Workflows and
 * the embedded engine alike - so give custom errors an explicit `name`.
 */

import { defineHandler } from "node_serverless_kit";

/** Bad input: caught by the workflow -> Rejected state. */
export class ValidationError extends Error {
  override name = "ValidationError";
}

/** Permanent: the card was refused. Caught by the workflow -> Declined state. */
export class PaymentDeclined extends Error {
  override name = "PaymentDeclined";
}

/** Transient: retried with exponential backoff by the workflow. */
export class PaymentGatewayTimeout extends Error {
  override name = "PaymentGatewayTimeout";
}

export class OutOfStock extends Error {
  override name = "OutOfStock";
}

export interface Item {
  sku: string;
  qty: number;
  price: number;
}

export interface Order {
  orderId?: string;
  items: Item[];
  card?: string;
  channel?: string;
  currency?: string;
  total?: number;
  customer?: { vip?: boolean; email?: string };
}

// Demo state. Real stock lives in a database; module state only survives while an instance is warm.
const stock = new Map<string, number>([
  ["sku-book", 100],
  ["sku-mug", 3],
  ["sku-poster", 0],
]);
let flakyCalls = 0;

/** Normalise the order so later choice rules can rely on every field existing. */
export const validateOrder = defineHandler((event) => {
  const order = { ...(event.data as Order) };
  const items = order.items ?? [];
  if (!items.length) throw new ValidationError("order has no items");
  for (const item of items) {
    if (!(item.qty > 0)) throw new ValidationError(`invalid quantity for ${item.sku}`);
  }
  // Integer cents avoid floating point surprises.
  const cents = items.reduce((sum, i) => sum + Math.round(i.price * 100) * i.qty, 0);
  return {
    ...order,
    total: cents / 100,
    currency: order.currency ?? "EUR",
    channel: order.channel ?? "web",
    customer: { vip: false, ...order.customer },
  } satisfies Order;
});

/** Map iterator: called once per item, up to `maxConcurrency` at a time. */
export const reserveItem = defineHandler((event) => {
  const item = event.data as Item;
  const available = stock.get(item.sku) ?? 0;
  if (available < item.qty) throw new OutOfStock(`${item.sku}: wanted ${item.qty}, have ${available}`);
  stock.set(item.sku, available - item.qty);
  return { sku: item.sku, qty: item.qty, reserved: true };
});

export const chargePayment = defineHandler((event, ctx) => {
  const order = event.data as Order;
  const card = order.card ?? "tok_ok";
  if (card === "tok_declined") throw new PaymentDeclined("card declined by issuer");
  if (card === "tok_flaky" && ++flakyCalls % 2 === 1) {
    // every first attempt times out, the retry succeeds
    throw new PaymentGatewayTimeout("gateway did not answer in 10s");
  }
  ctx.logger.info("charged", { orderId: order.orderId, total: order.total });
  return { status: "charged", amount: order.total, currency: order.currency };
});

export const sendConfirmation = defineHandler((event) => {
  const order = event.data as Order;
  return { emailSentTo: order.customer?.email ?? "unknown" };
});

export const createShipment = defineHandler((event) => {
  const order = event.data as Order;
  return { carrier: "DHL", tracking: `TRK-${order.orderId ?? "x"}` };
});
