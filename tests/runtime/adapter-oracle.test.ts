import { afterEach, beforeEach, expect, test } from "vitest";
import { NotFound } from "../../src/runtime/errors";
import type { Event } from "../../src/runtime/event";
import { installBundle } from "../../src/runtime/manifest";
import { handler, toContext, toEvent, type FdkContext } from "../../src/runtime/adapters/oracle";
import type { GatewayResponse } from "../../src/runtime/response";

let seen: Event | undefined;

async function echo(event: Event) {
  seen = event;
  if (event.http) {
    if (event.http.pathParams.id === "missing") throw new NotFound("nope");
    return { id: event.http.pathParams.id, q: event.http.query, ua: event.http.headers.get("user-agent") };
  }
  if (event.records.length) {
    const r = event.records[0];
    return { bucket: r.bucket, key: r.key, action: r.action };
  }
  if ((event.data as { boom?: boolean } | null)?.boom) throw new TypeError("bad input");
  return { type: event.type, data: event.data };
}

/** Mimics the Fn FDK Context: canonical header keys with list values, response headers via setResponseHeader. */
class FakeCtx implements FdkContext {
  responseHeaders: Record<string, string[]> = {};
  constructor(
    readonly headers: Record<string, string[]> = {},
    readonly callID = "call-1",
  ) {}
  get deadline(): Date {
    return new Date(Date.now() + 10_000);
  }
  setResponseHeader(key: string, ...values: string[]): void {
    this.responseHeaders[key] = values;
  }
}

beforeEach(() => {
  seen = undefined;
  process.env.NSKIT_FUNCTION = "users";
  installBundle({
    manifest: {
      service: "demo",
      stage: "dev",
      region: "",
      workflows: {},
      provider: "oracle",
      functions: { users: { handler: "t.echo", routes: [{ method: "GET", path: "/users/{id}" }] } },
    },
    handlers: { "t.echo": async () => echo },
  });
});
afterEach(() => {
  delete process.env.NSKIT_FUNCTION;
});

const gateway = (url: string, extra: Record<string, string[]> = {}) =>
  new FakeCtx({ "Fn-Http-Method": ["GET"], "Fn-Http-Request-Url": [url], "Fn-Http-H-User-Agent": ["curl"], ...extra });

test("API Gateway request with prefix, query and headers", async () => {
  const ctx = gateway("/demo/users/5?q=1&q=2");
  const out = (await handler(new Uint8Array(), ctx)) as GatewayResponse;
  expect(out.status).toBe(200);
  expect(JSON.parse(out.body)).toEqual({ id: "5", q: { q: "2" }, ua: "curl" });
  expect(seen?.http?.multiQuery).toEqual({ q: ["1", "2"] });
  expect(ctx.responseHeaders["Fn-Http-Status"]).toEqual(["200"]);
  expect(ctx.responseHeaders["Content-Type"]).toEqual(["application/json"]);
});

test("rawResult receives the body bytes and errors map to Fn-Http-Status", async () => {
  const ctx = gateway("/demo/users/missing");
  let raw: Uint8Array | undefined;
  const marker = await handler(Buffer.alloc(0), ctx, (b) => {
    raw = b;
    return "RAW";
  });
  expect(marker).toBe("RAW");
  expect(JSON.parse(new TextDecoder().decode(raw))).toMatchObject({ error: "nope", status: 404 });
  expect(ctx.responseHeaders["Fn-Http-Status"]).toEqual(["404"]);

  const post = gateway("/demo/users/5", { "Fn-Http-Method": ["POST"] });
  await handler(Buffer.alloc(0), post);
  expect(post.responseHeaders["Fn-Http-Status"]).toEqual(["405"]);
  expect(post.responseHeaders["Fn-Http-H-allow"]).toEqual(["GET"]);
});

test("envelope through the gateway is a non-HTTP event that keeps the HTTP status", async () => {
  const ctx = new FakeCtx({ "Fn-Http-Method": ["POST"], "Fn-Http-Request-Url": ["/demo/workflows/x"] });
  const body = Buffer.from(JSON.stringify({ __nskit: "invoke", data: { boom: true } }));
  const out = (await handler(body, ctx)) as GatewayResponse;
  expect(out.status).toBe(500);
  expect(JSON.parse(out.body)).toEqual({ errorType: "TypeError", cause: "bad input" });
  expect(ctx.responseHeaders["Fn-Http-Status"]).toEqual(["500"]);
});

test("object storage CloudEvent", async () => {
  const payload = {
    eventType: "com.oraclecloud.objectstorage.createobject",
    eventID: "e1",
    eventTime: "2024-01-01T00:00:00Z",
    source: "ObjectStorage",
    data: { resourceName: "in/file.csv", additionalDetails: { bucketName: "uploads", namespace: "ns" } },
  };
  const out = (await handler(Buffer.from(JSON.stringify(payload)), new FakeCtx())) as GatewayResponse;
  expect(JSON.parse(out.body)).toEqual({ bucket: "uploads", key: "in/file.csv", action: "created" });
  expect(seen?.type).toBe("storage");
  expect(seen?.time.toISOString()).toBe("2024-01-01T00:00:00.000Z");
  const deleted = toEvent(undefined, JSON.stringify({ ...payload, eventType: "com.oraclecloud.objectstorage.deleteobject" }), "f");
  expect(deleted.records[0].action).toBe("deleted");
});

test("envelope, plain invoke and empty input", async () => {
  const ctx = new FakeCtx();
  let out = (await handler(Buffer.from(JSON.stringify({ __nskit: "workflow", data: [1] })), ctx)) as GatewayResponse;
  expect(JSON.parse(out.body)).toEqual({ type: "workflow", data: [1] });
  expect(ctx.responseHeaders["Fn-Http-Status"]).toBeUndefined();
  out = (await handler(Buffer.from('{"a": 1}'), ctx)) as GatewayResponse;
  expect(JSON.parse(out.body)).toEqual({ type: "invoke", data: { a: 1 } });
  out = (await handler(undefined, ctx)) as GatewayResponse;
  expect(JSON.parse(out.body)).toEqual({ type: "invoke", data: null });
  out = (await handler("plain text", ctx)) as GatewayResponse;
  expect(JSON.parse(out.body)).toEqual({ type: "invoke", data: "plain text" });
});

test("a failed direct invocation throws so Fn marks the call failed", async () => {
  await expect(handler(Buffer.from(JSON.stringify({ boom: true })), new FakeCtx())).rejects.toThrow(/bad input/);
});

test("context from the FDK", () => {
  const ctx = toContext(new FakeCtx({}, "abc"), "users");
  expect(ctx.requestId).toBe("abc");
  expect(ctx.remainingTimeMs()).toBeGreaterThan(5000);
  expect(ctx.provider).toBe("oracle");
});
