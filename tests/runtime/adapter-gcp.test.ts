import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { NotFound } from "../../src/runtime/errors";
import type { Event } from "../../src/runtime/event";
import { installBundle } from "../../src/runtime/manifest";
import * as gcp from "../../src/runtime/adapters/gcp";

/* eslint-disable @typescript-eslint/no-explicit-any */

const seen: { event?: Event } = {};

async function echo(event: Event): Promise<unknown> {
  seen.event = event;
  if (event.http) {
    if (event.http.pathParams.id === "missing") throw new NotFound("nope");
    if (event.http.pathParams.id === "cookie") {
      const { HttpResponse } = await import("../../src/runtime/response");
      return new HttpResponse(200, "ok").setCookie("a", "1").setCookie("b", "2");
    }
    return { id: event.http.pathParams.id, q: event.http.query, multi: event.http.multiQuery, body: event.http.json(null) };
  }
  if ((event.data as any)?.boom) throw new TypeError("bad input");
  return { type: event.type, data: event.data ?? null, records: event.records.length };
}

class FakeResponse {
  statusCode = 0;
  headers: Record<string, string | string[]> = {};
  body = "";
  setHeader(name: string, value: string | string[]): void {
    this.headers[name.toLowerCase()] = value;
  }
  end(body?: Uint8Array | string): void {
    this.body = body === undefined ? "" : typeof body === "string" ? body : Buffer.from(body).toString("utf-8");
  }
  json(): any {
    return JSON.parse(this.body);
  }
}

function request(method: string, url: string, init: { body?: string; headers?: Record<string, string>; parsed?: unknown } = {}): any {
  const headers = { ...(init.headers ?? {}) };
  return {
    method,
    url,
    headers,
    rawBody: init.body !== undefined ? Buffer.from(init.body) : undefined,
    body: init.parsed ?? {},
    ip: "10.0.0.1",
  };
}

async function call(req: any): Promise<FakeResponse> {
  const res = new FakeResponse();
  await gcp.nskitHttp(req, res);
  return res;
}

const ENV_KEYS = ["NSKIT_FUNCTION", "NSKIT_TRIGGER_KIND", "NSKIT_STORAGE_PREFIX", "NSKIT_STORAGE_SUFFIX"];

beforeEach(() => {
  delete seen.event;
  process.env.NSKIT_FUNCTION = "users";
  installBundle({
    manifest: {
      provider: "gcp",
      functions: {
        users: {
          handler: "app.echo",
          routes: [
            { method: "GET", path: "/users/{id}", cors: null },
            { method: "POST", path: "/users/{id}", cors: null },
          ],
        },
      },
    } as any,
    handlers: { "app.echo": async () => echo },
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("gcp http", () => {
  test("path params with the function prefix stripped", async () => {
    const res = await call(request("GET", "/42?x=1&x=2&y=3", { headers: { "function-execution-id": "abc" } }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: "42", q: { x: "2", y: "3" }, multi: { x: ["1", "2"], y: ["3"] }, body: null });
    expect(res.headers["content-type"]).toBe("application/json");
    expect(seen.event!.provider).toBe("gcp");
  });

  test("full path and JSON body from rawBody", async () => {
    const res = await call(
      request("POST", "/users/7", { body: '{"a": 1}', headers: { "content-type": "application/json" }, parsed: { a: 1 } }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toEqual({ a: 1 });
  });

  test("falls back to the parsed body when rawBody is missing", async () => {
    const req = request("POST", "/users/7", { headers: { "content-type": "application/json" }, parsed: { b: 2 } });
    const res = await call(req);
    expect(res.json().body).toEqual({ b: 2 });
  });

  test("error mapping and 405", async () => {
    const missing = await call(request("GET", "/users/missing"));
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("nope");
    expect((await call(request("DELETE", "/users/1"))).statusCode).toBe(405);
  });

  test("cookies are sent as multiple set-cookie headers", async () => {
    const res = await call(request("GET", "/users/cookie"));
    const cookies = res.headers["set-cookie"] as string[];
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(/^a=1;/);
    expect(cookies[1]).toMatch(/^b=2;/);
    expect(res.body).toBe("ok");
  });

  test("source ip from x-forwarded-for", () => {
    const event = gcp.toHttpEvent(request("GET", "/users/1", { headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" } }), "users");
    expect(event.http!.sourceIp).toBe("1.2.3.4");
    expect(gcp.toHttpEvent(request("GET", "/users/1"), "users").http!.sourceIp).toBe("10.0.0.1");
  });

  test("envelope runs as a workflow event", async () => {
    const res = await call(request("POST", "/", { body: JSON.stringify({ __nskit: "workflow", data: { n: 1 } }) }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ type: "workflow", data: { n: 1 }, records: 0 });
    expect(seen.event!.http).toBeUndefined();
  });

  test("envelope errors use the workflow error shape", async () => {
    const res = await call(request("POST", "/", { body: JSON.stringify({ __nskit: "workflow", data: { boom: true } }) }));
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ errorType: "TypeError", cause: "bad input" });
  });
});

function pubsub(data: string, attributes: Record<string, string> = {}): gcp.GcpCloudEvent {
  return {
    type: "google.cloud.pubsub.topic.v1.messagePublished",
    source: "//pubsub.googleapis.com/projects/p/topics/jobs",
    id: "evt-1",
    time: "2024-05-01T10:00:00Z",
    data: {
      message: { data: Buffer.from(data).toString("base64"), attributes, messageId: "m-1" },
      subscription: "projects/p/subscriptions/s",
    },
  };
}

describe("gcp cloud events", () => {
  test("pub/sub queue event", () => {
    process.env.NSKIT_TRIGGER_KIND = "queue";
    const event = gcp.toCloudEvent(pubsub('{"job": 1}', { k: "v" }), "users")!;
    expect(event.type).toBe("queue");
    const rec = event.records[0];
    expect(rec.id).toBe("m-1");
    expect(rec.json()).toEqual({ job: 1 });
    expect(rec.attributes).toEqual({ k: "v" });
    expect(rec.source).toBe("projects/p/subscriptions/s");
    expect(event.time.getUTCFullYear()).toBe(2024);
  });

  test("topic is the default and scheduler envelopes are unwrapped", () => {
    expect(gcp.toCloudEvent(pubsub("hi"), "users")!.type).toBe("topic");
    expect(gcp.toCloudEvent(pubsub("hi"), "users")!.records[0].text()).toBe("hi");
    const env = JSON.stringify({ __nskit: "schedule", data: { r: 1 }, source: "gcp.scheduler" });
    const event = gcp.toCloudEvent(pubsub(env), "users")!;
    expect(event.type).toBe("schedule");
    expect(event.data).toEqual({ r: 1 });
    expect(event.source).toBe("gcp.scheduler");
  });

  test("binary pub/sub payloads stay bytes", () => {
    const ce = pubsub("");
    (ce.data as any).message.data = Buffer.from([0xff, 0xfe, 0x00]).toString("base64");
    const body = gcp.toCloudEvent(ce, "users")!.records[0].body;
    expect(body).toBeInstanceOf(Uint8Array);
  });

  test("storage events and runtime prefix / suffix filters", () => {
    const ce: gcp.GcpCloudEvent = {
      type: "google.cloud.storage.object.v1.finalized",
      source: "//storage.googleapis.com/projects/_/buckets/up",
      id: "1",
      data: { bucket: "up", name: "in/a.csv", size: "12", generation: "99", contentType: "text/csv" },
    };
    const event = gcp.toCloudEvent(ce, "users")!;
    const rec = event.records[0];
    expect([event.type, rec.bucket, rec.key, rec.size, rec.action, rec.id]).toEqual(["storage", "up", "in/a.csv", 12, "created", "99"]);
    expect(rec.attributes.contentType).toBe("text/csv");
    expect(gcp.toCloudEvent({ ...ce, type: "google.cloud.storage.object.v1.deleted" }, "users")!.records[0].action).toBe("deleted");
    process.env.NSKIT_STORAGE_PREFIX = "in/";
    expect(gcp.toCloudEvent(ce, "users")).toBeDefined();
    process.env.NSKIT_STORAGE_SUFFIX = ".json";
    expect(gcp.toCloudEvent(ce, "users")).toBeUndefined();
  });

  test("nskitEvent dispatches, skips filtered events and rejects on failure", async () => {
    expect(await gcp.nskitEvent({ type: "custom.event", source: "s", id: "x", data: { hello: 1 } })).toEqual({
      type: "invoke",
      data: { hello: 1 },
      records: 0,
    });
    delete seen.event;
    process.env.NSKIT_STORAGE_SUFFIX = ".json";
    const skipped = await gcp.nskitEvent({ type: "google.cloud.storage.object.v1.finalized", data: { bucket: "b", name: "a.csv" } });
    expect(skipped).toBeUndefined();
    expect(seen.event).toBeUndefined();
    await expect(gcp.nskitEvent({ type: "custom.event", data: { boom: true } })).rejects.toThrow("bad input");
  });

  test("register wires both entry points into the framework", () => {
    const registered: Record<string, [string, unknown]> = {};
    gcp.register({
      http: (name, fn) => (registered[name] = ["http", fn]),
      cloudEvent: (name, fn) => (registered[name] = ["cloudevent", fn]),
    });
    expect(registered.nskit_http).toEqual(["http", gcp.nskitHttp]);
    expect(registered.nskit_event).toEqual(["cloudevent", gcp.nskitEvent]);
    expect(() => gcp.register(undefined)).not.toThrow();
  });
});
