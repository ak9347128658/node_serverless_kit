import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchFailure, BatchResult } from "../../src/runtime/batch.js";
import { Context } from "../../src/runtime/context.js";
import { applyCors, DEFAULT_CORS, errorResponse, execute, executeHttp, isHttp } from "../../src/runtime/dispatch.js";
import { HandlerNotFound, NotFound, TooManyRequests } from "../../src/runtime/errors.js";
import { Event, EventRecord, HttpRequest } from "../../src/runtime/event.js";
import { setLogSink } from "../../src/runtime/log.js";
import { installBundle, resolveFunction, resolveHandler, type AnyHandler } from "../../src/runtime/manifest.js";
import { HttpResponse } from "../../src/runtime/response.js";

const calls: string[] = [];
let logs: string[] = [];
let prevSink: ReturnType<typeof setLogSink>;

const handlers: Record<string, AnyHandler> = {
  ok: (event: Event, ctx: Context) => ({
    params: event.http?.pathParams ?? null,
    route: event.http?.route ?? null,
    fn: ctx.functionName,
    eventFn: event.functionName,
    method: event.http?.method ?? null,
  }),
  async: async () => ({ async: true }),
  boom: () => {
    throw new Error("secret detail");
  },
  notFound: () => {
    throw new NotFound("nope", { details: { id: 1 } });
  },
  limited: () => {
    throw new TooManyRequests(undefined, { headers: { "retry-after": "30" } });
  },
  stringThrow: () => {
    throw "plain string";
  },
  echoType: (event: Event) => ({ type: event.type, data: event.data }),
  batch: (event: Event) => BatchResult.of(event.records.filter((r) => r.text() === "fail")),
  batchOk: () => new BatchResult(),
  circular: () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    return o;
  },
  withHeaders: () => HttpResponse.json({ ok: true }, 200, { "access-control-allow-origin": "https://fixed.example" }),
  waiter: (_event: Event, ctx: Context) => {
    ctx.waitUntil(
      new Promise((resolve) =>
        setTimeout(() => {
          calls.push("background done");
          resolve(undefined);
        }, 20),
      ),
    );
    ctx.waitUntil(Promise.reject(new Error("background failure")));
    calls.push("handler returned");
    return "ok";
  },
  native: () => new Response("native", { status: 201, headers: { "content-type": "text/plain" } }),
  undef: () => undefined,
};

function install(extra: Record<string, unknown> = {}): void {
  installBundle({
    manifest: {
      service: "svc",
      stage: "dev",
      provider: "local",
      functions: {
        ok: {
          handler: "m.ok",
          routes: [
            { method: "GET", path: "/users/{id}", cors: { origins: ["https://app.example"] } },
            { method: "DELETE", path: "/users/{id}" },
            { method: "GET", path: "/hello" },
            { method: "GET", path: "/hello/{name}" },
            { method: "ANY", path: "/any" },
          ],
        },
        star: { handler: "m.ok", routes: [{ method: "GET", path: "/star", cors: {} }] },
        creds: {
          handler: "m.ok",
          routes: [
            {
              method: "POST",
              path: "/creds",
              cors: { origins: ["*"], allowCredentials: true, exposeHeaders: ["x-id"], methods: ["POST"], headers: ["x-token"], maxAge: 5 },
            },
          ],
        },
        async: { handler: "m.async" },
        boom: { handler: "m.boom" },
        nf: { handler: "m.notFound" },
        limited: { handler: "m.limited" },
        stringThrow: { handler: "m.stringThrow" },
        echo: { handler: "m.echoType" },
        batch: { handler: "m.batch" },
        batchOk: { handler: "m.batchOk" },
        circular: { handler: "m.circular" },
        withHeaders: { handler: "m.withHeaders", routes: [{ method: "GET", path: "/wh", cors: { origins: ["*"] } }] },
        waiter: { handler: "m.waiter" },
        native: { handler: "m.native" },
        undef: { handler: "m.undef" },
        missing: { handler: "m.missing" },
        ...extra,
      },
      workflows: {},
    },
    handlers: Object.fromEntries(Object.entries(handlers).map(([k, fn]) => [`m.${k}`, () => fn])),
  });
}

function http(method = "GET", path = "/", init: Partial<ConstructorParameters<typeof HttpRequest>[0]> = {}): Event {
  return new Event({ type: "http", http: new HttpRequest({ method, path, ...init }) });
}

function json(resp: unknown): Record<string, unknown> {
  return JSON.parse((resp as HttpResponse).body as string);
}

beforeEach(() => {
  calls.length = 0;
  logs = [];
  prevSink = setLogSink((line) => logs.push(line));
  install();
});

afterEach(() => {
  setLogSink(prevSink);
  vi.unstubAllEnvs();
});

describe("routing", () => {
  it("fills path params, route and context", async () => {
    const resp = await executeHttp(http("GET", "/users/42"), new Context(), "ok");
    expect(resp).toBeInstanceOf(HttpResponse);
    expect(resp.status).toBe(200);
    expect(json(resp)).toEqual({ params: { id: "42" }, route: "/users/{id}", fn: "ok", eventFn: "ok", method: "GET" });
  });

  it("keeps path params already provided by the gateway", async () => {
    const resp = await execute(http("GET", "/users/42", { pathParams: { id: "from-gw" } }), new Context(), "ok");
    expect(json(resp).params).toEqual({ id: "from-gw" });
  });

  it("prefers exact matches over tolerant ones", async () => {
    expect(json(await execute(http("GET", "/hello"), new Context(), "ok")).route).toBe("/hello");
    expect(json(await execute(http("GET", "/hello/Ada"), new Context(), "ok"))).toMatchObject({
      route: "/hello/{name}",
      params: { name: "Ada" },
    });
  });

  it("tolerates platform prefixes (Azure /api, GCP stripped static segments)", async () => {
    expect(json(await execute(http("GET", "/api/users/7"), new Context(), "ok")).params).toEqual({ id: "7" });
    expect(json(await execute(http("GET", "/7"), new Context(), "ok"))).toMatchObject({ route: "/users/{id}", params: { id: "7" } });
  });

  it("HEAD matches GET and ANY matches everything", async () => {
    expect((await executeHttp(http("HEAD", "/hello"), new Context(), "ok")).status).toBe(200);
    for (const m of ["GET", "POST", "PATCH"]) {
      expect((await executeHttp(http(m, "/any"), new Context(), "ok")).status).toBe(200);
    }
  });

  it("returns 405 with a sorted allow header when only the method differs", async () => {
    const resp = await executeHttp(http("POST", "/users/42"), new Context(), "ok");
    expect(resp.status).toBe(405);
    expect(resp.headers.allow).toBe("DELETE, GET");
    expect(json(resp)).toEqual({ error: "Method Not Allowed", status: 405 });
  });

  it("calls the handler when no route matches (gateway already routed)", async () => {
    const resp = await executeHttp(http("GET", "/totally/else"), new Context(), "ok");
    expect(resp.status).toBe(200);
    expect(json(resp).route).toBeNull();
  });

  it("functions without routes accept any request", async () => {
    const resp = await executeHttp(http("PUT", "/whatever"), new Context(), "async");
    expect(json(resp)).toEqual({ async: true });
  });
});

describe("CORS", () => {
  it("answers preflight for allowed origins", async () => {
    const pre = await executeHttp(http("OPTIONS", "/users/1", { headers: { Origin: "https://app.example" } }), new Context(), "ok");
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("https://app.example");
    expect(pre.headers.vary).toBe("Origin");
    expect(pre.headers["access-control-allow-methods"]).toBe(DEFAULT_CORS.methods!.join(", "));
    expect(pre.headers["access-control-allow-headers"]).toBe("Content-Type, Authorization, X-Requested-With");
    expect(pre.headers["access-control-max-age"]).toBe("600");
    expect(pre.headers).not.toHaveProperty("access-control-allow-credentials");
  });

  it("adds headers to normal responses only for allowed origins", async () => {
    const good = await executeHttp(http("GET", "/users/1", { headers: { Origin: "https://app.example" } }), new Context(), "ok");
    expect(good.headers["access-control-allow-origin"]).toBe("https://app.example");
    expect(good.headers).not.toHaveProperty("access-control-allow-methods");
    const evil = await executeHttp(http("GET", "/users/1", { headers: { Origin: "https://evil.example" } }), new Context(), "ok");
    expect(evil.headers).not.toHaveProperty("access-control-allow-origin");
    const none = await executeHttp(http("GET", "/users/1"), new Context(), "ok");
    expect(none.headers).not.toHaveProperty("access-control-allow-origin");
  });

  it("routes without cors get no CORS headers and OPTIONS reaches the handler", async () => {
    const del = await executeHttp(http("DELETE", "/users/1", { headers: { Origin: "https://app.example" } }), new Context(), "ok");
    expect(del.headers).not.toHaveProperty("access-control-allow-origin");
    const opt = await executeHttp(http("OPTIONS", "/hello"), new Context(), "ok");
    expect(opt.status).toBe(200);
    expect(json(opt).method).toBe("OPTIONS");
  });

  it("wildcard origin without credentials", async () => {
    const resp = await executeHttp(http("GET", "/star"), new Context(), "star");
    expect(resp.headers["access-control-allow-origin"]).toBe("*");
    expect(resp.headers).not.toHaveProperty("vary");
  });

  it("credentials echo the origin and expose headers", async () => {
    const pre = await executeHttp(http("OPTIONS", "/creds", { headers: { origin: "https://x.example" } }), new Context(), "creds");
    expect(pre.status).toBe(204);
    expect(pre.headers).toMatchObject({
      "access-control-allow-origin": "https://x.example",
      "access-control-allow-credentials": "true",
      "access-control-expose-headers": "x-id",
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": "x-token",
      "access-control-max-age": "5",
      vary: "Origin",
    });
    const noOrigin = await executeHttp(http("POST", "/creds"), new Context(), "creds");
    expect(noOrigin.headers).not.toHaveProperty("access-control-allow-origin");
  });

  it("never overrides headers set by the handler", async () => {
    const resp = await executeHttp(http("GET", "/wh", { headers: { origin: "https://a.example" } }), new Context(), "withHeaders");
    expect(resp.headers["access-control-allow-origin"]).toBe("https://fixed.example");
  });

  it("applyCors directly", () => {
    const resp = applyCors(new HttpResponse(200, "x"), { ...DEFAULT_CORS, origins: [] }, undefined, false);
    expect(resp.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("results and errors", () => {
  it("awaits async handlers and coerces results", async () => {
    expect(await execute(new Event({ type: "invoke" }), new Context(), "async")).toEqual({ async: true });
    expect((await executeHttp(http(), new Context(), "undef")).status).toBe(204);
    const native = await executeHttp(http(), new Context(), "native");
    expect(native.status).toBe(201);
    expect(new TextDecoder().decode(native.body as Uint8Array)).toBe("native");
  });

  it("maps HttpError to its status, body and headers", async () => {
    const nf = await executeHttp(http("GET", "/x"), new Context(), "nf");
    expect(nf.status).toBe(404);
    expect(json(nf)).toEqual({ error: "nope", status: 404, details: { id: 1 } });
    const lim = await executeHttp(http(), new Context(), "limited");
    expect(lim.status).toBe(429);
    expect(lim.headers["retry-after"]).toBe("30");
  });

  it("hides 500 details unless NSKIT_DEBUG is set", async () => {
    const hidden = await executeHttp(http("GET", "/x"), new Context({ requestId: "req-1" }), "boom");
    expect(hidden.status).toBe(500);
    expect(json(hidden)).toEqual({ error: "Internal Server Error", status: 500, requestId: "req-1" });
    vi.stubEnv("NSKIT_DEBUG", "1");
    const shown = await executeHttp(http("GET", "/x"), new Context({ requestId: "req-2" }), "boom");
    expect(json(shown)).toEqual({ error: "Internal Server Error", status: 500, requestId: "req-2", detail: "Error: secret detail" });
    expect(json(await executeHttp(http(), new Context(), "stringThrow")).detail).toBe("plain string");
  });

  it("logs failures and request lines", async () => {
    await executeHttp(http("GET", "/x"), new Context(), "boom");
    const parsed = logs.map((l) => JSON.parse(l));
    expect(parsed.find((l) => l.message === "handler failed")).toMatchObject({ level: "ERROR", error: { message: "secret detail" } });
    expect(parsed.find((l) => l.message === "request")).toMatchObject({ level: "INFO", method: "GET", path: "/x", status: 500 });
    logs = [];
    await executeHttp(http("GET", "/x"), new Context(), "nf");
    expect(logs.map((l) => JSON.parse(l).message)).toEqual(["request"]);
  });

  it("unserializable results become a 500", async () => {
    const resp = await executeHttp(http(), new Context(), "circular");
    expect(resp.status).toBe(500);
    expect(logs.some((l) => l.includes("could not serialize handler result"))).toBe(true);
  });

  it("non-HTTP errors propagate", async () => {
    await expect(execute(new Event({ type: "queue" }), new Context(), "boom")).rejects.toThrow("secret detail");
    await expect(execute(new Event({ type: "invoke" }), new Context(), "nf")).rejects.toBeInstanceOf(NotFound);
  });

  it("unknown functions and handlers", async () => {
    await expect(execute(new Event({ type: "invoke" }), new Context(), "nope")).rejects.toBeInstanceOf(HandlerNotFound);
    await expect(execute(new Event({ type: "invoke" }), new Context(), "missing")).rejects.toThrow(/Handler "m.missing" is not in this bundle/);
    const resp = await executeHttp(http(), new Context(), "nope");
    expect(resp.status).toBe(500);
    expect((await executeHttp(http(), new Context(), "missing")).status).toBe(500);
  });

  it("passes event type and data for non-HTTP events", async () => {
    expect(await execute(new Event({ type: "schedule", data: { a: 1 } }), new Context(), "echo")).toEqual({ type: "schedule", data: { a: 1 } });
  });
});

describe("batch results", () => {
  const queue = (provider: string) =>
    new Event({
      type: "queue",
      provider,
      records: [new EventRecord({ id: "m1", body: "ok" }), new EventRecord({ id: "m2", body: "fail" })],
    });

  it("is returned as-is on aws and local", async () => {
    for (const provider of ["aws", "local"]) {
      const out = await execute(queue(provider), new Context(), "batch");
      expect((out as BatchResult).failed).toEqual(["m2"]);
    }
  });

  it("fails the whole invocation elsewhere", async () => {
    await expect(execute(queue("gcp"), new Context(), "batch")).rejects.toBeInstanceOf(BatchFailure);
    await expect(execute(queue("azure"), new Context(), "batch")).rejects.toThrow("1 record(s) failed: m2");
    expect(await execute(queue("gcp"), new Context(), "batchOk")).toBeUndefined();
  });
});

describe("waitUntil", () => {
  it("awaits background work before finishing and swallows its errors", async () => {
    const out = await execute(new Event({ type: "invoke" }), new Context(), "waiter");
    expect(out).toBe("ok");
    expect(calls).toEqual(["handler returned", "background done"]);
    expect(logs.some((l) => l.includes("waitUntil task failed") && l.includes("background failure"))).toBe(true);
  });

  it("uses the platform's waitUntil when present", async () => {
    const seen: Promise<unknown>[] = [];
    const out = await executeHttp(http(), new Context({ waitUntil: (p) => seen.push(p) }), "waiter");
    expect(out.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(calls).toEqual(["handler returned"]);
    await Promise.allSettled(seen);
  });
});

describe("function resolution", () => {
  it("uses event.functionName, then NSKIT_FUNCTION", async () => {
    const ev = new Event({ type: "invoke", functionName: "echo", data: 1 });
    expect(await execute(ev, new Context())).toEqual({ type: "invoke", data: 1 });
    vi.stubEnv("NSKIT_FUNCTION", "async");
    expect(await execute(new Event({ type: "invoke" }), new Context())).toEqual({ async: true });
  });

  it("falls back to NSKIT_HANDLER and to a single-function manifest", async () => {
    installBundle({ manifest: { functions: {} }, handlers: { "m.async": () => handlers.async } });
    vi.stubEnv("NSKIT_HANDLER", "m.async");
    expect(resolveFunction()).toEqual({ name: "m.async", handler: "m.async", routes: [] });
    expect(await execute(new Event({ type: "invoke" }), new Context())).toEqual({ async: true });
    vi.unstubAllEnvs();
    installBundle({ manifest: { functions: { only: { handler: "m.async" } } }, handlers: { "m.async": () => handlers.async } });
    expect(resolveFunction()).toMatchObject({ name: "only", routes: [] });
    expect(() => resolveFunction("other")).toThrow(/Cannot resolve function "other".*Known functions: only/);
  });

  it("resolveHandler unwraps default exports, caches and validates", async () => {
    let loads = 0;
    const fn = () => "x";
    installBundle({
      handlers: {
        "a.def": () => {
          loads++;
          return { default: fn };
        },
        "a.notfn": () => ({ nope: 1 }),
        "a.promise": () => Promise.resolve(fn),
      },
    });
    expect(await resolveHandler("a.def")).toBe(fn);
    expect(await resolveHandler("a.def")).toBe(fn);
    expect(loads).toBe(1);
    expect(await resolveHandler("a.promise")).toBe(fn);
    await expect(resolveHandler("a.notfn")).rejects.toThrow(/is not a function \(got object\)/);
    await expect(resolveHandler("a.zzz")).rejects.toThrow(/Known: a.def, a.notfn, a.promise/);
  });

  it("isHttp", () => {
    expect(isHttp(http())).toBe(true);
    expect(isHttp(new Event({ type: "invoke" }))).toBe(false);
  });

  it("errorResponse for plain errors", () => {
    const resp = errorResponse(new Error("x"), new Context({ requestId: "r" }));
    expect(resp.status).toBe(500);
    expect(JSON.parse(resp.body as string)).toEqual({ error: "Internal Server Error", status: 500, requestId: "r" });
  });
});
