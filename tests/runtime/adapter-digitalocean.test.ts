import { afterEach, beforeEach, expect, test } from "vitest";
import type { Context } from "../../src/runtime/context";
import type { Event } from "../../src/runtime/event";
import { installBundle } from "../../src/runtime/manifest";
import { main } from "../../src/runtime/adapters/digitalocean";

let seen: Event | undefined;
let seenCtx: Context | undefined;

async function echo(event: Event, ctx: Context) {
  seen = event;
  seenCtx = ctx;
  if (event.http) return { id: event.http.pathParams.id, q: event.http.query, body: event.http.json(null) };
  return { type: event.type, data: event.data };
}

const context = { activationId: "act-1", getRemainingTimeInMillis: () => 5000 };

beforeEach(() => {
  seen = undefined;
  process.env.NSKIT_FUNCTION = "users";
  installBundle({
    manifest: {
      service: "demo",
      stage: "dev",
      region: "",
      workflows: {},
      provider: "digitalocean",
      functions: { users: { handler: "t.echo", routes: [{ method: "ANY", path: "/users/{id}" }] } },
    },
    handlers: { "t.echo": async () => echo },
  });
});
afterEach(() => {
  delete process.env.NSKIT_FUNCTION;
});

test("raw web request", async () => {
  const out = await main(
    {
      http: {
        method: "POST",
        path: "/users/3",
        headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4, 10.0.0.1" },
        queryString: "x=1",
        body: JSON.stringify({ a: 1 }),
        isBase64Encoded: false,
      },
    },
    context,
  );
  expect(out.statusCode).toBe(200);
  expect(JSON.parse(out.body)).toEqual({ id: "3", q: { x: "1" }, body: { a: 1 } });
  expect(seen?.http?.sourceIp).toBe("1.2.3.4");
  expect(seenCtx?.requestId).toBe("act-1");
  const remaining = seenCtx?.remainingTimeMs() ?? 0;
  expect(remaining).toBeGreaterThan(0);
  expect(remaining).toBeLessThanOrEqual(5000);
});

test("base64 body", async () => {
  const payload = Buffer.from([0xff, 0x00]).toString("base64");
  await main({ http: { method: "PUT", path: "/users/1", headers: {}, body: payload, isBase64Encoded: true } });
  expect([...(seen?.http?.body ?? [])]).toEqual([0xff, 0x00]);
});

test("non-raw web merges params into the event", async () => {
  const out = await main({ http: { method: "POST", path: "/users/2", headers: {} }, name: "x" });
  expect(JSON.parse(out.body).body).toEqual({ name: "x" });
});

test("scheduled trigger envelope", async () => {
  const out = await main({ __nskit: "schedule", data: { r: 1 }, source: "digitalocean.scheduler" });
  expect(JSON.parse(out.body)).toEqual({ type: "schedule", data: { r: 1 } });
  expect(seen?.source).toBe("digitalocean.scheduler");
  expect(seen?.type).toBe("schedule");
});

test("plain invoke and failures", async () => {
  expect(JSON.parse((await main({ k: 2 })).body)).toEqual({ type: "invoke", data: { k: 2 } });
  expect(JSON.parse((await main()).body)).toEqual({ type: "invoke", data: {} });
  process.env.NSKIT_FUNCTION = "nope";
  const failed = await main({ k: 1 });
  expect(failed.statusCode).toBe(500);
  expect(JSON.parse(failed.body).errorType).toBeTruthy();
});
