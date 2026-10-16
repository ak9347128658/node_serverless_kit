import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { handler, toContext, toEvent } from "../../src/runtime/adapters/huawei";
import { BatchFailure, BatchResult } from "../../src/runtime/batch";
import { envelope } from "../../src/runtime/envelope";
import type { Event } from "../../src/runtime/event";
import { installBundle } from "../../src/runtime/manifest";

const APIG = {
  body: Buffer.from("hello").toString("base64"),
  requestContext: { apiId: "a1", requestId: "r1", stage: "RELEASE", sourceIp: "9.9.9.9" },
  queryStringParameters: { lang: "en" },
  httpMethod: "PUT",
  pathParameters: { name: "ada" },
  headers: { "content-type": "text/plain" },
  path: "/hello/ada",
  isBase64Encoded: true,
};

const TIMER = {
  version: "v1.0",
  time: "2026-10-15T08:00:00+08:00",
  trigger_type: "TIMER",
  trigger_name: "timer-0",
  user_event: JSON.stringify(envelope("schedule", null, { source: "huawei.timer" })),
};

const OBS = {
  Records: [
    {
      eventVersion: "3.0",
      eventSource: "ObjectStorage",
      eventRegion: "cn-north-4",
      eventTime: "2026-10-15T08:00:00.000Z",
      eventName: "ObjectCreated:Put",
      obs: { bucket: { name: "uploads" }, object: { key: "in%2Fa.csv", eTag: "e", size: 5, sequencer: "s1" } },
    },
  ],
};

const SMN = {
  record: [
    {
      event_version: "1.0",
      smn: {
        topic_urn: "urn:smn:cn-north-4:p:events",
        timestamp: "2026-10-15T08:00:00Z",
        message_attributes: { kind: "a" },
        message: "fail",
        type: "notification",
        message_id: "m1",
        subject: "s",
      },
      event_subscription_urn: "urn:fss:...",
      event_source: "smn",
    },
  ],
  functionname: "demo-dev-worker",
};

const CTX = {
  getRequestID: () => "req-ctx",
  getRemainingTimeInMilliSeconds: () => 5000,
  getFunctionName: () => "demo-dev-api",
  getMemorySize: () => "256",
};

describe("huawei adapter", () => {
  test("APIG event", () => {
    const event = toEvent(APIG, CTX);
    expect(event.type).toBe("http");
    const req = event.http!;
    expect([req.method, req.path, req.text()]).toEqual(["PUT", "/hello/ada", "hello"]);
    expect(req.pathParams).toEqual({ name: "ada" });
    expect(req.query).toEqual({ lang: "en" });
    expect(req.sourceIp).toBe("9.9.9.9");
  });

  test("timer, OBS and SMN", () => {
    const timer = toEvent(TIMER);
    expect(timer.type).toBe("schedule");
    expect(timer.data).toBeNull();
    expect(timer.source).toBe("timer-0");
    const obs = toEvent(OBS);
    expect(obs.type).toBe("storage");
    expect([obs.records[0].bucket, obs.records[0].key, obs.records[0].action]).toEqual(["uploads", "in/a.csv", "created"]);
    const smn = toEvent(SMN);
    expect(smn.type).toBe("topic");
    expect(smn.records[0].text()).toBe("fail");
    expect(smn.records[0].attributes.kind).toBe("a");
    expect(smn.source).toBe("urn:smn:cn-north-4:p:events");
  });

  test("context, invoke and envelope", () => {
    const ctx = toContext(CTX, "api");
    expect(ctx.requestId).toBe("req-ctx");
    expect(ctx.memoryMb).toBe(256);
    expect(ctx.remainingTimeMs()).toBe(5000);
    expect(toEvent({ x: 1 }).type).toBe("invoke");
    expect(toEvent(JSON.stringify(envelope("invoke", 5))).data).toBe(5);
    // throwing getters are ignored
    expect(toContext({ getRequestID: () => { throw new Error("x"); } }, "api").requestId).toBeTruthy();
  });

  describe("end to end", () => {
    beforeEach(() => {
      installBundle({
        manifest: {
          service: "demo",
          stage: "dev",
          region: "",
          workflows: {},
          provider: "huawei",
          functions: {
            api: { handler: "app.api", routes: [{ method: "ANY", path: "/hello/{name}" }] },
            worker: { handler: "app.worker", routes: [] },
          },
        },
        handlers: {
          "app.api": () => (event: Event) => `hi ${event.http!.pathParams.name}`,
          "app.worker": () => (event: Event) => {
            const result = new BatchResult();
            for (const r of event.records) if (r.text() === "fail") result.fail(r);
            return result;
          },
        },
      });
    });
    afterEach(() => {
      delete process.env.NSKIT_FUNCTION;
      installBundle({});
    });

    test("HTTP response and failing batches", async () => {
      process.env.NSKIT_FUNCTION = "api";
      expect(await handler(APIG, CTX)).toEqual({
        statusCode: 200,
        isBase64Encoded: false,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: "hi ada",
      });
      process.env.NSKIT_FUNCTION = "worker";
      await expect(handler(SMN, CTX)).rejects.toBeInstanceOf(BatchFailure);
    });
  });
});
