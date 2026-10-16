import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BatchFailure, BatchResult, Event, HttpResponse } from "../../src/index";
import type { Context } from "../../src/runtime/context";
import * as cf from "../../src/runtime/adapters/cloudflare";
import { installBundle } from "../../src/runtime/manifest";
import { getEnv, setEnv } from "../../src/runtime/util";

const SEEN: { event?: Event; ctx?: Context } = {};

async function echo(event: Event, ctx: Context) {
  SEEN.event = event;
  SEEN.ctx = ctx;
  if (event.http) return { id: event.http.pathParams.id, body: event.http.json(null), env: getEnv("A") };
  return { type: event.type, data: event.data };
}

async function binary() {
  return HttpResponse.binary(new Uint8Array([0, 1, 2, 255]), "image/png").setCookie("a", "1").setCookie("b", "2");
}

async function empty() {
  return HttpResponse.noContent();
}

let batchMode: "result" | "throw" | "error" = "result";
async function batch(event: Event) {
  SEEN.event = event;
  const bad = event.records.filter((r) => (r.json({}) as { bad?: boolean }).bad);
  if (batchMode === "throw") throw new BatchFailure(bad.map((r) => r.id!));
  if (batchMode === "error") throw new Error("boom");
  return BatchResult.of(bad);
}

beforeEach(() => {
  for (const k of Object.keys(SEEN)) delete (SEEN as Record<string, unknown>)[k];
  batchMode = "result";
  installBundle({
    manifest: {
      service: "svc",
      stage: "dev",
      region: "",
      workflows: {},
      provider: "cloudflare",
      functions: {
        users: { handler: "t.echo", routes: [{ method: "ANY", path: "/users/{id}" }] },
        bin: { handler: "t.binary", routes: [] },
        empty: { handler: "t.empty", routes: [] },
        jobs: { handler: "t.echo", routes: [] },
        batch: { handler: "t.batch", routes: [] },
      },
    },
    handlers: { "t.echo": () => echo, "t.binary": () => binary, "t.empty": () => empty, "t.batch": () => batch },
  });
});

afterEach(() => {
  setEnv(undefined);
  cf.installEnv(undefined);
});

const env = (fn: string, extra: Record<string, unknown> = {}) => ({ NSKIT_FUNCTION: fn, ...extra });

describe("fetch", () => {
  test("converts Request -> HttpRequest and installs string bindings", async () => {
    const waited: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waited.push(p) };
    const kv = { get: () => "x" };
    const req = new Request("https://x.workers.dev/users/9?a=1&a=2&b=", {
      method: "POST",
      body: '{"k": 1}',
      headers: { "CF-Ray": "ray1", "cf-connecting-ip": "1.2.3.4", "content-type": "application/json" },
    });
    const resp = await cf.createWorker().fetch(req, env("users", { A: "bound", N: 5, KV: kv }), ctx);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ id: "9", body: { k: 1 }, env: "bound" });
    const http = SEEN.event!.http!;
    expect(http.query).toEqual({ a: "2", b: "" });
    expect(http.multiQuery).toEqual({ a: ["1", "2"], b: [""] });
    expect(http.sourceIp).toBe("1.2.3.4");
    expect(http.headers.get("cf-ray")).toBe("ray1");
    expect(SEEN.event!.provider).toBe("cloudflare");
    expect(SEEN.ctx!.requestId).toBe("ray1");
    expect(getEnv("N")).toBe("5");
    expect((SEEN.ctx!.raw as { env: Record<string, unknown> }).env.KV).toBe(kv);
    expect(cf.workerEnv()?.KV).toBe(kv);
    SEEN.ctx!.waitUntil(Promise.resolve(1));
    expect(waited).toHaveLength(1);
  });

  test("GET has no body and unknown routes 404/405 come from the dispatcher", async () => {
    const resp = await cf.fetchHandler(new Request("https://x/users/1", { method: "GET" }), env("users"));
    expect(await resp.json()).toMatchObject({ id: "1", body: null });
  });

  test("binary body and multiple cookies", async () => {
    const resp = await cf.fetchHandler(new Request("https://x/"), env("bin"));
    expect(resp.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await resp.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 255]));
    expect(resp.headers.getSetCookie()).toHaveLength(2);
  });

  test("204 has a null body", async () => {
    const resp = await cf.fetchHandler(new Request("https://x/"), env("empty"));
    expect(resp.status).toBe(204);
    expect(resp.body).toBeNull();
  });

  test("__nskit envelope -> invoke event, JSON result", async () => {
    const body = JSON.stringify({ __nskit: "invoke", data: 3 });
    const resp = await cf.fetchHandler(new Request("https://x/", { method: "POST", body }), env("jobs"));
    expect(await resp.json()).toEqual({ type: "invoke", data: 3 });
    expect(SEEN.event!.type).toBe("invoke");
  });

  test("envelope failures become JSON 500", async () => {
    const body = JSON.stringify({ __nskit: "workflow", data: {} });
    const resp = await cf.fetchHandler(new Request("https://x/", { method: "POST", body }), env("nope"));
    expect(resp.status).toBe(500);
    expect(await resp.json()).toMatchObject({ errorType: expect.any(String), cause: expect.stringContaining("nope") });
  });
});

describe("scheduled", () => {
  const schedules = { jobs: { "*/5 * * * *": { job: "sync" }, "0 12 * * MON": null } };

  test("finds the schedule input by cron", async () => {
    const worker = cf.createWorker({ schedules });
    await worker.scheduled({ cron: "*/5  *  * * *", scheduledTime: 1_700_000_000_000 }, env("jobs"));
    expect(SEEN.event!.type).toBe("schedule");
    expect(SEEN.event!.data).toEqual({ job: "sync" });
    expect(SEEN.event!.time.getUTCFullYear()).toBe(2023);
    expect(SEEN.event!.source).toBe("*/5  *  * * *");
  });

  test("unknown cron or function -> null data", () => {
    expect(cf.scheduleEvent({ cron: "0 0 * * *" }, "jobs", schedules).data).toBeNull();
    expect(cf.scheduleEvent({ cron: "0 12 * * mon" }, "jobs", schedules).data).toBeNull();
    expect(cf.scheduleEvent({ cron: "*/5 * * * *" }, "other", schedules).data).toBeNull();
  });

  test("handler errors propagate", async () => {
    await expect(cf.scheduledHandler({ cron: "* * * * *" }, env("nope"), undefined)).rejects.toThrow();
  });
});

describe("queue", () => {
  const calls: string[] = [];
  const msg = (id: string, body: unknown) => ({
    id,
    body,
    attempts: 2,
    timestamp: new Date("2024-01-02T03:04:05Z"),
    ack: () => calls.push(`ack:${id}`),
    retry: () => calls.push(`retry:${id}`),
  });
  const mk = () => ({ queue: "orders", messages: [msg("m1", { ok: true }), msg("m2", { bad: true }), msg("m3", "plain")] });

  beforeEach(() => {
    calls.length = 0;
  });

  test("records and partial failure from BatchResult / BatchFailure", async () => {
    // The dispatcher turns a BatchResult into a BatchFailure on providers without native partial batches.
    for (const mode of ["result", "throw"] as const) {
      calls.length = 0;
      batchMode = mode;
      await cf.queueHandler(mk(), env("batch"));
      expect(calls.sort()).toEqual(["ack:m1", "ack:m3", "retry:m2"]);
    }
    const ev = SEEN.event!;
    expect(ev.type).toBe("queue");
    expect(ev.source).toBe("orders");
    expect(ev.records.map((r) => r.id)).toEqual(["m1", "m2", "m3"]);
    expect(ev.records[2].text()).toBe("plain");
    expect(ev.records[0].attributes).toEqual({ attempts: 2, timestamp: "2024-01-02T03:04:05.000Z" });
    expect(ev.time.toISOString()).toBe("2024-01-02T03:04:05.000Z");
  });

  test("all ok -> implicit ack; other errors fail the whole batch", async () => {
    await cf.queueHandler({ queue: "orders", messages: [msg("m1", { ok: true })] }, env("batch"));
    expect(calls).toEqual([]);
    batchMode = "error";
    await expect(cf.queueHandler(mk(), env("batch"))).rejects.toThrow("boom");
    expect(calls).toEqual([]);
  });

  test("ArrayBuffer bodies become bytes", () => {
    const ev = cf.queueEvent({ queue: "q", messages: [{ id: "1", body: new TextEncoder().encode("hi").buffer }] }, "batch");
    expect(ev.records[0].text()).toBe("hi");
  });
});

describe("helpers", () => {
  test("bindingName", () => {
    expect(cf.bindingName("send-email")).toBe("NSKIT_BINDING_SEND_EMAIL");
  });

  test("invokeViaBinding posts an invoke envelope", async () => {
    let seen: unknown;
    const fetcher = {
      fetch: async (_url: string, init?: RequestInit) => {
        seen = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
      },
    };
    cf.installEnv({ NSKIT_BINDING_BILLING: fetcher });
    expect(await cf.invokeViaBinding("billing", { a: 1 })).toEqual({ result: { ok: 1 } });
    expect(seen).toEqual({ __nskit: "invoke", data: { a: 1 } });
    cf.installEnv({ NSKIT_BINDING_BILLING: { fetch: async () => new Response("bad", { status: 500 }) } });
    await expect(cf.invokeViaBinding("billing", {})).rejects.toThrow("500");
  });
});
