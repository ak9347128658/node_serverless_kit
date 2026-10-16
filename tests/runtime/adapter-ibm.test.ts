import { afterEach, beforeEach, expect, test } from "vitest";
import { HttpResponse } from "../../src/runtime/response";
import { NotFound } from "../../src/runtime/errors";
import type { Context } from "../../src/runtime/context";
import type { Event } from "../../src/runtime/event";
import { installBundle } from "../../src/runtime/manifest";
import { main, requestBody, toNative } from "../../src/runtime/adapters/ibm";

let seen: Event | undefined;
let seenCtx: Context | undefined;

async function echo(event: Event, ctx: Context) {
  seen = event;
  seenCtx = ctx;
  if (event.http) {
    const id = event.http.pathParams.id;
    if (id === "missing") throw new NotFound("nope");
    if (id === "png") return new HttpResponse(200, new Uint8Array([0x89, 0x50]), { "content-type": "image/png" });
    if (id === "text") return "plain";
    return { id, q: event.http.query, body: event.http.json(null) };
  }
  if ((event.data as { boom?: boolean } | null)?.boom) throw new RangeError("bad input");
  return { type: event.type, data: event.data };
}

const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");

beforeEach(() => {
  seen = undefined;
  process.env.NSKIT_FUNCTION = "users";
  installBundle({
    manifest: {
      service: "demo",
      stage: "dev",
      region: "",
      workflows: {},
      provider: "ibm",
      functions: {
        users: {
          handler: "t.echo",
          routes: [
            { method: "GET", path: "/users/{id}" },
            { method: "POST", path: "/users/{id}" },
          ],
        },
      },
    },
    handlers: { "t.echo": async () => echo },
  });
});
afterEach(() => {
  delete process.env.NSKIT_FUNCTION;
});

test("GET with query: unfolded query params are not mistaken for a body", async () => {
  const out = await main({
    __ce_method: "GET",
    __ce_path: "/users/7",
    __ce_headers: { "X-Request-Id": "abc" },
    __ce_query: "a=1&a=2",
    a: "2",
  });
  expect(out.statusCode).toBe(200);
  expect(out.body).toEqual({ id: "7", q: { a: "2" }, body: null }); // JSON responses are returned as objects
  expect(out.headers["content-type"]).toBe("application/json");
  expect(seen?.http?.multiQuery).toEqual({ a: ["1", "2"] });
  expect(seenCtx?.requestId).toBe("abc");
});

test("JSON body arrives base64-encoded in __ce_body (and unfolded)", async () => {
  const out = await main({
    __ce_method: "POST",
    __ce_path: "/users/9",
    __ce_headers: { "Content-Type": "application/json" },
    __ce_body: b64('{"name":"ada"}'),
    name: "ada",
  });
  expect((out.body as { body: unknown }).body).toEqual({ name: "ada" });
});

test("JSON merged into params without a raw body", async () => {
  const out = await main({ __ce_method: "POST", __ce_path: "/users/9", __ce_headers: {}, name: "ada" });
  expect((out.body as { body: unknown }).body).toEqual({ name: "ada" });
});

test("body decoding per content type", () => {
  expect(Buffer.from(requestBody("a=1&b=2", { "Content-Type": "application/x-www-form-urlencoded" })).toString()).toBe("a=1&b=2");
  expect(Buffer.from(requestBody("hello", { "Content-Type": "text/plain" })).toString()).toBe("hello");
  expect(Buffer.from(requestBody('{"a":1}', { "Content-Type": "application/json" })).toString()).toBe('{"a":1}');
  expect(Buffer.from(requestBody(b64('{"a":1}'), {})).toString()).toBe('{"a":1}');
  expect([...requestBody(b64(new Uint8Array([0, 1, 255])), { "content-type": "application/octet-stream" })]).toEqual([0, 1, 255]);
});

test("OpenWhisk prefix and base64 binary body", async () => {
  await main({
    __ow_method: "post",
    __ow_path: "/users/1",
    __ow_headers: { "content-type": "application/octet-stream" },
    __ow_body: b64(new Uint8Array([0, 1])),
  });
  expect([...(seen?.http?.body ?? [])]).toEqual([0, 1]);
  expect(seen?.http?.method).toBe("POST");
});

test("responses: errors, binary and text", async () => {
  const missing = await main({ __ce_method: "GET", __ce_path: "/users/missing", __ce_headers: {} });
  expect(missing.statusCode).toBe(404);
  expect(missing.body).toMatchObject({ error: "nope" });
  const png = await main({ __ce_method: "GET", __ce_path: "/users/png", __ce_headers: {} });
  expect(png.body).toBe(b64(new Uint8Array([0x89, 0x50])));
  const text = await main({ __ce_method: "GET", __ce_path: "/users/text", __ce_headers: {} });
  expect(text.body).toBe("plain");
  expect(toNative({ status: 200, headers: { "content-type": "application/xml" }, body: "<a/>", isBase64: false }).body).toBe(b64("<a/>"));
});

test("envelope over HTTP is a non-HTTP event", async () => {
  const out = await main({
    __ce_method: "POST",
    __ce_path: "/",
    __ce_headers: { "content-type": "application/json" },
    __ce_body: b64(JSON.stringify({ __nskit: "invoke", data: { x: 1 } })),
  });
  expect(out.statusCode).toBe(200);
  expect(out.body).toEqual({ type: "invoke", data: { x: 1 } });
});

test("direct params, envelopes and errors", async () => {
  expect((await main({ k: "v" })).body).toEqual({ type: "invoke", data: { k: "v" } });
  expect((await main({ __nskit: "workflow", data: { n: 1 } })).body).toEqual({ type: "workflow", data: { n: 1 } });
  const failed = await main({ __nskit: "invoke", data: { boom: true } });
  expect(failed.statusCode).toBe(500);
  expect(failed.body).toEqual({ errorType: "RangeError", cause: "bad input" });
  expect((await main(undefined)).body).toEqual({ type: "invoke", data: {} });
});
