/**
 * AFTER: the same service, cloud-neutral.
 *
 * What changed compared with before/handler.mjs:
 *
 * - no event parsing: `event.http.json()` / `pathParams` / `event.records`;
 * - no `statusCode` objects: return data or `HttpResponse`; throw `BadRequest`;
 * - no Step Functions client: the workflow is defined in nskit.yml and started by
 *   its own trigger (see README, "Starting the workflow");
 * - task functions read `event.data` instead of the raw event.
 *
 * The business rules themselves (validation, totals, charging) are untouched.
 */

import { BadRequest, BatchResult, defineHandler, HttpResponse, NotFound } from "node_serverless_kit";

interface Item {
  qty: number;
  price: number;
}

interface Order {
  items: Item[];
  total?: number;
  [key: string]: unknown;
}

export class ValidationError extends Error {
  override name = "ValidationError"; // matched by `catch: [{errors: [ValidationError]}]`
}

const totalOf = (items: Item[]) => items.reduce((sum, i) => sum + i.qty * i.price, 0);

export const createOrder = defineHandler((event) => {
  const order = event.http!.json<Order>(); // invalid JSON -> 400 automatically
  if (typeof order !== "object" || order === null || !Array.isArray(order.items) || !order.items.length) {
    throw new BadRequest("items required");
  }
  order.total = totalOf(order.items);
  // Hand-off: the workflow is started by POSTing this order to the workflow's
  // trigger (see README, "Starting the workflow").
  return HttpResponse.json({ accepted: true, order }, 202);
});

export const getOrder = defineHandler((event) => {
  const id = event.http?.pathParams.id;
  if (!id) throw new NotFound("not found");
  return { id, status: "unknown" };
});

export const emailWorker = defineHandler((event, ctx) => {
  const result = new BatchResult();
  for (const record of event.records) {
    try {
      const message = record.json<{ to?: string }>();
      if (!message.to) throw new Error("no recipient");
      ctx.logger.info("sending email", { to: message.to });
    } catch {
      result.fail(record);
    }
  }
  return result;
});

// Workflow tasks: the state arrives as event.data on every cloud.
export const validate = defineHandler((event) => {
  const order = event.data as Order;
  if (order.items.reduce((n, i) => n + i.qty, 0) <= 0) throw new ValidationError("empty order");
  return { ...order, valid: true, total: order.total ?? totalOf(order.items) };
});

export const charge = defineHandler((event) => ({ ...(event.data as Order), charged: true }));
