import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowConfig } from "../../src/config/schema.js";
import { Context } from "../../src/runtime/context.js";
import { execute } from "../../src/runtime/dispatch.js";
import { Event, HttpRequest } from "../../src/runtime/event.js";
import { setLogSink } from "../../src/runtime/log.js";
import { installBundle, type WorkflowDefinitionData } from "../../src/runtime/manifest.js";
import type { HttpResponse } from "../../src/runtime/response.js";
import {
  CHOICE_OPERATORS,
  evaluateRule,
  getPath,
  inProcessRunner,
  orchestrate,
  setPath,
  WorkflowEngine,
  WorkflowFailed,
} from "../../src/runtime/workflow.js";
import { definitionData } from "../../src/workflows/index.js";

class Flaky extends Error {
  override name = "Flaky";
}

type Def = Record<string, unknown>;

/** Build engine data from a config-style definition (snake_case accepted), like the CLI does. */
function def(raw: Def): WorkflowDefinitionData {
  return definitionData(WorkflowConfig.parse(raw));
}

function makeRunner(failTimes: Record<string, number> = {}) {
  const calls: [string, unknown][] = [];
  const remaining = { ...failTimes };
  const run = async (fn: string, data: unknown): Promise<unknown> => {
    calls.push([fn, structuredClone(data)]);
    if ((remaining[fn] ?? 0) > 0) {
      remaining[fn]--;
      throw new Flaky(`${fn} failed`);
    }
    if (fn === "double") return (data as number) * 2;
    if (fn === "inc") return { ...(data as Def), n: (((data as Def).n as number) ?? 0) + 1 };
    if (fn === "explode") throw new TypeError("bad input");
    return data;
  };
  return { run, calls };
}

let prevSink: ReturnType<typeof setLogSink>;
beforeEach(() => {
  prevSink = setLogSink(() => undefined);
});
afterEach(() => setLogSink(prevSink));

describe("JSON paths", () => {
  it("getPath", () => {
    const data = { a: { b: [1, { c: 2 }], "we ird": 3 } };
    expect(getPath(data, "$.a.b[1].c")).toBe(2);
    expect(getPath(data, "$.a.b[-1].c")).toBe(2);
    expect(getPath(data, "$['a']['we ird']")).toBe(3);
    expect(getPath(data, "$.a['b'][0]")).toBe(1);
    expect(getPath(data, "$")).toBe(data);
    expect(getPath(data, "")).toBe(data);
    expect(getPath(data, "$.x", null)).toBeNull();
    expect(getPath(null, "$.x", "d")).toBe("d");
    expect(() => getPath(data, "$.x")).toThrow("path $.x not found");
    expect(() => getPath(data, "a.b")).toThrow(/must start with '\$'/);
  });

  it("setPath returns a copy", () => {
    const data = { a: { b: 1 } };
    expect(setPath(data, "$.a.z", 5)).toEqual({ a: { b: 1, z: 5 } });
    expect(setPath(data, "$.new.deep", 1)).toEqual({ a: { b: 1 }, new: { deep: 1 } });
    expect(setPath(data, "$", 1)).toBe(1);
    expect(setPath(data, undefined, 2)).toBe(2);
    expect(setPath(data, null, 1)).toBe(data);
    expect(setPath(5, "$.x", 1)).toEqual({ x: 1 });
    expect(setPath({ list: [1, 2] }, "$.list[1]", 9)).toEqual({ list: [1, 9] });
    expect(data).toEqual({ a: { b: 1 } });
  });
});

describe("choice rules", () => {
  const data = { n: 2, s: "abc", none: null, list: ["x", "y"], obj: { k: 1 }, t: true };

  it.each([
    [{ variable: "$.n", gt: 1 }, true],
    [{ variable: "$.n", gte: 2 }, true],
    [{ variable: "$.n", lt: 2 }, false],
    [{ variable: "$.n", lte: 1 }, false],
    [{ variable: "$.s", gt: "abb" }, true],
    [{ variable: "$.s", lt: "b" }, true],
    [{ variable: "$.n", equals: 2 }, true],
    [{ variable: "$.n", notEquals: 2 }, false],
    [{ variable: "$.obj", equals: { k: 1 } }, true],
    [{ variable: "$.t", equals: true }, true],
    [{ variable: "$.s", matches: "ab*" }, true],
    [{ variable: "$.s", matches: "a?c" }, true],
    [{ variable: "$.s", matches: "a.c" }, false],
    [{ variable: "$.s", contains: "c" }, true],
    [{ variable: "$.list", contains: "y" }, true],
    [{ variable: "$.list", contains: "z" }, false],
    [{ variable: "$.n", in: [1, 2, 3] }, true],
    [{ variable: "$.n", in: "2" }, false],
    [{ variable: "$.missing", isPresent: false }, true],
    [{ variable: "$.none", isPresent: true }, true],
    [{ variable: "$.none", isNull: true }, true],
    [{ variable: "$.n", isNull: false }, true],
    [{ variable: "$.missing", isNull: true }, false],
    [{ variable: "$.missing", equals: 1 }, false],
    [{ variable: "$.missing", notEquals: 1 }, false],
    [{ and: [{ variable: "$.n", equals: 2 }, { not: { variable: "$.s", equals: "x" } }] }, true],
    [{ or: [{ variable: "$.n", equals: 9 }, { variable: "$.missing", equals: 1 }] }, false],
    [{ or: [{ variable: "$.n", equals: 9 }, { and: [{ variable: "$.t", equals: true }] }] }, true],
    [{ not: { not: { variable: "$.n", gt: 0 } } }, true],
    [{ variable: "$.s", gt: 3 }, false], // type mismatch -> false, not a crash
    [{ variable: "$.n", gt: "1" }, false],
    [{ equals: { n: 2, s: "abc", none: null, list: ["x", "y"], obj: { k: 1 }, t: true } }, true], // variable defaults to $
  ])("%j -> %s", (rule, expected) => {
    expect(evaluateRule(rule, data)).toBe(expected);
  });

  it("rejects rules without an operator", () => {
    expect(() => evaluateRule({ variable: "$.n" }, data)).toThrow(/Choice rule has no operator/);
    expect(CHOICE_OPERATORS).toEqual(["equals", "notEquals", "gt", "gte", "lt", "lte", "in", "contains", "matches", "isNull", "isPresent"]);
  });
});

describe("engine", () => {
  it("runs sequences, choices and pass states", async () => {
    const definition = def({
      start_at: "Inc",
      states: {
        Inc: { type: "task", function: "inc", next: "Check" },
        Check: { type: "choice", choices: [{ variable: "$.n", lt: 3, next: "Inc" }], default: "Tag" },
        Tag: { type: "pass", result: "done", result_path: "$.status", next: "End" },
        End: { type: "succeed" },
      },
    });
    const { run, calls } = makeRunner();
    const engine = new WorkflowEngine(definition, run);
    expect(await engine.run({ n: 0 })).toEqual({ n: 3, status: "done" });
    expect(calls).toHaveLength(3);
    expect(engine.history.map((h) => `${h.state}:${h.event}`)).toEqual([
      "Inc:enter",
      "Check:enter",
      "Inc:enter",
      "Check:enter",
      "Inc:enter",
      "Check:enter",
      "Tag:enter",
      "End:enter",
    ]);
    expect(engine.history[0]).toMatchObject({ type: "task" });
  });

  it("pass without result forwards input; resultPath null discards", async () => {
    const definition = def({
      start_at: "A",
      states: {
        A: { type: "pass", next: "B" },
        B: { type: "task", function: "double", input_path: "$.v", result_path: null, next: "C" },
        C: { type: "pass", result: { fixed: true } },
      },
    });
    expect(await new WorkflowEngine(definition, makeRunner().run).run({ v: 2 })).toEqual({ fixed: true });
    const keep = def({ start_at: "A", states: { A: { type: "task", function: "double", input_path: "$.v", result_path: null } } });
    expect(await new WorkflowEngine(keep, makeRunner().run).run({ v: 2 })).toEqual({ v: 2 });
  });

  it("runs with null input by default", async () => {
    const d = def({ start_at: "A", states: { A: { type: "succeed" } } });
    expect(await new WorkflowEngine(d, makeRunner().run).run()).toBeNull();
  });

  it("retries with exponential backoff, then succeeds", async () => {
    const definition = def({
      start_at: "T",
      states: { T: { type: "task", function: "inc", retry: [{ errors: ["Flaky"], max_attempts: 2 }], end: true } },
    });
    const { run, calls } = makeRunner({ inc: 2 });
    const sleeps: number[] = [];
    const engine = new WorkflowEngine(definition, run, { sleep: async (s) => void sleeps.push(s) });
    expect(await engine.run({ n: 0 })).toEqual({ n: 1 });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1, 2]);
    expect(engine.history.filter((h) => h.event === "retry").map((h) => h.attempt)).toEqual([1, 2]);
  });

  it("caps the delay with maxDelaySeconds and honours interval / backoff", async () => {
    const definition = def({
      start_at: "T",
      states: {
        T: {
          type: "task",
          function: "inc",
          retry: [{ max_attempts: 5, interval_seconds: 2, backoff_rate: 3, max_delay_seconds: 10 }],
          end: true,
        },
      },
    });
    const sleeps: number[] = [];
    await new WorkflowEngine(definition, makeRunner({ inc: 4 }).run, { sleep: async (s) => void sleeps.push(s) }).run({});
    expect(sleeps).toEqual([2, 6, 10, 10]);
  });

  it("uses the first matching retrier only; other errors are not retried", async () => {
    const definition = def({
      start_at: "T",
      states: {
        T: {
          type: "task",
          function: "explode",
          retry: [{ errors: ["Flaky"], max_attempts: 3 }, { errors: ["TypeError"], max_attempts: 1, interval_seconds: 0 }],
          end: true,
        },
      },
    });
    const { run, calls } = makeRunner();
    await expect(new WorkflowEngine(definition, run, { sleep: async () => undefined }).run({})).rejects.toMatchObject({
      error: "TypeError",
      cause: "bad input",
    });
    expect(calls).toHaveLength(2);
    const noRetry = def({ start_at: "T", states: { T: { type: "task", function: "inc", retry: [{ errors: ["Other"] }] } } });
    const r = makeRunner({ inc: 1 });
    await expect(new WorkflowEngine(noRetry, r.run).run({})).rejects.toMatchObject({ error: "Flaky" });
    expect(r.calls).toHaveLength(1);
  });

  it("maxAttempts 0 disables retries", async () => {
    const d = def({ start_at: "T", states: { T: { type: "task", function: "inc", retry: [{ max_attempts: 0 }] } } });
    const r = makeRunner({ inc: 1 });
    await expect(new WorkflowEngine(d, r.run).run({})).rejects.toBeInstanceOf(WorkflowFailed);
    expect(r.calls).toHaveLength(1);
  });

  it("catches after retries are exhausted, writing the error at resultPath", async () => {
    const definition = def({
      start_at: "T",
      states: {
        T: {
          type: "task",
          function: "inc",
          retry: [{ errors: ["*"], max_attempts: 1, interval_seconds: 0 }],
          catch: [{ errors: ["Flaky"], next: "Handle", result_path: "$.err" }],
          next: "Never",
        },
        Never: { type: "fail", error: "ShouldNotRun" },
        Handle: { type: "succeed" },
      },
    });
    const { run, calls } = makeRunner({ inc: 5 });
    const engine = new WorkflowEngine(definition, run, { sleep: async () => undefined });
    expect(await engine.run({ n: 0 })).toEqual({ n: 0, err: { error: "Flaky", cause: "inc failed" } });
    expect(calls).toHaveLength(2);
    expect(engine.history.some((h) => h.event === "caught" && h.error === "Flaky")).toBe(true);
  });

  it("catch defaults to $.error; resultPath null keeps input; $ replaces it; States.ALL matches", async () => {
    const mk = (catchRule: Def) =>
      def({
        start_at: "T",
        states: { T: { type: "task", function: "explode", catch: [{ next: "OK", ...catchRule }] }, OK: { type: "succeed" } },
      });
    const run = makeRunner().run;
    expect(await new WorkflowEngine(mk({}), run).run({ a: 1 })).toEqual({ a: 1, error: { error: "TypeError", cause: "bad input" } });
    expect(await new WorkflowEngine(mk({ result_path: null }), run).run({ a: 1 })).toEqual({ a: 1 });
    expect(await new WorkflowEngine(mk({ result_path: "$" }), run).run({ a: 1 })).toEqual({ error: "TypeError", cause: "bad input" });
    expect(await new WorkflowEngine(mk({ errors: ["States.ALL"] }), run).run({})).toHaveProperty("error");
    await expect(new WorkflowEngine(mk({ errors: ["Nope"] }), run).run({})).rejects.toMatchObject({ error: "TypeError" });
  });

  it("uses error.error as the error name (workflow task failures over HTTP)", async () => {
    const d = def({
      start_at: "T",
      states: { T: { type: "task", function: "f", catch: [{ errors: ["Custom"], next: "OK" }] }, OK: { type: "succeed" } },
    });
    const out = await new WorkflowEngine(d, () => {
      throw { error: "Custom", cause: "c" };
    }).run({});
    expect(out).toMatchObject({ error: { error: "Custom" } });
  });

  it("uncaught failures and fail states raise WorkflowFailed with history", async () => {
    const { run } = makeRunner();
    let err: WorkflowFailed | undefined;
    try {
      await new WorkflowEngine(def({ start_at: "T", states: { T: { type: "task", function: "explode", end: true } } }), run).run({});
    } catch (e) {
      err = e as WorkflowFailed;
    }
    expect(err).toBeInstanceOf(WorkflowFailed);
    expect(err!.error).toBe("TypeError");
    expect(err!.message).toBe("TypeError: bad input");
    expect(err!.history.length).toBeGreaterThan(0);
    await expect(
      new WorkflowEngine(def({ start_at: "F", states: { F: { type: "fail", error: "Nope", cause: "c" } } }), run).run({}),
    ).rejects.toMatchObject({ error: "Nope", cause: "c" });
    await expect(new WorkflowEngine(def({ start_at: "F", states: { F: { type: "fail" } } }), run).run({})).rejects.toMatchObject({
      error: "States.Fail",
      cause: "",
      message: "States.Fail",
    });
  });

  it("fails when no choice matches", async () => {
    const d = def({ start_at: "C", states: { C: { type: "choice", choices: [{ variable: "$.x", equals: 1, next: "C" }] } } });
    await expect(new WorkflowEngine(d, makeRunner().run).run({ x: 2 })).rejects.toThrow(/NoChoiceMatched/);
  });

  it("choice equals null and pass result null survive definitionData", async () => {
    const d = def({
      start_at: "C",
      states: {
        C: { type: "choice", choices: [{ variable: "$.x", equals: null, next: "Null" }], default: "Other" },
        Null: { type: "pass", result: null, end: true },
        Other: { type: "succeed" },
      },
    });
    expect(await new WorkflowEngine(d, makeRunner().run).run({ x: null })).toBeNull();
    expect(await new WorkflowEngine(d, makeRunner().run).run({ x: 1 })).toEqual({ x: 1 });
  });

  it("runs parallel branches on copies of the input and maps items", async () => {
    const branch = { start_at: "D", states: { D: { type: "task", function: "double", end: true } } };
    const definition = def({
      start_at: "P",
      states: {
        P: { type: "parallel", branches: [branch, { start_at: "X", states: { X: { type: "pass", result: "x" } } }], result_path: "$.par", next: "M" },
        M: { type: "map", items_path: "$.items", iterator: branch, result_path: "$.mapped", max_concurrency: 2, end: true },
      },
    });
    const { run } = makeRunner();
    const runner = (fn: string, data: unknown) => (fn === "double" && typeof data === "object" ? 0 : run(fn, data));
    expect(await new WorkflowEngine(definition, runner).run({ items: [1, 2, 3] })).toEqual({ items: [1, 2, 3], par: [0, "x"], mapped: [2, 4, 6] });
  });

  it("map respects maxConcurrency and keeps result order", async () => {
    let active = 0;
    let peak = 0;
    const runner = async (_fn: string, item: unknown) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15 - (item as number)));
      active--;
      return (item as number) * 10;
    };
    const mk = (extra: Def) =>
      def({ start_at: "M", states: { M: { type: "map", iterator: { start_at: "T", states: { T: { type: "task", function: "f" } } }, ...extra } } });
    const items = [1, 2, 3, 4, 5, 6, 7];
    expect(await new WorkflowEngine(mk({ max_concurrency: 2 }), runner).run(items)).toEqual(items.map((i) => i * 10));
    expect(peak).toBe(2);
    peak = 0;
    await new WorkflowEngine(mk({}), runner).run(items);
    expect(peak).toBe(7);
    expect(await new WorkflowEngine(mk({}), runner).run([])).toEqual([]);
    await expect(new WorkflowEngine(mk({ items_path: "$.nope" }), runner).run({ nope: 5 })).rejects.toMatchObject({ error: "TypeError" });
  });

  it("wait uses seconds or secondsPath with the injected sleep", async () => {
    const slept: number[] = [];
    const sleep = async (s: number) => void slept.push(s);
    const d = def({
      start_at: "W",
      states: {
        W: { type: "wait", seconds_path: "$.delay", next: "W2" },
        W2: { type: "wait", seconds: 0.5, next: "T" },
        T: { type: "task", function: "double", input_path: "$.v", result_path: "$.v2", end: true },
      },
    });
    expect(await new WorkflowEngine(d, makeRunner().run, { sleep }).run({ delay: 3, v: 4 })).toEqual({ delay: 3, v: 4, v2: 8 });
    expect(slept).toEqual([3, 0.5]);
  });

  it("guards against infinite loops", async () => {
    const d = def({ start_at: "L", states: { L: { type: "pass", next: "L" } } });
    await expect(new WorkflowEngine(d, makeRunner().run, { maxSteps: 10 }).run({})).rejects.toThrow(/exceeded 10 steps/);
  });

  it("reports unknown states and state types (raw definitions)", async () => {
    await expect(new WorkflowEngine({ startAt: "Z", states: {} }, makeRunner().run).run()).rejects.toThrow(/unknown state Z/);
    await expect(new WorkflowEngine({ startAt: "A", states: { A: { type: "loop" } } }, makeRunner().run).run()).rejects.toThrow(
      /unknown state type loop/,
    );
  });
});

describe("orchestrate", () => {
  const steps = {
    startAt: "First",
    states: {
      First: { type: "task", function: "step", next: "Second", resultPath: "$" },
      Second: { type: "task", function: "step", end: true, resultPath: "$" },
    },
  };

  beforeEach(() => {
    installBundle({
      manifest: {
        provider: "local",
        functions: {
          step: { handler: "m.step" },
          boom: { handler: "m.boom" },
          "pipeline-orchestrator": { handler: "node-serverless-kit/workflow.orchestrate", routes: [{ method: "POST", path: "/workflows/pipeline" }] },
          "broken-orchestrator": { handler: "node-serverless-kit/workflow.orchestrate" },
        },
        workflows: {
          pipeline: { orchestrator: "pipeline-orchestrator", definition: steps },
          broken: { orchestrator: "broken-orchestrator", definition: { startAt: "B", states: { B: { type: "task", function: "boom", end: true } } } },
        },
      },
      handlers: {
        "m.step": () => (event: Event) => {
          const data = { ...((event.data as Def) ?? {}) };
          data.steps = ((data.steps as number) ?? 0) + 1;
          data.type = event.type;
          return data;
        },
        "m.boom": () => () => {
          throw new RangeError("kaboom");
        },
        "node-serverless-kit/workflow.orchestrate": () => orchestrate,
      },
    });
  });

  it("runs directly (invoke event)", async () => {
    const out = (await execute(new Event({ type: "invoke", data: { steps: 0 } }), new Context(), "pipeline-orchestrator")) as Def;
    expect(out).toMatchObject({ workflow: "pipeline", status: "SUCCEEDED", output: { steps: 2, type: "workflow" } });
    expect(typeof out.durationMs).toBe("number");
  });

  it("runs over HTTP with a JSON body or query parameters", async () => {
    const body = new Event({ type: "http", http: new HttpRequest({ method: "POST", path: "/workflows/pipeline", body: '{"steps": 5}' }) });
    const resp = (await execute(body, new Context(), "pipeline-orchestrator")) as HttpResponse;
    expect(resp.status).toBe(200);
    expect(JSON.parse(resp.body as string)).toMatchObject({ status: "SUCCEEDED", output: { steps: 7 } });
    const query = new Event({ type: "http", http: new HttpRequest({ method: "POST", path: "/workflows/pipeline", query: { a: "1" } }) });
    const qresp = (await execute(query, new Context(), "pipeline-orchestrator")) as HttpResponse;
    expect(JSON.parse(qresp.body as string).output).toEqual({ a: "1", steps: 2, type: "workflow" });
  });

  it("reports failures as HTTP 500 or by throwing", async () => {
    const http = new Event({ type: "http", http: new HttpRequest({ method: "POST", path: "/" }) });
    const resp = (await execute(http, new Context(), "broken-orchestrator")) as HttpResponse;
    expect(resp.status).toBe(500);
    expect(JSON.parse(resp.body as string)).toEqual({ workflow: "broken", status: "FAILED", error: "RangeError", cause: "kaboom" });
    await expect(execute(new Event({ type: "invoke" }), new Context(), "broken-orchestrator")).rejects.toBeInstanceOf(WorkflowFailed);
  });

  it("errors when the function orchestrates no workflow", async () => {
    await expect(orchestrate(new Event({ type: "invoke", functionName: "step" }), new Context())).rejects.toThrow(
      /No workflow is orchestrated by function "step"/,
    );
  });

  it("inProcessRunner sends workflow events through the dispatcher", async () => {
    expect(await inProcessRunner("gcp")("step", { steps: 1 })).toEqual({ steps: 2, type: "workflow" });
  });
});
