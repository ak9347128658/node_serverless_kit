import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { handler, toContext, toEvent, toNative } from "../../src/runtime/adapters/alibaba";
import { envelope } from "../../src/runtime/envelope";
import { installBundle } from "../../src/runtime/manifest";
import { HttpResponse } from "../../src/runtime/response";
import type { Event } from "../../src/runtime/event";

const HTTP = {
  version: "v1",
  rawPath: "/users/42",
  body: Buffer.from('{"x": 1}').toString("base64"),
  isBase64Encoded: true,
  headers: { "Content-Type": "application/json", Origin: "https://app.example" },
  queryParameters: { a: "1", tags: ["x", "y"] },
  requestContext: {
    accountId: "123",
    domainName: "demo.cn-hangzhou.fcapp.run",
    domainPrefix: "demo",
    http: { method: "GET", path: "/users/42", protocol: "HTTP/1.1", sourceIp: "1.2.3.4", userAgent: "curl/8.7.1" },
    requestId: "req-1",
    time: "2026-10-15T08:00:00Z",
    timeEpoch: "1760515200000",
  },
};

const TIMER = {
  triggerTime: "2026-10-15T08:00:00Z",
  triggerName: "timer-0",
  payload: JSON.stringify(envelope("schedule", { report: "weekly" }, { source: "alibaba.timer" })),
};

const OSS = {
  events: [
    {
      eventName: "ObjectCreated:PutObject",
      eventSource: "acs:oss",
      eventTime: "2026-10-15T08:00:00.000Z",
      oss: { bucket: { name: "uploads" }, object: { key: "in/a.csv", size: 12, eTag: "e" } },
      region: "cn-hangzhou",
      responseElements: { requestId: "r1" },
    },
  ],
};

const MNS = { TopicOwner: "123", TopicName: "events", MessageId: "m1", Message: '{"k": 1}', PublishTime: 1760515200000 };

const CTX = { requestId: "req-ctx", region: "cn-hangzhou", function: { name: "demo-dev-api", memory: 256, timeout: 30 } };

const buf = (v: unknown) => Buffer.from(JSON.stringify(v));

describe("alibaba adapter", () => {
  test("HTTP event from a Buffer", () => {
    const event = toEvent(buf(HTTP), CTX);
    expect(event.type).toBe("http");
    const req = event.http!;
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/users/42");
    expect(req.query).toEqual({ a: "1", tags: "y" });
    expect(req.multiQuery.tags).toEqual(["x", "y"]);
    expect(req.json()).toEqual({ x: 1 });
    expect(req.sourceIp).toBe("1.2.3.4");
    expect(req.headers.get("content-type")).toBe("application/json");
  });

  test("HTTP event as string and object", () => {
    expect(toEvent(JSON.stringify(HTTP)).http?.path).toBe("/users/42");
    expect(toEvent(HTTP).http?.method).toBe("GET");
  });

  test("timer unwraps the envelope payload", () => {
    const event = toEvent(buf(TIMER));
    expect(event.type).toBe("schedule");
    expect(event.data).toEqual({ report: "weekly" });
    expect(event.source).toBe("timer-0");
    expect(event.time.toISOString()).toBe("2026-10-15T08:00:00.000Z");
    const plain = toEvent({ triggerTime: "2026-10-15T08:00:00Z", triggerName: "t", payload: "hi" });
    expect(plain.type).toBe("schedule");
    expect(plain.data).toBe("hi");
  });

  test("OSS and MNS records", () => {
    const event = toEvent(buf(OSS));
    expect(event.type).toBe("storage");
    const rec = event.records[0];
    expect([rec.bucket, rec.key, rec.size, rec.action, rec.id]).toEqual(["uploads", "in/a.csv", 12, "created", "r1"]);
    expect(toEvent({ events: [{ ...OSS.events[0], eventName: "ObjectRemoved:DeleteObject" }] }).records[0].action).toBe("deleted");
    const topic = toEvent(MNS);
    expect(topic.type).toBe("topic");
    expect(topic.records[0].json()).toEqual({ k: 1 });
    expect(topic.records[0].attributes.TopicName).toBe("events");
    expect(topic.source).toBe("events");
  });

  test("envelope and plain invoke", () => {
    const wf = toEvent(buf(envelope("workflow", { n: 1 })));
    expect(wf.type).toBe("workflow");
    expect(wf.data).toEqual({ n: 1 });
    const inv = toEvent(Buffer.from('{"hello": "world"}'));
    expect(inv.type).toBe("invoke");
    expect(inv.data).toEqual({ hello: "world" });
    const text = toEvent(Buffer.from("just text"));
    expect(text.type).toBe("invoke");
  });

  test("context", () => {
    const ctx = toContext(CTX, "api");
    expect(ctx.requestId).toBe("req-ctx");
    expect(ctx.memoryMb).toBe(256);
    expect(ctx.region).toBe("cn-hangzhou");
    const remaining = ctx.remainingTimeMs()!;
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(30000);
    expect(toContext(undefined, "api").provider).toBe("alibaba");
  });

  test("native response with cookies and binary bodies", () => {
    const event = toEvent(HTTP) as Event;
    const resp = HttpResponse.json({ ok: true }).setCookie("a", "1").setCookie("b", "2");
    const out = toNative(resp, event) as { headers: Record<string, string> };
    expect(out.headers["set-cookie"]).toContain("a=1");
    expect(out.headers["set-cookie"]).toContain("b=2");
    const bin = toNative(HttpResponse.binary(new Uint8Array([0, 1]), "image/png"), event) as Record<string, unknown>;
    expect(bin.isBase64Encoded).toBe(true);
    expect(bin.body).toBe("AAE=");
  });

  describe("end to end", () => {
    beforeEach(() => {
      installBundle({
        manifest: {
          service: "demo",
          stage: "dev",
          region: "",
          workflows: {},
          provider: "alibaba",
          functions: {
            api: { handler: "app.api", routes: [{ method: "GET", path: "/users/{id}", cors: { origins: ["*"] } }] },
            tick: { handler: "app.tick", routes: [] },
          },
        },
        handlers: {
          "app.api": () => (event: Event) => ({ id: event.http!.pathParams.id, provider: event.provider }),
          "app.tick": () => (event: Event) => ({ type: event.type, data: event.data }),
        },
      });
    });
    afterEach(() => {
      delete process.env.NSKIT_FUNCTION;
      installBundle({});
    });

    test("HTTP and timer", async () => {
      process.env.NSKIT_FUNCTION = "api";
      const out = (await handler(buf(HTTP), CTX)) as Record<string, unknown>;
      expect(out.statusCode).toBe(200);
      expect(out.isBase64Encoded).toBe(false);
      expect(JSON.parse(out.body as string)).toEqual({ id: "42", provider: "alibaba" });
      expect((out.headers as Record<string, string>)["access-control-allow-origin"]).toBe("*");

      process.env.NSKIT_FUNCTION = "tick";
      expect(await handler(buf(TIMER), CTX)).toEqual({ type: "schedule", data: { report: "weekly" } });
    });
  });
});
