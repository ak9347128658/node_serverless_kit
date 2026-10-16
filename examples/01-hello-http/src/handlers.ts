import { BadRequest, defineHandler, HttpResponse } from "node-serverless-kit";

/** GET /hello?name=Ada  or  GET /hello/Ada */
export const hello = defineHandler(async (event, ctx) => {
  const name = event.http?.pathParams.name ?? event.http?.query.name ?? "world";
  if (name.length > 64) throw new BadRequest("name is too long"); // -> HTTP 400 {"error": ..., "status": 400}
  ctx.logger.info("greeting", { name });
  return HttpResponse.json({ message: `Hello, ${name}!`, provider: event.provider, stage: ctx.stage });
});
