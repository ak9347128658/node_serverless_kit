"use strict";

const { HttpResponse } = require("node_serverless_kit");

/** GET /hello?name=Ada */
async function handler(event, ctx) {
  const name = event.http.query.name || "world";
  ctx.logger.info("hello", { name });
  return HttpResponse.json({ message: `Hello, ${name}!`, moduleSystem: "commonjs" });
}

module.exports = { handler };
