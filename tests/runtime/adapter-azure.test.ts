import { beforeEach, describe, expect, test } from "vitest";
import { BatchFailure, BatchResult, HttpResponse, type Event } from "../../src/index";
import * as azure from "../../src/runtime/adapters/azure";
import { installBundle } from "../../src/runtime/manifest";

const seen: { event?: Event } = {};

async function echo(event: Event) {
  seen.event = event;
  if (event.http) {
    const resp = HttpResponse.json({ id: event.http.pathParams.id ?? null, path: event.http.path, body: event.http.text() }, 201);
    resp.setCookie("sid", "a b", { maxAge: 60 });
    return resp;
  }
  if (event.records[0]?.text() === "fail") return BatchResult.of(event.records);
  if (event.records[0]?.text() === "throw") throw new Error("boom");
  return { type: event.type, data: event.data ?? null };
}

beforeEach(() => {
  seen.event = undefined;
  installBundle({
    manifest: {
      service: "demo",
      stage: "dev",
      region: "westeurope",
      provider: "azure",
      functions: { items: { handler: "h.echo", routes: [{ method: "POST", path: "/items/{id}" }] } },
      workflows: {},
    },
    handlers: { "h.echo": () => echo },
  });
});

/** Shaped like the v4 `HttpRequest` (WHATWG Headers / URLSearchParams, async body readers). */
function request(method: string, url: string, body = "", headers: Record<string, string> = {}, params: Record<string, string> = {}) {
  const u = new URL(url);
  return {
    method,
    url,
    headers: new Headers(headers),
    query: u.searchParams,
    params,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
    text: async () => body,
  };
}

const ctx = (triggerMetadata?: Record<string, unknown>) => ({ invocationId: "inv-1", functionName: "x", triggerMetadata });

describe("http", () => {
  test("request -> portable event -> HttpResponseInit", async () => {
    const req = request(
      "POST",
      "https://app.azurewebsites.net/items/5?x=1&x=2&y=z",
      '{"a":1}',
      { "x-forwarded-for": "1.2.3.4:5555", "content-type": "application/json" },
      { id: "5" },
    );
    const res = await azure.http(req, ctx(), "items");
    expect(res.status).toBe(201);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(res.body as Uint8Array))).toEqual({ id: "5", path: "/items/5", body: '{"a":1}' });
    expect(res.cookies).toEqual([{ name: "sid", value: "a b", path: "/", sameSite: "Lax", maxAge: 60, httpOnly: true, secure: true }]);
    const ev = seen.event!;
    expect(ev.provider).toBe("azure");
    expect(ev.functionName).toBe("items");
    expect(ev.http!.query).toEqual({ x: "2", y: "z" });
    expect(ev.http!.multiQuery.x).toEqual(["1", "2"]);
    expect(ev.http!.sourceIp).toBe("1.2.3.4");
    expect(ev.http!.headers.get("Content-Type")).toBe("application/json");
  });

  test("405 for a path that matches with the wrong method", async () => {
    const res = await azure.http(request("GET", "https://app/items/5"), ctx(), "items");
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("POST");
  });

  test("__nskit envelope is an invoke, answered as JSON", async () => {
    const res = await azure.http(request("POST", "https://app/_nskit/invoke/items", JSON.stringify({ __nskit: "invoke", data: [1, 2] })), ctx(), "items");
    expect(res.status).toBe(200);
    expect(JSON.parse(String(res.body))).toEqual({ type: "invoke", data: [1, 2] });
  });

  test("parseSetCookie", () => {
    expect(azure.parseSetCookie("a=b%3Dc; Path=/x; Domain=e.com; SameSite=None; Expires=Wed, 21 Oct 2026 07:28:00 GMT")).toEqual({
      name: "a",
      value: "b=c",
      path: "/x",
      domain: "e.com",
      sameSite: "None",
      expires: new Date("2026-10-21T07:28:00Z"),
    });
  });
});

describe("other triggers", () => {
  test("timer delivers the schedule input", async () => {
    await azure.timer({ isPastDue: false }, ctx(), "items", { report: "weekly" });
    expect(seen.event!.type).toBe("schedule");
    expect(seen.event!.data).toEqual({ report: "weekly" });
  });

  test("storage queue message + trigger metadata", async () => {
    const event = azure.toQueueEvent({ a: 1 }, ctx({ id: "q1", dequeueCount: 2, insertionTime: "2024-01-02T00:00:00Z" }), "items");
    expect(event.type).toBe("queue");
    expect(event.records[0].json()).toEqual({ a: 1 });
    expect(event.records[0].id).toBe("q1");
    expect(event.records[0].attributes.dequeueCount).toBe(2);
    expect(event.time.getUTCFullYear()).toBe(2024);
  });

  test("BatchResult failures fail the whole invocation; errors propagate", async () => {
    await expect(azure.queue("fail", ctx({ id: "q1" }), "items")).rejects.toBeInstanceOf(BatchFailure);
    await expect(azure.queue("throw", ctx({ id: "q1" }), "items")).rejects.toThrow("boom");
    await expect(azure.queue("ok", ctx({ id: "q1" }), "items")).resolves.toBeUndefined();
  });

  test("blob trigger metadata", () => {
    const content = new Uint8Array([1, 2, 3]);
    const event = azure.toBlobEvent(
      content,
      ctx({ blobTrigger: "uploads/in/a.csv", uri: "https://acct.blob.core.windows.net/uploads/in/a.csv", properties: { contentLength: 10 } }),
      "items",
      "uploads",
    );
    const rec = event.records[0];
    expect([event.type, rec.bucket, rec.key, rec.size, rec.action]).toEqual(["storage", "uploads", "in/a.csv", 10, "created"]);
    expect(rec.raw).toBe(content);
    expect(azure.toBlobEvent(content, ctx({ blobTrigger: "uploads/b" }), "items", "uploads").records[0].size).toBe(3);
  });

  test("service bus topic message (single and cardinality many)", async () => {
    const one = azure.toServiceBusEvent("hello", ctx({ messageId: "m1", applicationProperties: { k: "v" }, enqueuedTimeUtc: "2024-03-01T00:00:00Z" }), "items");
    expect(one.type).toBe("topic");
    expect(one.records[0].text()).toBe("hello");
    expect(one.records[0].attributes).toEqual({ k: "v" });
    expect(one.time.getUTCMonth()).toBe(2);
    const many = azure.toServiceBusEvent(["a", "b"], ctx({ messageIdArray: ["1", "2"], applicationPropertiesArray: [{}, { p: 1 }] }), "items");
    expect(many.records.map((r) => [r.id, r.body])).toEqual([["1", "a"], ["2", "b"]]);
    expect(many.records[1].attributes).toEqual({ p: 1 });
    await azure.serviceBus("x", ctx({ messageId: "m" }), "items");
    expect(seen.event!.type).toBe("topic");
  });
});

describe("register", () => {
  test("maps registrations onto the v4 app API", async () => {
    const calls: [string, string, Record<string, unknown>][] = [];
    const rec = (kind: string) => (name: string, options: Record<string, unknown>) => void calls.push([kind, name, options]);
    const app = {
      http: rec("http"),
      timer: rec("timer"),
      storageQueue: rec("storageQueue"),
      storageBlob: rec("storageBlob"),
      serviceBusTopic: rec("serviceBusTopic"),
    };
    azure.register(app, [
      { kind: "http", name: "items_http_0", function: "items", route: "items/{id}", methods: ["POST"], authLevel: "anonymous" },
      { kind: "timer", name: "t", function: "items", schedule: "0 */5 * * * *", input: 7 },
      { kind: "queue", name: "q", function: "items", queueName: "jobs", connection: "AzureWebJobsStorage" },
      { kind: "blob", name: "b", function: "items", path: "up/{name}", container: "up", connection: "AzureWebJobsStorage" },
      { kind: "topic", name: "s", function: "items", topicName: "t", subscriptionName: "items", connection: "NSKIT_SERVICEBUS" },
    ]);
    expect(calls.map(([k, n]) => `${k}:${n}`)).toEqual(["http:items_http_0", "timer:t", "storageQueue:q", "storageBlob:b", "serviceBusTopic:s"]);
    expect(calls[0][2]).toMatchObject({ methods: ["POST"], route: "items/{id}", authLevel: "anonymous" });
    expect(calls[1][2]).toMatchObject({ schedule: "0 */5 * * * *", runOnStartup: false });
    expect(calls[3][2]).toMatchObject({ path: "up/{name}", connection: "AzureWebJobsStorage" });
    expect(calls[4][2]).toMatchObject({ topicName: "t", subscriptionName: "items", connection: "NSKIT_SERVICEBUS" });

    const httpHandler = calls[0][2].handler as (req: unknown, c: unknown) => Promise<azure.AzureHttpResponseInit>;
    const res = await httpHandler(request("POST", "https://app/items/9", "", {}, { id: "9" }), ctx());
    expect(res.status).toBe(201);
    const timerHandler = calls[1][2].handler as (t: unknown, c: unknown) => Promise<void>;
    await timerHandler({}, ctx());
    expect(seen.event!.data).toBe(7);
  });
});
