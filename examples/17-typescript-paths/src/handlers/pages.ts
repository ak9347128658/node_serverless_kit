import { defineHandler, HttpResponse } from "node_serverless_kit";
import { greeting } from "@lib/greeting";
import { render } from "@lib/render";
// Embedded into the bundle as a string by esbuild's text loader: no file system access at
// runtime, so this works on every cloud, including Cloudflare Workers.
import pageTemplate from "@templates/page.html";

/** GET /page  and  GET /greet/{name} - server-rendered HTML. */
export const page = defineHandler((event, ctx) => {
  const name = event.http?.pathParams.name ?? event.http?.query.name;
  const html = render(pageTemplate, {
    title: "nskit + TypeScript paths",
    message: greeting(name),
    provider: event.provider,
    stage: ctx.stage,
  });
  return HttpResponse.html(html);
});
