import { describe, expect, it } from "vitest";
import { BatchFailure, BatchResult, isBatchResult, processBatch } from "../../src/runtime/batch.js";
import { Context } from "../../src/runtime/context.js";
import {
  BadRequest,
  Conflict,
  errorMessage,
  errorName,
  Forbidden,
  HandlerNotFound,
  HttpError,
  isHttpError,
  MethodNotAllowed,
  NotFound,
  NskitError,
  ServiceUnavailable,
  TooManyRequests,
  Unauthorized,
  UnprocessableEntity,
} from "../../src/runtime/errors.js";
import { Event, EventRecord, EventType, EVENT_TYPES, Headers, HttpRequest, parseCookies, parseTime } from "../../src/runtime/event.js";
import { base64Decode, base64Encode, maybeJson, toBytes, truthy, utf8DecodeStrict } from "../../src/runtime/util.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("Headers", () => {
  it("is case-insensitive and joins multi-values", () => {
    const h = new Headers({ "Content-Type": "application/json", "X-Multi": ["a", "b"], Skip: undefined, Nul: null, Num: 5 });
    expect(h.get("content-type")).toBe("application/json");
    expect(h.get("CONTENT-TYPE")).toBe("application/json");
    expect(h.get("x-multi")).toBe("a, b");
    expect(h.get("num")).toBe("5");
    expect(h.has("skip")).toBe(false);
    expect(h.has("nul")).toBe(false);
    expect(h.get("missing")).toBeUndefined();
    expect(h.get("missing", "dflt")).toBe("dflt");
    expect(h.size).toBe(3);
    expect([...h.keys()]).toEqual(["content-type", "x-multi", "num"]);
    expect(h.toJSON()).toEqual({ "content-type": "application/json", "x-multi": "a, b", num: "5" });
    expect(h.toObject()).toEqual(h.toJSON());
    expect(JSON.stringify(h)).toBe('{"content-type":"application/json","x-multi":"a, b","num":"5"}');
  });

  it("merges duplicate names differing in case", () => {
    expect(new Headers({ Accept: "a", accept: "b" }).get("accept")).toBe("a, b");
  });

  it("accepts iterables, Headers and nothing", () => {
    const fromPairs = new Headers([
      ["A", "1"],
      ["a", "2"],
    ]);
    expect(fromPairs.get("a")).toBe("1, 2");
    expect(new Headers(fromPairs).get("A")).toBe("1, 2");
    expect(new Headers(new Map([["X", "y"]])).get("x")).toBe("y");
    expect(new Headers().size).toBe(0);
    expect(new Headers(null).size).toBe(0);
    expect([...new Headers({ a: "1" })]).toEqual([["a", "1"]]);
  });
});

describe("HttpRequest", () => {
  it("has defaults", () => {
    const req = new HttpRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/");
    expect(req.body).toEqual(new Uint8Array());
    expect(req.query).toEqual({});
    expect(req.multiQuery).toEqual({});
    expect(req.pathParams).toEqual({});
    expect(req.contentType).toBe("");
    expect(req.cookies).toEqual({});
    expect(req.text()).toBe("");
  });

  it("normalizes method, headers and body", () => {
    const req = new HttpRequest({
      method: "post",
      path: "/x",
      headers: { "Content-Type": "Application/JSON; charset=utf-8" },
      body: '{"a": 1}',
      sourceIp: "1.2.3.4",
      route: "/x",
    });
    expect(req.method).toBe("POST");
    expect(req.contentType).toBe("application/json");
    expect(req.json()).toEqual({ a: 1 });
    expect(req.sourceIp).toBe("1.2.3.4");
    expect(req.route).toBe("/x");
    const headers = new Headers({ a: "1" });
    expect(new HttpRequest({ headers }).headers).toBe(headers);
  });

  it("derives multiQuery from query and query from multiQuery", () => {
    expect(new HttpRequest({ query: { a: "1" } }).multiQuery).toEqual({ a: ["1"] });
    const req = new HttpRequest({ multiQuery: { a: ["1", "2"], e: [] } });
    expect(req.query).toEqual({ a: "2" });
    expect(req.multiQuery).toEqual({ a: ["1", "2"], e: [] });
    const both = new HttpRequest({ query: { a: "x" }, multiQuery: { a: ["1", "2"] } });
    expect(both.query).toEqual({ a: "x" });
  });

  it("copies its inputs", () => {
    const query = { a: "1" };
    const req = new HttpRequest({ query });
    req.query.b = "2";
    expect(query).toEqual({ a: "1" });
  });

  it("json() raises BadRequest with details unless a fallback is given", () => {
    const empty = new HttpRequest();
    expect(() => empty.json()).toThrow(BadRequest);
    expect(() => empty.json()).toThrow("Request body is empty, expected JSON");
    const bad = new HttpRequest({ body: "{nope" });
    let err: unknown;
    try {
      bad.json();
    } catch (e) {
      err = e;
    }
    expect(isHttpError(err)).toBe(true);
    expect((err as BadRequest).status).toBe(400);
    expect((err as BadRequest).message).toBe("Request body is not valid JSON");
    expect(typeof (err as BadRequest).details).toBe("string");
    expect(bad.json(null)).toBeNull();
    expect(bad.json({ d: 1 })).toEqual({ d: 1 });
    expect(new HttpRequest({ body: "[1,2]" }).json()).toEqual([1, 2]);
    expect(new HttpRequest({ body: "null" }).json("fallback")).toBeNull();
  });

  it("parses forms, text and cookies", () => {
    const req = new HttpRequest({
      body: "a=1&b=hello+world&c=%C3%A9",
      headers: { cookie: "sid=abc; theme=dark%20blue; bad=%E0%A4%A; noeq; =x" },
    });
    expect(req.form()).toEqual({ a: "1", b: "hello world", c: "é" });
    expect(req.text()).toBe("a=1&b=hello+world&c=%C3%A9");
    expect(req.cookies).toEqual({ sid: "abc", theme: "dark blue", bad: "%E0%A4%A" });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("a=b=c")).toEqual({ a: "b=c" });
  });

  it("decodes UTF-8 text", () => {
    expect(new HttpRequest({ body: enc("héllo ✓") }).text()).toBe("héllo ✓");
  });

  it("decodeBody handles base64, bytes and objects", () => {
    expect(HttpRequest.decodeBody(undefined)).toEqual(new Uint8Array());
    expect(HttpRequest.decodeBody(null, true)).toEqual(new Uint8Array());
    expect(new TextDecoder().decode(HttpRequest.decodeBody("aGVsbG8=", true))).toBe("hello");
    expect(new TextDecoder().decode(HttpRequest.decodeBody("aGVsbG8=", false))).toBe("aGVsbG8=");
    expect(new TextDecoder().decode(HttpRequest.decodeBody(enc("aGk="), true))).toBe("hi");
    expect(HttpRequest.decodeBody(enc("raw"))).toEqual(enc("raw"));
    expect(new TextDecoder().decode(HttpRequest.decodeBody({ a: 1 }))).toBe('{"a":1}');
    expect(() => HttpRequest.decodeBody("not base64!!", true)).toThrow(/invalid base64/);
  });

  it("decodes binary base64 bodies exactly", () => {
    const bytes = new Uint8Array([0, 255, 1, 128, 10]);
    expect(HttpRequest.decodeBody(base64Encode(bytes), true)).toEqual(bytes);
  });
});

describe("EventRecord", () => {
  it("text() and json() for every body shape", () => {
    expect(new EventRecord({ body: '{"a":1}' }).json()).toEqual({ a: 1 });
    const obj = { a: 1 };
    expect(new EventRecord({ body: obj }).json()).toBe(obj);
    expect(new EventRecord({ body: obj }).text()).toBe('{"a":1}');
    expect(new EventRecord({ body: enc('{"b":2}') }).json()).toEqual({ b: 2 });
    expect(new EventRecord({ body: enc("bytes") }).text()).toBe("bytes");
    expect(new EventRecord({ body: 42 }).text()).toBe("42");
    expect(new EventRecord({ body: 42 }).json()).toBe(42);
    expect(new EventRecord().text()).toBe("");
    expect(new EventRecord({ body: null }).text()).toBe("");
  });

  it("json() errors mention the record id; fallback is honoured", () => {
    expect(() => new EventRecord({ id: "m1", body: "nope" }).json()).toThrow("Record m1 body is not valid JSON");
    expect(() => new EventRecord({ body: "" }).json()).toThrow("Record body is empty, expected JSON");
    expect(new EventRecord({ body: "nope" }).json("fb")).toBe("fb");
  });

  it("keeps storage fields and copies attributes", () => {
    const attrs = { a: 1 };
    const r = new EventRecord({ id: "1", bucket: "b", key: "k", size: 3, action: "deleted", attributes: attrs, source: "s", raw: { x: 1 } });
    expect(r).toMatchObject({ id: "1", bucket: "b", key: "k", size: 3, action: "deleted", source: "s", raw: { x: 1 } });
    r.attributes.b = 2;
    expect(attrs).toEqual({ a: 1 });
  });
});

describe("Event", () => {
  it("has defaults and type helpers", () => {
    const ev = new Event({ type: EventType.QUEUE });
    expect(ev.provider).toBe("local");
    expect(ev.functionName).toBe("");
    expect(ev.records).toEqual([]);
    expect(ev.time).toBeInstanceOf(Date);
    expect(ev.isBatch).toBe(true);
    expect(ev.isHttp).toBe(false);
    expect(new Event({ type: "topic" }).isBatch).toBe(true);
    expect(new Event({ type: "storage" }).isBatch).toBe(true);
    expect(new Event({ type: "invoke" }).isBatch).toBe(false);
    expect(new Event({ type: "http", http: new HttpRequest() }).isHttp).toBe(true);
    expect(EVENT_TYPES).toEqual(["http", "schedule", "queue", "storage", "topic", "invoke", "workflow"]);
  });

  it("json() picks the http body, first record or data", () => {
    expect(new Event({ type: "http", http: new HttpRequest({ body: '{"h":1}' }) }).json()).toEqual({ h: 1 });
    expect(new Event({ type: "http", http: new HttpRequest() }).json("fb")).toBe("fb");
    expect(() => new Event({ type: "http", http: new HttpRequest() }).json()).toThrow(BadRequest);
    const recs = [new EventRecord({ body: '{"r":1}' }), new EventRecord({ body: '{"r":2}' })];
    expect(new Event({ type: "queue", records: recs }).json()).toEqual({ r: 1 });
    expect(new Event({ type: "queue", records: [new EventRecord({ body: "x" })] }).json("fb")).toBe("fb");
    expect(new Event({ type: "invoke", data: { d: 1 } }).json()).toEqual({ d: 1 });
    expect(new Event({ type: "invoke" }).json()).toBeUndefined();
  });

  it("is iterable over records", () => {
    const recs = [new EventRecord({ id: "1" }), new EventRecord({ id: "2" })];
    expect([...new Event({ type: "queue", records: recs })].map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("toJSON() summarizes", () => {
    const time = new Date("2024-01-02T03:04:05.000Z");
    const http = new Event({
      type: "http",
      provider: "aws",
      functionName: "f",
      time,
      source: "src",
      http: new HttpRequest({ method: "POST", path: "/p", query: { q: "1" }, pathParams: { id: "7" }, body: "secret" }),
    });
    expect(http.toJSON()).toEqual({
      type: "http",
      provider: "aws",
      functionName: "f",
      time: "2024-01-02T03:04:05.000Z",
      source: "src",
      http: { method: "POST", path: "/p", query: { q: "1" }, pathParams: { id: "7" } },
    });
    const q = new Event({ type: "queue", time, records: [new EventRecord(), new EventRecord()], data: { x: 1 } });
    expect(q.toJSON()).toMatchObject({ records: 2, data: { x: 1 } });
    expect(new Event({ type: "invoke", time }).toJSON()).not.toHaveProperty("data");
  });
});

describe("parseTime", () => {
  it.each([
    [1704067200, "2024-01-01T00:00:00.000Z"],
    [1704067200000, "2024-01-01T00:00:00.000Z"],
    ["1704067200", "2024-01-01T00:00:00.000Z"],
    ["1704067200123", "2024-01-01T00:00:00.123Z"],
    ["2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z"],
    ["2024-01-01T05:30:00+05:30", "2024-01-01T00:00:00.000Z"],
  ])("%j", (input, iso) => {
    expect(parseTime(input).toISOString()).toBe(iso);
  });

  it("passes dates through and falls back to now", () => {
    const d = new Date(0);
    expect(parseTime(d)).toBe(d);
    for (const bad of [undefined, null, "", "garbage", NaN, {}]) {
      expect(Math.abs(parseTime(bad).getTime() - Date.now())).toBeLessThan(5000);
    }
  });
});

describe("errors", () => {
  it.each([
    [BadRequest, 400, "Bad Request"],
    [Unauthorized, 401, "Unauthorized"],
    [Forbidden, 403, "Forbidden"],
    [NotFound, 404, "Not Found"],
    [MethodNotAllowed, 405, "Method Not Allowed"],
    [Conflict, 409, "Conflict"],
    [UnprocessableEntity, 422, "Unprocessable Entity"],
    [TooManyRequests, 429, "Too Many Requests"],
    [ServiceUnavailable, 503, "Service Unavailable"],
    [HttpError, 500, "Internal Server Error"],
  ])("%o has status %i", (Cls, status, message) => {
    const err = new Cls();
    expect(err.status).toBe(status);
    expect(err.message).toBe(message);
    expect(err.name).toBe(Cls.name);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.toBody()).toEqual({ error: message, status });
  });

  it("supports message, status override, details, headers and cause", () => {
    const cause = new Error("root");
    const err = new TooManyRequests("slow down", { details: { retry: 5 }, headers: { "retry-after": "5" }, cause });
    expect(err.toBody()).toEqual({ error: "slow down", status: 429, details: { retry: 5 } });
    expect(err.headers).toEqual({ "retry-after": "5" });
    expect(err.cause).toBe(cause);
    expect(new HttpError("teapot", { status: 418 }).status).toBe(418);
    expect(new HttpError("x").cause).toBeUndefined();
  });

  it("isHttpError works across copies of the library", () => {
    const foreign = { [Symbol.for("node-serverless-kit.HttpError")]: true, status: 404, message: "x" };
    expect(isHttpError(foreign)).toBe(true);
    expect(isHttpError(new NotFound())).toBe(true);
    expect(isHttpError(new Error("x"))).toBe(false);
    expect(isHttpError(null)).toBe(false);
    expect(isHttpError("NotFound")).toBe(false);
    expect(isHttpError({ status: 404 })).toBe(false);
  });

  it("NskitError subclasses keep their name", () => {
    const err = new HandlerNotFound("nope");
    expect(err).toBeInstanceOf(NskitError);
    expect(err.name).toBe("HandlerNotFound");
  });

  it("errorName and errorMessage", () => {
    class Flaky extends Error {}
    expect(errorName(new Flaky("x"))).toBe("Flaky");
    expect(errorName(new TypeError("x"))).toBe("TypeError");
    expect(errorName(new NotFound())).toBe("NotFound");
    expect(errorName({ error: "Custom.Error", name: "Other" })).toBe("Custom.Error");
    expect(errorName(Object.assign(new Error("x"), { name: "Timeout" }))).toBe("Timeout");
    expect(errorName(new Error("plain"))).toBe("Error");
    expect(errorName({})).toBe("Error");
    expect(errorName("string")).toBe("Error");
    expect(errorName(null)).toBe("Error");
    expect(errorMessage(new Error("m"))).toBe("m");
    expect(errorMessage("s")).toBe("s");
    expect(errorMessage({ a: 1 })).toBe('{"a":1}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(errorMessage(circular)).toBe("[object Object]");
  });
});

describe("BatchResult / processBatch", () => {
  it("collects failures by record or id", () => {
    const r = new BatchResult();
    expect(r.ok).toBe(true);
    r.fail(new EventRecord({ id: "a" })).fail("b").fail(new EventRecord());
    expect(r.failed).toEqual(["a", "b"]);
    expect(r.ok).toBe(false);
    expect(r.toJSON()).toEqual({ failed: ["a", "b"] });
    expect(BatchResult.of(["x", new EventRecord({ id: "y" })]).failed).toEqual(["x", "y"]);
  });

  it("throwIfFailed raises BatchFailure", () => {
    new BatchResult().throwIfFailed();
    const ids = Array.from({ length: 12 }, (_, i) => `m${i}`);
    let err: unknown;
    try {
      BatchResult.of(ids).throwIfFailed();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BatchFailure);
    expect((err as BatchFailure).failedIds).toEqual(ids);
    expect((err as BatchFailure).message).toBe("12 record(s) failed: m0, m1, m2, m3, m4, m5, m6, m7, m8, m9");
    expect((err as BatchFailure).name).toBe("BatchFailure");
  });

  it("isBatchResult works across copies", () => {
    expect(isBatchResult(new BatchResult())).toBe(true);
    expect(isBatchResult({ [Symbol.for("node-serverless-kit.BatchResult")]: true, failed: [] })).toBe(true);
    expect(isBatchResult({ failed: [] })).toBe(false);
    expect(isBatchResult(undefined)).toBe(false);
  });

  it("processBatch keeps record order, reports errors and limits concurrency", async () => {
    const records = Array.from({ length: 10 }, (_, i) => new EventRecord({ id: String(i), body: String(i) }));
    let active = 0;
    let peak = 0;
    const errors: string[] = [];
    const result = await processBatch(
      records,
      async (r) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((res) => setTimeout(res, 5 + (10 - Number(r.id))));
        active--;
        if (Number(r.id) % 3 === 0) throw new Error(`bad ${r.id}`);
      },
      { concurrency: 3, onError: (r, e) => errors.push(`${r.id}:${(e as Error).message}`) },
    );
    expect(result.failed).toEqual(["0", "3", "6", "9"]);
    expect(peak).toBe(3);
    expect(errors.sort()).toEqual(["0:bad 0", "3:bad 3", "6:bad 6", "9:bad 9"]);
  });

  it("processBatch defaults to sequential and handles empty input", async () => {
    let active = 0;
    let peak = 0;
    await processBatch([new EventRecord({ id: "1" }), new EventRecord({ id: "2" })], async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
    });
    expect(peak).toBe(1);
    expect((await processBatch([], () => undefined)).ok).toBe(true);
    const sync = await processBatch([new EventRecord({ id: "s" })], () => {
      throw new Error("sync");
    });
    expect(sync.failed).toEqual(["s"]);
  });
});

describe("Context", () => {
  it("defaults from the environment", () => {
    process.env.NSKIT_SERVICE = "svc";
    process.env.NSKIT_STAGE = "dev";
    process.env.NSKIT_REGION = "r1";
    try {
      const ctx = new Context();
      expect(ctx.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(ctx).toMatchObject({ functionName: "", provider: "local", service: "svc", stage: "dev", region: "r1" });
      expect(ctx.remainingTimeMs()).toBeUndefined();
      expect(ctx.env.NSKIT_SERVICE).toBe("svc");
      expect(ctx.logger).toBe(ctx.logger);
    } finally {
      delete process.env.NSKIT_SERVICE;
      delete process.env.NSKIT_STAGE;
      delete process.env.NSKIT_REGION;
    }
  });

  it("remaining time from a callback or a deadline", () => {
    expect(new Context({ remainingTimeMs: () => 1234.9 }).remainingTimeMs()).toBe(1234);
    expect(new Context({ remainingTimeMs: () => -5 }).remainingTimeMs()).toBe(0);
    const left = new Context({ deadline: Date.now() + 10_000 }).remainingTimeMs()!;
    expect(left).toBeGreaterThan(9000);
    expect(left).toBeLessThanOrEqual(10_000);
    expect(new Context({ deadline: Date.now() - 1 }).remainingTimeMs()).toBe(0);
  });

  it("waitUntil delegates to the platform or queues the promise", async () => {
    const seen: Promise<unknown>[] = [];
    const p = Promise.resolve(1);
    new Context({ waitUntil: (pr) => seen.push(pr) }).waitUntil(p);
    expect(seen).toEqual([p]);
    const ctx = new Context();
    ctx.waitUntil(Promise.reject(new Error("bg")));
    expect(ctx.pending).toHaveLength(1);
    await expect(ctx.pending[0]).resolves.toBeUndefined();
  });
});

describe("util", () => {
  it("base64 round-trips (standard and URL-safe)", () => {
    const bytes = new Uint8Array([251, 255, 191, 0, 1]);
    const b64 = base64Encode(bytes);
    expect(base64Decode(b64)).toEqual(bytes);
    expect(base64Decode(b64.replace(/\+/g, "-").replace(/\//g, "_"))).toEqual(bytes);
    expect(base64Decode("aGk")).toEqual(enc("hi"));
    expect(base64Decode(" aG\nk= ")).toEqual(enc("hi"));
    expect(() => base64Decode("a")).toThrow("invalid base64");
    expect(() => base64Decode("ab$c")).toThrow("invalid base64");
  });

  it("toBytes, maybeJson, truthy, strict decoding", () => {
    expect(toBytes(undefined)).toEqual(new Uint8Array());
    expect(toBytes("é")).toEqual(enc("é"));
    expect(toBytes(new Uint8Array([1]).buffer)).toEqual(new Uint8Array([1]));
    expect(toBytes(new DataView(new Uint8Array([1, 2, 3]).buffer, 1, 2))).toEqual(new Uint8Array([2, 3]));
    expect(toBytes({ a: 1 })).toEqual(enc('{"a":1}'));
    expect(maybeJson('{"a":1}')).toEqual({ a: 1 });
    expect(maybeJson(" [1] ")).toEqual([1]);
    expect(maybeJson("true")).toBe(true);
    expect(maybeJson("null")).toBeNull();
    expect(maybeJson("plain")).toBe("plain");
    expect(maybeJson("{broken")).toBe("{broken");
    expect(maybeJson("42")).toBe("42");
    expect(maybeJson(enc('{"b":2}'))).toEqual({ b: 2 });
    const bin = new Uint8Array([0xff, 0xfe]);
    expect(maybeJson(bin)).toBe(bin);
    expect(maybeJson(5)).toBe(5);
    expect(utf8DecodeStrict(bin)).toBeUndefined();
    for (const v of ["1", "true", "YES", "on"]) expect(truthy(v)).toBe(true);
    for (const v of ["0", "false", "", undefined, "nope"]) expect(truthy(v)).toBe(false);
  });
});
