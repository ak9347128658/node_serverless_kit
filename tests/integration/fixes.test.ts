// Regression tests for issues found while integrating the parallel workstreams.
import { afterEach, describe, expect, it } from "vitest";
import { ServiceConfigSchema } from "../../src/config/schema";
import { WorkflowEngine } from "../../src/runtime/workflow";
import { invoke } from "../../src/runtime/invoke";

describe("embedded engine: nested failures are catchable by the enclosing state", () => {
  const def = (type: "map" | "parallel") => ({
    startAt: "Fan",
    states: {
      Fan:
        type === "map"
          ? { type: "map", itemsPath: "$.items", iterator: { startAt: "T", states: { T: { type: "task", function: "f", end: true } } }, catch: [{ errors: ["OutOfStock"], next: "Rejected" }], end: true }
          : { type: "parallel", branches: [{ startAt: "T", states: { T: { type: "task", function: "f", end: true } } }], catch: [{ errors: ["OutOfStock"], next: "Rejected" }], end: true },
      Rejected: { type: "pass", result: "rejected", resultPath: "$.status", end: true },
    },
  });
  const failing = () => {
    const e = new Error("none left");
    e.name = "OutOfStock";
    throw e;
  };
  for (const type of ["map", "parallel"] as const) {
    it(type, async () => {
      const engine = new WorkflowEngine(def(type), failing);
      const out = (await engine.run({ items: [1, 2] })) as Record<string, unknown>;
      expect(out.status).toBe("rejected");
      expect(out.error).toMatchObject({ error: "OutOfStock", cause: "none left" });
    });
  }

  it("nested fail state propagates its error name", async () => {
    const engine = new WorkflowEngine(
      {
        startAt: "P",
        states: {
          P: { type: "parallel", branches: [{ startAt: "F", states: { F: { type: "fail", error: "Boom", cause: "c" } } }], end: true },
        },
      },
      () => null,
    );
    await expect(engine.run({})).rejects.toMatchObject({ error: "Boom", cause: "c" });
  });

  it("retry applies to map states", async () => {
    let calls = 0;
    const engine = new WorkflowEngine(
      {
        startAt: "M",
        states: {
          M: { type: "map", iterator: { startAt: "T", states: { T: { type: "task", function: "f", end: true } } }, retry: [{ errors: ["*"], maxAttempts: 2, intervalSeconds: 0 }], end: true },
        },
      },
      () => {
        if (++calls < 2) throw new Error("flaky");
        return "ok";
      },
      { sleep: async () => undefined },
    );
    expect(await engine.run([1])).toEqual(["ok"]);
  });
});

describe("schema: whole-value variables resolve to strings", () => {
  it("accepts boolean and numeric strings", () => {
    const cfg = ServiceConfigSchema.parse({
      service: "svc",
      provider: { name: "aws", memory: "512", timeout: "10" },
      functions: { f: { handler: "src/a.b", events: [{ schedule: { rate: "5 minutes", enabled: "false" } }, { queue: { name: "q", batchSize: "5", fifo: "true" } }] } },
    });
    expect(cfg.provider.memory).toBe(512);
    expect(cfg.functions.f.events[0].config).toMatchObject({ enabled: false });
    expect(cfg.functions.f.events[1].config).toMatchObject({ batchSize: 5, fifo: true });
  });

  it("still rejects garbage", () => {
    expect(ServiceConfigSchema.safeParse({ service: "svc", provider: { name: "aws", memory: "lots" } }).success).toBe(false);
  });
});

describe("invoke() on Cloudflare uses the service binding", () => {
  const key = Symbol.for("node-serverless-kit.cloudflare-env");
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[key];
    delete process.env.NSKIT_PROVIDER;
  });

  it("posts the envelope through NSKIT_BINDING_<FN>", async () => {
    process.env.NSKIT_PROVIDER = "cloudflare";
    let seen: unknown;
    (globalThis as Record<symbol, unknown>)[key] = {
      NSKIT_BINDING_BILLING_API: {
        fetch: async (_url: string, init: RequestInit) => {
          seen = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    };
    expect(await invoke("billing-api", { n: 1 })).toEqual({ ok: true });
    expect(seen).toEqual({ __nskit: "invoke", data: { n: 1 } });
  });
});
