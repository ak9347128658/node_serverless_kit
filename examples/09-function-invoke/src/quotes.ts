/**
 * Function-to-function calls with `invoke()`.
 *
 * `invoke("price-calculator", payload)` calls another function of the same service
 * by its *logical* name from nskit.yml. The target receives an event with
 * `event.type === "invoke"` and `event.data === payload`; its return value comes
 * back to the caller. The caller never builds ARNs, URLs or SDK requests itself.
 */

import { BadRequest, defineHandler, invoke } from "node-serverless-kit";

/** Tax rates in basis points (1/100 of a percent): integer math, no float rounding issues. */
const TAX_BPS: Record<string, number> = { DE: 1900, FR: 2000, US: 0, IN: 1800 };

export interface LineItem {
  sku: string;
  qty: number;
  unitPrice: number;
}

export interface Price {
  subtotal: number;
  tax: number;
  total: number;
  taxRate: number;
}

/** POST /quote {"items": [{"sku": "a", "qty": 2, "unitPrice": 10}], "country": "DE"} */
export const quote = defineHandler(async (event, ctx) => {
  const body = event.http?.json<{ items?: LineItem[]; country?: string }>();
  if (!body || !Array.isArray(body.items) || !body.items.length) throw new BadRequest("`items` is required");

  const price = await invoke<Price>("price-calculator", { items: body.items, country: body.country ?? "US" });

  // Fire-and-forget where the cloud supports asynchronous invocation (AWS `Event`).
  await invoke("audit-log", { action: "quote", requestId: ctx.requestId, total: price.total }, { async: true });

  return { quote: price, requestId: ctx.requestId };
});

/** Invoke-only: no public trigger. Pure business logic, easy to unit test. */
export const priceCalculator = defineHandler((event) => {
  const data = (event.data ?? {}) as { items?: LineItem[]; country?: string };
  const subtotalCents = (data.items ?? []).reduce((sum, i) => sum + Math.round(i.unitPrice * 100) * Math.trunc(i.qty), 0);
  const bps = TAX_BPS[data.country ?? "US"] ?? 0;
  const taxCents = Math.round((subtotalCents * bps) / 10_000);
  return {
    subtotal: subtotalCents / 100,
    tax: taxCents / 100,
    total: (subtotalCents + taxCents) / 100,
    taxRate: bps / 10_000,
  } satisfies Price;
});

export const auditLog = defineHandler((event, ctx) => {
  ctx.logger.info("audit", { entry: event.data });
  return { logged: true };
});
