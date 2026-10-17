import { afterEach, beforeEach, expect, test } from "vitest";
import { BatchResult } from "../../src/runtime/batch";
import type { Context } from "../../src/runtime/context";
import type { Event } from "../../src/runtime/event";
import { installBundle } from "../../src/runtime/manifest";
import { handler } from "../../src/runtime/adapters/onprem";

let seen: Event | undefined;
let seenCtx: Context | undefined;

async function api(event: Event, ctx: Context) {
  seen = event;
  seenCtx = ctx;
  if (event.type === "queue") {
    const result = new BatchResult();
    for (const record of event.records) if (record.text().includes("bad")) result.fail(record);
    return result;
  }
  if (event.http) return { path: event.http.path, q: event.http.query.q ?? null };
  return { type: event.type, data: event.data };
}

beforeEach(() => {
  seen = undefined;
  seenCtx = undefined;
  process.env.NSKIT_FUNCTION = "api";
  process.env.NSKIT_SERVICE = "demo";
  process.env.NSKIT_STAGE = "dev";
  process.env.NSKIT_REGION = "local";
  installBundle({
    manifest: {
      service: "demo",
      stage: "dev",
      region: "local",
      workflows: {},
      provider: "onprem",
      functions: {
        api: { handler: "t.api", routes: [{ method: "GET", path: "/health" }, { method: "POST", path: "/jobs" }] },
      },
    },
    handlers: { "t.api": async () => api },
  });
});

afterEach(() => {
  delete process.env.NSKIT_FUNCTION;
  delete process.env.NSKIT_SERVICE;
  delete process.env.NSKIT_STAGE;
  delete process.env.NSKIT_REGION;
});

test("HTTP is a gateway response and query stays a query", async () => {
  const out = (await handler(
    { http: { method: "GET", path: "/health", headers: { "x-request-id": "abc" }, queryString: "q=1", body: "", isBase64Encoded: false } },
    { functionName: "api", requestId: "r1", timeoutMs: 1000 },
  )) as { status: number; body: string };
  expect(out.status).toBe(200);
  expect(JSON.parse(out.body)).toEqual({ path: "/health", q: "1" });
  expect(seen?.provider).toBe("onprem");
  expect(seen?.http?.query.q).toBe("1");
  expect(seenCtx?.provider).toBe("onprem");
  expect(seenCtx?.requestId).toBe("r1");
  expect(seenCtx?.region).toBe("local");
});

test("queue results stay a BatchResult so the supervisor can ack per record", async () => {
  const out = (await handler(
    { type: "queue", queue: "jobs", records: [{ id: "1", body: { ok: true } }, { id: "2", body: "bad" }] },
    { functionName: "api" },
  )) as BatchResult;
  expect(out).toBeInstanceOf(BatchResult);
  expect(out.failed).toEqual(["2"]);
  expect(seen?.type).toBe("queue");
  expect(seen?.source).toBe("onprem:queue:jobs");
});

test("schedule, invoke and workflow envelopes keep their type", async () => {
  const schedule = (await handler({ __nskit: "schedule", data: { kind: "heartbeat" }, source: "onprem.scheduler" }, { functionName: "api" })) as {
    type: string;
    data: unknown;
  };
  expect(schedule).toEqual({ type: "schedule", data: { kind: "heartbeat" } });
  expect(seen?.source).toBe("onprem.scheduler");

  const invoked = (await handler({ __nskit: "invoke", data: { n: 1 } }, { functionName: "api" })) as { type: string };
  expect(invoked.type).toBe("invoke");

  const workflow = (await handler({ __nskit: "workflow", data: { n: 2 }, source: "onprem.http" }, { functionName: "api" })) as { type: string };
  expect(workflow.type).toBe("workflow");
});
