import { BadRequest, defineHandler, HttpResponse, NotFound } from "node_serverless_kit";
import { repository, type Order } from "./repository.js";

/** POST /orders {"item": "book"} -> 201 */
export const createOrder = defineHandler(async (event) => {
  const body = event.http?.json<{ item?: unknown }>();
  if (!body || typeof body.item !== "string" || !body.item) throw new BadRequest("`item` is required");
  const order: Order = { id: crypto.randomUUID(), item: body.item, status: "new" };
  await repository().put(order);
  return HttpResponse.json(order, 201, { location: `/orders/${order.id}` });
});

/** GET /orders/{id} */
export const getOrder = defineHandler(async (event) => {
  const order = await repository().get(event.http!.pathParams.id);
  if (!order) throw new NotFound("order not found");
  return order;
});
