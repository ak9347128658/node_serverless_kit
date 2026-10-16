import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler, toContext, toEvent, toNative } from "../../src/runtime/adapters/aws.js";
import { BatchResult } from "../../src/runtime/batch.js";
import { envelope } from "../../src/runtime/envelope.js";
import type { Context } from "../../src/runtime/context.js";
import type { Event } from "../../src/runtime/event.js";
import { setLogSink } from "../../src/runtime/log.js";
import { installBundle } from "../../src/runtime/manifest.js";
import { HttpResponse } from "../../src/runtime/response.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");

const HTTP_V2 = {
  version: "2.0",
  routeKey: "GET /users/{id}",
  rawPath: "/users/42",
  rawQueryString: "a=1&a=2&b=x",
  cookies: ["sid=1", "theme=dark"],
  headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4" },
  queryStringParameters: { a: "1,2", b: "x" },
  pathParameters: { id: "42" },
  requestContext: { http: { method: "GET", path: "/users/42", sourceIp: "1.2.3.4" }, requestId: "gw-1" },
  body: b64('{"x": 1}'),
  isBase64Encoded: true,
};

const FUNCTION_URL = {
  version: "2.0",
  routeKey: "$default",
  rawPath: "/anything/here",
  rawQueryString: "",
  headers: { host: "abc.lambda-url.us-east-1.on.aws" },
  requestContext: { http: { method: "POST", path: "/anything/here", sourceIp: "9.9.9.9" } },
  body: "plain body",
  isBase64Encoded: false,
};

const HTTP_V1 = {
  resource: "/users/{id}",
  path: "/users/42",
  httpMethod: "POST",
  headers: { "Content-Type": "application/json", Cookie: "sid=1" },
  multiValueHeaders: { "Content-Type": ["application/json"], Cookie: ["sid=1"], "X-Multi": ["a", "b"] },
  queryStringParameters: { a: "2" },
  multiValueQueryStringParameters: { a: ["1", "2"] },
  pathParameters: { id: "42" },
  requestContext: { identity: { sourceIp: "5.6.7.8" } },
  body: '{"y": 2}',
  isBase64Encoded: false,
};

const ALB = {
  requestContext: { elb: { targetGroupArn: "arn:aws:elasticloadbalancing:..." } },
  httpMethod: "GET",
  path: "/health",
  queryStringParameters: { verbose: "1" },
  headers: { host: "alb.example", "user-agent": "curl" },
  body: "",
  isBase64Encoded: false,
};

const SQS = {
  Records: [
    {
      messageId: "m1",
      body: '{"job": 1}',
      attributes: { ApproximateReceiveCount: "1" },
      messageAttributes: { kind: { stringValue: "a", dataType: "String" } },
      eventSource: "aws:sqs",
      eventSourceARN: "arn:aws:sqs:us-east-1:1:jobs",
    },
    { messageId: "m2", body: "fail", eventSource: "aws:sqs", eventSourceARN: "arn:aws:sqs:us-east-1:1:jobs" },
  ],
};

const SNS = {
  Records: [
    {
      EventSource: "aws:sns",
      Sns: {
        MessageId: "s1",
        TopicArn: "arn:aws:sns:us-east-1:1:events",
        Message: "hello",
        Timestamp: "2024-01-01T00:00:00.000Z",
        MessageAttributes: { k: { Type: "String", Value: "v" } },
      },
    },
  ],
};

const S3 = {
  Records: [
    {
      eventSource: "aws:s3",
      eventName: "ObjectRemoved:Delete",
      eventTime: "2024-01-01T00:00:00.000Z",
      s3: { bucket: { name: "b" }, object: { key: "dir/my+file%281%29.csv", size: 10, eTag: "e", sequencer: "seq1" } },
    },
    {
      eventSource: "aws:s3",
      eventName: "ObjectCreated:Put",
      s3: { bucket: { name: "b" }, object: { key: "new.txt" } },
    },
  ],
};

const SCHEDULED = {
  version: "0",
  id: "e1",
  "detail-type": "Scheduled Event",
  source: "aws.events",
  time: "2024-03-01T12:00:00Z",
  detail: { k: 1 },
};

const fakeCtx = {
  awsRequestId: "req-123",
  functionName: "demo-dev-hello",
  memoryLimitInMB: "256",
  getRemainingTimeInMillis: () => 5000,
};

let prevSink: ReturnType<typeof setLogSink>;
beforeEach(() => {
  prevSink = setLogSink(() => undefined);
  vi.stubEnv("NSKIT_FUNCTION", "");
});
afterEach(() => {
  setLogSink(prevSink);
  vi.unstubAllEnvs();
});

describe("toEvent - HTTP", () => {
  it("API Gateway HTTP API (payload v2)", () => {
    const ev = toEvent(HTTP_V2, fakeCtx);
    expect(ev.type).toBe("http");
    expect(ev.provider).toBe("aws");
    expect(ev.functionName).toBe("demo-dev-hello");
    const req = ev.http!;
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/users/42");
    expect(req.json()).toEqual({ x: 1 });
    expect(req.pathParams).toEqual({ id: "42" });
    expect(req.query).toEqual({ a: "1,2", b: "x" });
    expect(req.multiQuery).toEqual({ a: ["1", "2"], b: ["x"] });
    expect(req.cookies).toEqual({ sid: "1", theme: "dark" });
    expect(req.sourceIp).toBe("1.2.3.4");
    expect(req.route).toBe("/users/{id}");
    expect(req.headers.get("X-Forwarded-For")).toBe("1.2.3.4");
    expect(ev.raw).toBe(HTTP_V2);
  });

  it("Lambda Function URL", () => {
    const ev = toEvent(FUNCTION_URL);
    expect(ev.type).toBe("http");
    expect(ev.http).toMatchObject({ method: "POST", path: "/anything/here", sourceIp: "9.9.9.9", route: undefined });
    expect(ev.http!.text()).toBe("plain body");
    expect(ev.http!.query).toEqual({});
  });

  it("REST API (payload v1)", () => {
    const ev = toEvent(HTTP_V1);
    const req = ev.http!;
    expect(req.method).toBe("POST");
    expect(req.json()).toEqual({ y: 2 });
    expect(req.query).toEqual({ a: "2" });
    expect(req.multiQuery).toEqual({ a: ["1", "2"] });
    expect(req.sourceIp).toBe("5.6.7.8");
    expect(req.route).toBe("/users/{id}");
    expect(req.cookies).toEqual({ sid: "1" });
    expect(req.headers.get("x-multi")).toBe("a, b");
  });

  it("v1 without multi-value maps derives them; base64 bodies are decoded", () => {
    const ev = toEvent({ httpMethod: "PUT", path: "/p", headers: { a: "1" }, queryStringParameters: { q: "z" }, body: b64("bin"), isBase64Encoded: true });
    expect(ev.http!.multiQuery).toEqual({ q: ["z"] });
    expect(ev.http!.text()).toBe("bin");
    const multiOnly = toEvent({ httpMethod: "GET", path: "/p", multiValueQueryStringParameters: { q: ["1", "2"] } });
    expect(multiOnly.http!.query).toEqual({ q: "2" });
  });

  it("ALB target events", () => {
    const ev = toEvent(ALB);
    expect(ev.type).toBe("http");
    expect(ev.http).toMatchObject({ method: "GET", path: "/health", query: { verbose: "1" } });
    expect(ev.http!.headers.get("user-agent")).toBe("curl");
    expect(ev.http!.body.length).toBe(0);
  });

  it("NSKIT_FUNCTION wins over the Lambda function name", () => {
    vi.stubEnv("NSKIT_FUNCTION", "hello");
    expect(toEvent(HTTP_V2, fakeCtx).functionName).toBe("hello");
  });
});

describe("toEvent - batches and others", () => {
  it("SQS", () => {
    const q = toEvent(SQS);
    expect(q.type).toBe("queue");
    expect(q.source).toBe("arn:aws:sqs:us-east-1:1:jobs");
    expect(q.records.map((r) => r.id)).toEqual(["m1", "m2"]);
    expect(q.records[0].json()).toEqual({ job: 1 });
    expect(q.records[0].attributes).toEqual({ ApproximateReceiveCount: "1", kind: "a" });
    expect(q.records[1].text()).toBe("fail");
    expect(q.records[0].raw).toBe(SQS.Records[0]);
  });

  it("SNS", () => {
    const t = toEvent(SNS);
    expect(t.type).toBe("topic");
    expect(t.source).toBe("arn:aws:sns:us-east-1:1:events");
    expect(t.time.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(t.records[0]).toMatchObject({ id: "s1", body: "hello", attributes: { k: "v" } });
  });

  it("S3", () => {
    const s = toEvent(S3);
    expect(s.type).toBe("storage");
    expect(s.time.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    const [del, put] = s.records;
    expect([del.bucket, del.key, del.size, del.action, del.id]).toEqual(["b", "dir/my file(1).csv", 10, "deleted", "seq1"]);
    expect(del.attributes).toEqual({ etag: "e", eventName: "ObjectRemoved:Delete" });
    expect([put.key, put.action, put.size]).toEqual(["new.txt", "created", undefined]);
  });

  it("EventBridge scheduled events", () => {
    const ev = toEvent(SCHEDULED);
    expect(ev.type).toBe("schedule");
    expect(ev.data).toEqual({ k: 1 });
    expect(ev.source).toBe("aws.events");
    expect(ev.time.toISOString()).toBe("2024-03-01T12:00:00.000Z");
  });

  it("nskit envelopes (scheduler, Step Functions, invoke)", () => {
    const sched = toEvent(envelope("schedule", { report: "x" }, { source: "aws.scheduler" }));
    expect(sched).toMatchObject({ type: "schedule", data: { report: "x" }, source: "aws.scheduler" });
    expect(toEvent({ __nskit: "workflow", data: { n: 1 } })).toMatchObject({ type: "workflow", data: { n: 1 } });
    expect(toEvent(JSON.stringify(envelope("invoke", 5)))).toMatchObject({ type: "invoke", data: 5 });
  });

  it("anything else is a direct invocation", () => {
    expect(toEvent({ anything: true })).toMatchObject({ type: "invoke", data: { anything: true } });
    expect(toEvent('{"a":1}').data).toEqual({ a: 1 });
    expect(toEvent("text").data).toBe("text");
    expect(toEvent(null).data).toBeNull();
    expect(toEvent([1, 2]).data).toEqual([1, 2]);
    expect(toEvent({ Records: [] }).type).toBe("invoke");
    expect(toEvent({ Records: [{ eventSource: "aws:kinesis" }] }).type).toBe("invoke");
  });
});

describe("toContext", () => {
  it("maps the Lambda context", () => {
    const ctx = toContext(fakeCtx, "hello");
    expect(ctx).toMatchObject({ requestId: "req-123", functionName: "hello", provider: "aws", memoryMb: 256, raw: fakeCtx });
    expect(ctx.remainingTimeMs()).toBe(5000);
    expect(ctx.deadline! - Date.now()).toBeGreaterThan(4000);
  });

  it("tracks remaining time live", () => {
    let left = 3000;
    const ctx = toContext({ getRemainingTimeInMillis: () => left }, "f");
    left = 1000;
    expect(ctx.remainingTimeMs()).toBe(1000);
    expect(ctx.requestId).toMatch(/[0-9a-f-]{36}/);
    expect(ctx.memoryMb).toBeUndefined();
  });

  it("works without a context", () => {
    const ctx = toContext(undefined, "f");
    expect(ctx).toMatchObject({ functionName: "f", provider: "aws" });
    expect(ctx.remainingTimeMs()).toBeUndefined();
  });
});

describe("toNative", () => {
  it("HTTP v2 responses use the cookies field", () => {
    const out = toNative(HttpResponse.json({ a: 1 }).setCookie("s", "1"), toEvent(HTTP_V2)) as Record<string, unknown>;
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body as string)).toEqual({ a: 1 });
    expect(out.isBase64Encoded).toBe(false);
    expect(out.headers).toEqual({ "content-type": "application/json" });
    expect((out.cookies as string[])[0]).toMatch(/^s=1; /);
    expect(out).not.toHaveProperty("multiValueHeaders");
  });

  it("HTTP v1 responses use multiValueHeaders for cookies", () => {
    const out = toNative(HttpResponse.text("x").setCookie("s", "1").setCookie("t", "2"), toEvent(HTTP_V1)) as Record<string, unknown>;
    expect((out.multiValueHeaders as Record<string, string[]>)["set-cookie"]).toHaveLength(2);
    expect(out).not.toHaveProperty("cookies");
    const plain = toNative(HttpResponse.text("x"), toEvent(HTTP_V1)) as Record<string, unknown>;
    expect(plain).not.toHaveProperty("multiValueHeaders");
  });

  it("binary responses are base64 encoded", () => {
    const out = toNative(HttpResponse.binary(new Uint8Array([0, 1, 2, 255]), "image/png"), toEvent(HTTP_V2)) as Record<string, unknown>;
    expect(out).toMatchObject({ statusCode: 200, isBase64Encoded: true, body: "AAEC/w==", headers: { "content-type": "image/png" } });
  });

  it("batch results become batchItemFailures; other results pass through", () => {
    expect(toNative(BatchResult.of(["m2"]), toEvent(SQS))).toEqual({ batchItemFailures: [{ itemIdentifier: "m2" }] });
    expect(toNative(new BatchResult(), toEvent(SQS))).toEqual({ batchItemFailures: [] });
    expect(toNative({ x: 1 }, toEvent({ a: 1 }))).toEqual({ x: 1 });
    expect(toNative(undefined, toEvent(SCHEDULED))).toBeUndefined();
  });
});

describe("handler end to end", () => {
  beforeEach(() => {
    installBundle({
      manifest: {
        provider: "aws",
        functions: {
          hello: { handler: "app.hello", routes: [{ method: "GET", path: "/users/{id}" }] },
          worker: { handler: "app.worker" },
          sched: { handler: "app.sched" },
        },
      },
      handlers: {
        "app.hello": () => (event: Event, ctx: Context) => ({ id: event.http!.pathParams.id, req: ctx.requestId, left: ctx.remainingTimeMs() }),
        "app.worker": () => (event: Event) => BatchResult.of(event.records.filter((r) => r.body === "fail")),
        "app.sched": () => (event: Event) => {
          if (event.data === "explode") throw new Error("scheduled failure");
          return { type: event.type, data: event.data };
        },
      },
    });
  });

  it("serves HTTP", async () => {
    vi.stubEnv("NSKIT_FUNCTION", "hello");
    const out = (await handler(HTTP_V2, fakeCtx)) as Record<string, unknown>;
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body as string)).toEqual({ id: "42", req: "req-123", left: 5000 });
    const notAllowed = (await handler({ ...HTTP_V2, requestContext: { http: { method: "DELETE", path: "/users/42" } } }, fakeCtx)) as Record<
      string,
      unknown
    >;
    expect(notAllowed.statusCode).toBe(405);
    expect((notAllowed.headers as Record<string, string>).allow).toBe("GET");
  });

  it("reports partial SQS failures", async () => {
    vi.stubEnv("NSKIT_FUNCTION", "worker");
    expect(await handler(SQS, fakeCtx)).toEqual({ batchItemFailures: [{ itemIdentifier: "m2" }] });
  });

  it("handles scheduler envelopes and propagates non-HTTP errors", async () => {
    vi.stubEnv("NSKIT_FUNCTION", "sched");
    expect(await handler(envelope("schedule", { r: 1 }, { source: "aws.scheduler" }), fakeCtx)).toEqual({ type: "schedule", data: { r: 1 } });
    await expect(handler(envelope("schedule", "explode"), fakeCtx)).rejects.toThrow("scheduled failure");
  });

  it("HTTP resolution failures become 500 responses", async () => {
    vi.stubEnv("NSKIT_FUNCTION", "ghost");
    const out = (await handler(HTTP_V2, fakeCtx)) as Record<string, unknown>;
    expect(out.statusCode).toBe(500);
    expect(JSON.parse(out.body as string)).toMatchObject({ error: "Internal Server Error", requestId: "req-123" });
  });
});
