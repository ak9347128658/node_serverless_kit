/** Queue and topic handlers: through the runner, and as plain functions. */

import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { Context, Event, EventRecord, LocalRunner } from "node_serverless_kit/testing";
import { ingest, shippedOnly } from "../src/handlers.js";

const CONFIG = fileURLToPath(new URL("../nskit.yml", import.meta.url));

it("reports partial batch failures", async () => {
  const runner = await LocalRunner.fromConfig(CONFIG, { mode: "import" });
  // Messages may be objects (JSON-encoded), strings, or {id, body, attributes}; ids default to "1", "2", ...
  const result = await runner.queue<{ failed: string[] }>("ingest", [{ id: 1 }, "garbage", { noId: true }]);
  expect(result.failed).toEqual(["2", "3"]);
});

it("filters topic messages by attribute (plain handler call)", async () => {
  // Handlers are ordinary functions: build the Event and Context yourself when you
  // need full control over the fields.
  const event = new Event({
    type: "topic",
    records: [
      new EventRecord({ id: "1", body: '{"orderId": 7}', attributes: { event_type: "order.shipped" } }),
      new EventRecord({ id: "2", body: '{"orderId": 8}', attributes: { event_type: "order.created" } }),
    ],
  });
  expect(await shippedOnly(event, new Context({ functionName: "shipped-only" }))).toEqual([7]);
});

it("returns a BatchResult when called directly", async () => {
  const event = new Event({ type: "queue", records: [new EventRecord({ id: "a", body: "{}" })] });
  const result = await ingest(event, new Context());
  expect(result.failed).toEqual(["a"]);
});
