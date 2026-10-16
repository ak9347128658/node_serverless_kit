import { describe, expect, it } from "vitest";
import { dumps, HttpResponse, isHttpResponse, isTextContentType, toResponse, toResponseAsync } from "../../src/runtime/response.js";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("constructors", () => {
  it("json", () => {
    const r = HttpResponse.json({ a: 1 }, 201, { "X-Id": "7" });
    expect(r.status).toBe(201);
    expect(r.body).toBe('{"a":1}');
    expect(r.headers).toEqual({ "content-type": "application/json", "X-Id": "7" });
    expect(HttpResponse.json(null).body).toBe("null");
    expect(HttpResponse.json(undefined).body).toBe("null");
    expect(HttpResponse.json({ a: 1 }, 200, { "content-type": "application/problem+json" }).contentType).toBe("application/problem+json");
  });

  it("text, html, binary, redirect, noContent", () => {
    expect(HttpResponse.text("hi")).toMatchObject({ status: 200, body: "hi", headers: { "content-type": "text/plain; charset=utf-8" } });
    expect(HttpResponse.text("no", 404).status).toBe(404);
    expect(HttpResponse.html("<b>x</b>").headers["content-type"]).toBe("text/html; charset=utf-8");
    const bin = HttpResponse.binary(new Uint8Array([1, 2]).buffer, "image/png", 200, { "cache-control": "max-age=1" });
    expect(bin.body).toEqual(new Uint8Array([1, 2]));
    expect(bin.headers).toEqual({ "content-type": "image/png", "cache-control": "max-age=1" });
    expect(HttpResponse.binary(new Uint8Array([9])).contentType).toBe("application/octet-stream");
    expect(HttpResponse.redirect("/next")).toMatchObject({ status: 302, headers: { location: "/next" } });
    expect(HttpResponse.redirect("/perm", 301).status).toBe(301);
    expect(HttpResponse.noContent()).toMatchObject({ status: 204, body: "" });
    const plain = new HttpResponse();
    expect(plain).toMatchObject({ status: 200, body: undefined, headers: {}, cookies: [] });
  });

  it("copies headers and cookies passed in", () => {
    const headers = { a: "1" };
    const cookies = ["c=1"];
    const r = new HttpResponse(200, "", headers, cookies);
    r.setHeader("B", "2");
    r.cookies.push("d=2");
    expect(headers).toEqual({ a: "1" });
    expect(cookies).toEqual(["c=1"]);
    expect(r.headers).toEqual({ a: "1", b: "2" });
  });

  it("contentType is case-insensitive", () => {
    expect(new HttpResponse(200, "", { "Content-Type": "text/csv" }).contentType).toBe("text/csv");
    expect(new HttpResponse().contentType).toBe("");
  });
});

describe("cookies", () => {
  it("secure defaults", () => {
    const r = new HttpResponse().setCookie("sid", "a b;c");
    expect(r.cookies).toEqual(["sid=a%20b%3Bc; Path=/; SameSite=Lax; HttpOnly; Secure"]);
  });

  it("all options", () => {
    const expires = new Date("2030-01-01T00:00:00Z");
    const r = HttpResponse.text("x")
      .setCookie("a", "1", { maxAge: 60, expires, path: "/api", domain: "example.com", httpOnly: false, secure: false, sameSite: "Strict" })
      .setCookie("b", "2", { sameSite: "None", maxAge: 0 });
    expect(r.cookies).toEqual([
      "a=1; Path=/api; SameSite=Strict; Max-Age=60; Expires=Tue, 01 Jan 2030 00:00:00 GMT; Domain=example.com",
      "b=2; Path=/; SameSite=None; Max-Age=0; HttpOnly; Secure",
    ]);
  });
});

describe("render", () => {
  it("lower-cases headers and stringifies values", () => {
    const r = new HttpResponse(200.7, "x", { "X-Count": 5 as unknown as string, "Content-Type": "text/csv" });
    expect(r.render()).toEqual({ status: 200, headers: { "x-count": "5", "content-type": "text/csv" }, body: new TextEncoder().encode("x") });
  });

  it("picks a content-type per body kind", () => {
    expect(new HttpResponse(200, "s").render().headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(new HttpResponse(200, new Uint8Array([1])).render().headers["content-type"]).toBe("application/octet-stream");
    expect(new HttpResponse(200, new Uint8Array([1]).buffer).render().body).toEqual(new Uint8Array([1]));
    const obj = new HttpResponse(200, { a: [1] }).render();
    expect(obj.headers["content-type"]).toBe("application/json");
    expect(dec(obj.body)).toBe('{"a":[1]}');
    expect(dec(new HttpResponse(200, 42).render().body)).toBe("42");
  });

  it("empty bodies get no content-type", () => {
    for (const body of [undefined, null, "", new Uint8Array()]) {
      const out = new HttpResponse(204, body).render();
      expect(out.body.length).toBe(0);
      expect(out.headers).toEqual({});
    }
  });
});

describe("renderForGateway", () => {
  it("returns text bodies as strings", () => {
    expect(HttpResponse.json({ a: 1 }).renderForGateway()).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
      isBase64: false,
    });
    for (const ct of ["text/csv", "application/xml", "image/svg+xml", "application/vnd.api+json", "application/atom+xml", "application/javascript"]) {
      expect(new HttpResponse(200, "<x/>", { "content-type": ct }).renderForGateway().isBase64).toBe(false);
    }
  });

  it("base64-encodes binary bodies", () => {
    const png = HttpResponse.binary(new Uint8Array([137, 80, 78, 71]), "image/png").renderForGateway();
    expect(png).toEqual({ status: 200, headers: { "content-type": "image/png" }, body: "iVBORw==", isBase64: true });
    const textual = HttpResponse.binary(new TextEncoder().encode("hello"), "application/octet-stream").renderForGateway();
    expect(textual.isBase64).toBe(true);
    expect(textual.body).toBe("aGVsbG8=");
  });

  it("base64-encodes invalid UTF-8 even with a text content-type", () => {
    const r = new HttpResponse(200, new Uint8Array([0xff, 0xfe]), { "content-type": "text/plain" }).renderForGateway();
    expect(r).toMatchObject({ isBase64: true, body: "//4=" });
  });

  it("empty body", () => {
    expect(HttpResponse.noContent().renderForGateway()).toEqual({ status: 204, headers: {}, body: "", isBase64: false });
  });

  it("isTextContentType", () => {
    expect(isTextContentType("TEXT/HTML; charset=utf-8")).toBe(true);
    expect(isTextContentType("application/x-www-form-urlencoded")).toBe(true);
    expect(isTextContentType("application/pdf")).toBe(false);
    expect(isTextContentType("")).toBe(false);
  });
});

describe("dumps", () => {
  it("handles bigint, Map, Set and bytes", () => {
    expect(dumps({ big: 10n, huge: 2n ** 70n, m: new Map([["k", 1]]), s: new Set([1, 2]), b: new TextEncoder().encode("hi") })).toBe(
      '{"big":10,"huge":"1180591620717411303424","m":{"k":1},"s":[1,2],"b":"hi"}',
    );
    expect(dumps({ bin: new Uint8Array([0xff]) })).toBe('{"bin":"/w=="}');
    expect(dumps(undefined)).toBe("null");
    expect(dumps(() => 1)).toBe("null");
    expect(dumps(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
  });
});

describe("toResponse", () => {
  it("passes HttpResponse through (also foreign copies)", () => {
    const r = HttpResponse.text("x");
    expect(toResponse(r)).toBe(r);
    const foreign = { status: 201, render: () => ({}), renderForGateway: () => ({}), cookies: [] };
    expect(isHttpResponse(foreign)).toBe(true);
    expect(toResponse(foreign)).toBe(foreign);
    expect(isHttpResponse({ status: 200 })).toBe(false);
    expect(isHttpResponse(null)).toBe(false);
  });

  it("coerces primitives and collections", () => {
    expect(toResponse(undefined)).toMatchObject({ status: 204 });
    expect(toResponse(null)).toMatchObject({ status: 204 });
    expect(toResponse("hi")).toMatchObject({ status: 200, body: "hi", headers: { "content-type": "text/plain; charset=utf-8" } });
    expect(toResponse(new Uint8Array([1]))).toMatchObject({ body: new Uint8Array([1]), headers: { "content-type": "application/octet-stream" } });
    expect(toResponse(new Uint8Array([2]).buffer).body).toEqual(new Uint8Array([2]));
    expect(toResponse({ a: 1 })).toMatchObject({ status: 200, body: '{"a":1}', headers: { "content-type": "application/json" } });
    expect(toResponse([1, 2]).body).toBe("[1,2]");
    expect(toResponse(0).body).toBe("0");
    expect(toResponse(false).body).toBe("false");
    expect(toResponse("").status).toBe(200);
  });

  it("accepts AWS Lambda proxy shaped objects", () => {
    const r = toResponse({
      statusCode: 201,
      headers: { "X-A": 1 },
      multiValueHeaders: { "Set-Cookie": ["a=1", "b=2"], "X-Multi": ["x", "y"] },
      cookies: ["c=3"],
      body: "created",
    });
    expect(r.status).toBe(201);
    expect(r.body).toBe("created");
    expect(r.headers).toEqual({ "X-A": "1", "X-Multi": "x, y" });
    expect(r.cookies).toEqual(["c=3", "a=1", "b=2"]);
    expect(toResponse({ statusCode: 204 })).toMatchObject({ status: 204, body: "" });
    expect(toResponse({ statusCode: 200, body: { j: 1 } }).body).toBe('{"j":1}');
    const bin = toResponse({ statusCode: 200, body: "AAEC", isBase64Encoded: true, headers: { "content-type": "image/png" } });
    expect(bin.body).toEqual(new Uint8Array([0, 1, 2]));
    expect(bin.renderForGateway()).toMatchObject({ body: "AAEC", isBase64: true });
  });

  it("treats objects that merely contain statusCode as JSON data", () => {
    const data = { statusCode: 200, order: 1 };
    expect(toResponse(data)).toMatchObject({ status: 200, body: '{"statusCode":200,"order":1}' });
    expect(toResponse({ statusCode: "200", body: "x" }).body).toBe('{"statusCode":"200","body":"x"}');
  });

  it("serializes class instances via toJSON", () => {
    class Money {
      toJSON() {
        return "1.00 EUR";
      }
    }
    expect(toResponse(new Money()).body).toBe('"1.00 EUR"');
  });

  it("toResponseAsync converts WHATWG Response objects", async () => {
    const native = new Response("<p>hi</p>", { status: 202, headers: { "content-type": "text/html", "x-a": "1" } });
    native.headers.append("set-cookie", "a=1; Path=/");
    native.headers.append("set-cookie", "b=2; Path=/");
    const r = await toResponseAsync(native);
    expect(r.status).toBe(202);
    expect(r.headers).toEqual({ "content-type": "text/html", "x-a": "1" });
    expect(r.cookies).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(dec(r.body as Uint8Array)).toBe("<p>hi</p>");
    expect(r.renderForGateway()).toMatchObject({ body: "<p>hi</p>", isBase64: false });
    expect((await toResponseAsync(new Response(null, { status: 204 }))).render().body.length).toBe(0);
    expect(await toResponseAsync({ a: 1 })).toMatchObject({ body: '{"a":1}' });
  });
});
