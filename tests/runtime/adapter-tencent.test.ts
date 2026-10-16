import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { main_handler, toContext, toEvent, toNative } from "../../src/runtime/adapters/tencent";
import { envelope } from "../../src/runtime/envelope";
import type { Event } from "../../src/runtime/event";
import { installBundle } from "../../src/runtime/manifest";
import { HttpResponse } from "../../src/runtime/response";

const APIGW = {
  requestContext: {
    serviceId: "service-abc",
    path: "/users/{id}",
    httpMethod: "POST",
    requestId: "req-1",
    sourceIp: "10.0.0.1",
    stage: "release",
  },
  headers: { "Content-Type": "application/json", Host: "service-abc.gz.apigw.tencentcs.com" },
  body: '{"name": "ada"}',
  pathParameters: { id: "42" },
  queryStringParameters: { q: "1" },
  queryString: { q: "1", tag: ["a", "b"] },
  headerParameters: {},
  stageVariables: { stage: "release" },
  path: "/users/42",
  httpMethod: "POST",
  isBase64Encoded: false,
};

const TIMER = {
  Type: "Timer",
  TriggerName: "timer-1",
  Time: "2026-10-15T08:00:00Z",
  Message: JSON.stringify(envelope("schedule", { report: "weekly" })),
};

const COS = {
  Records: [
    {
      cos: {
        cosSchemaVersion: "1.0",
        cosObject: {
          url: "http://uploads-1250000000.cos.ap-guangzhou.myqcloud.com/in/a%20b.csv",
          meta: { "x-cos-request-id": "r1" },
          key: "/1250000000/uploads/in/a%20b.csv",
          size: 7,
        },
        cosBucket: { region: "gz", name: "uploads", appid: "1250000000" },
      },
      event: { eventName: "cos:ObjectCreated:Put", eventTime: 1760515200 },
    },
  ],
};

const CTX = {
  callbackWaitsForEmptyEventLoop: true,
  memory_limit_in_mb: 128,
  time_limit_in_ms: 3000,
  request_id: "req-ctx",
  function_name: "demo-dev-api",
  namespace: "default",
  tencentcloud_region: "ap-guangzhou",
};

describe("tencent adapter", () => {
  test("API Gateway event", () => {
    const event = toEvent(APIGW, CTX);
    expect(event.type).toBe("http");
    const req = event.http!;
    expect([req.method, req.path]).toEqual(["POST", "/users/42"]);
    expect(req.pathParams).toEqual({ id: "42" });
    expect(req.query.tag).toBe("b");
    expect(req.multiQuery.tag).toEqual(["a", "b"]);
    expect(req.json()).toEqual({ name: "ada" });
    expect(req.sourceIp).toBe("10.0.0.1");
  });

  test("query string as text and queryStringParameters fallback", () => {
    const req = toEvent({ ...APIGW, queryString: "a=1&a=2&b=x+y", queryStringParameters: null }).http!;
    expect(req.query).toEqual({ a: "2", b: "x y" });
    expect(req.multiQuery.a).toEqual(["1", "2"]);
    const fallback = toEvent({ ...APIGW, queryString: undefined }).http!;
    expect(fallback.query).toEqual({ q: "1" });
  });

  test("timer and COS", () => {
    const timer = toEvent(TIMER);
    expect(timer.type).toBe("schedule");
    expect(timer.data).toEqual({ report: "weekly" });
    expect(timer.source).toBe("timer-1");
    const noMsg = toEvent({ Type: "Timer", TriggerName: "t", Time: "2026-10-15T08:00:00Z", Message: "" });
    expect(noMsg.data).toBeUndefined();
    const cos = toEvent(COS);
    expect(cos.type).toBe("storage");
    const rec = cos.records[0];
    expect([rec.bucket, rec.key, rec.size, rec.action, rec.id]).toEqual(["uploads", "in/a b.csv", 7, "created", "r1"]);
    expect(cos.time.getTime()).toBe(1760515200000);
  });

  test("envelope, invoke and context", () => {
    expect(toEvent(envelope("workflow", [1])).data).toEqual([1]);
    expect(toEvent({ a: 1 }).type).toBe("invoke");
    const ctx = toContext(CTX, "api");
    expect(ctx.requestId).toBe("req-ctx");
    expect(ctx.memoryMb).toBe(128);
    expect(ctx.region).toBe("ap-guangzhou");
    const remaining = ctx.remainingTimeMs()!;
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(3000);
  });

  test("native response is base64 for binary bodies", () => {
    const event = toEvent(APIGW);
    const out = toNative(HttpResponse.binary(new Uint8Array([0, 1]), "image/png"), event) as Record<string, unknown>;
    expect(out.isBase64Encoded).toBe(true);
    expect(out.statusCode).toBe(200);
  });

  describe("end to end", () => {
    beforeEach(() => {
      installBundle({
        manifest: {
          service: "demo",
          stage: "dev",
          region: "",
          workflows: {},
          provider: "tencent",
          functions: { api: { handler: "app.api", routes: [{ method: "POST", path: "/users/{id}" }] } },
        },
        handlers: {
          "app.api": () => (event: Event) =>
            HttpResponse.json({ id: event.http!.pathParams.id, ...(event.http!.json() as object) }, 201),
        },
      });
    });
    afterEach(() => {
      delete process.env.NSKIT_FUNCTION;
      installBundle({});
    });

    test("main_handler", async () => {
      process.env.NSKIT_FUNCTION = "api";
      const out = (await main_handler(APIGW, CTX)) as Record<string, unknown>;
      expect(out.statusCode).toBe(201);
      expect(JSON.parse(out.body as string)).toEqual({ id: "42", name: "ada" });
      // wrong method on a matched path -> 405 from the portable router
      const bad = (await main_handler({ ...APIGW, httpMethod: "DELETE" }, CTX)) as Record<string, unknown>;
      expect(bad.statusCode).toBe(405);
    });
  });
});
