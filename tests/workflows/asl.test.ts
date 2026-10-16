import { describe, expect, it } from "vitest";
import { WorkflowConfig } from "../../src/config/schema.js";
import { compileAsl, compileMachine, compileRule } from "../../src/workflows/asl.js";
import { definitionData } from "../../src/workflows/index.js";

const WF = WorkflowConfig.parse({
  description: "demo",
  start_at: "Validate",
  states: {
    Validate: {
      type: "task",
      function: "validate",
      comment: "check input",
      timeout_seconds: 30,
      retry: [{ errors: ["Timeout"], max_attempts: 4, interval_seconds: 2, backoff_rate: 1.5 }],
      catch: [{ errors: ["ValueError"], next: "Rejected" }],
      next: "Route",
    },
    Route: {
      type: "choice",
      choices: [
        { variable: "$.amount", gt: 100, next: "Review" },
        { and: [{ variable: "$.country", equals: "IN" }, { variable: "$.vip", equals: true }], next: "Fanout" },
      ],
      default: "Charge",
    },
    Review: { type: "wait", seconds: 60, next: "Charge" },
    Fanout: {
      type: "parallel",
      branches: [
        { start_at: "A", states: { A: { type: "task", function: "charge", end: true } } },
        { start_at: "B", states: { B: { type: "pass", result: { ok: true }, end: true } } },
      ],
      result_path: "$.fanout",
      next: "Items",
    },
    Items: {
      type: "map",
      items_path: "$.items",
      max_concurrency: 5,
      iterator: { start_at: "I", states: { I: { type: "task", function: "charge", end: true } } },
      result_path: "$.items_out",
      next: "Charge",
    },
    Charge: { type: "task", function: "charge", result_path: null, end: true },
    Rejected: { type: "fail", error: "Rejected", cause: "invalid" },
  },
});

describe("compileAsl", () => {
  const asl = compileAsl(definitionData(WF), (f) => `arn:${f}`, "demo", 300) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const st = asl.States;

  it("top level", () => {
    expect(asl.Comment).toBe("demo");
    expect(asl.TimeoutSeconds).toBe(300);
    expect(asl.StartAt).toBe("Validate");
    expect(Object.keys(asl)).toEqual(["Comment", "StartAt", "States", "TimeoutSeconds"]);
    expect(JSON.parse(JSON.stringify(asl))).toEqual(asl);
  });

  it("task states", () => {
    expect(st.Validate).toEqual({
      Comment: "check input",
      Type: "Task",
      Resource: "arn:validate",
      Parameters: { __nskit: "workflow", "data.$": "$" },
      TimeoutSeconds: 30,
      Next: "Route",
      Retry: [{ ErrorEquals: ["Timeout"], IntervalSeconds: 2, MaxAttempts: 4, BackoffRate: 1.5 }],
      Catch: [{ ErrorEquals: ["ValueError"], Next: "Rejected", ResultPath: "$.error" }],
    });
    expect(st.Charge).toEqual({
      Type: "Task",
      Resource: "arn:charge",
      Parameters: { __nskit: "workflow", "data.$": "$" },
      ResultPath: null,
      End: true,
    });
  });

  it("choice, wait, fail", () => {
    expect(st.Route.Choices[0]).toEqual({ Variable: "$.amount", NumericGreaterThan: 100, Next: "Review" });
    expect(st.Route.Choices[1]).toEqual({
      And: [
        { Variable: "$.country", StringEquals: "IN" },
        { Variable: "$.vip", BooleanEquals: true },
      ],
      Next: "Fanout",
    });
    expect(st.Route.Default).toBe("Charge");
    expect(st.Route).not.toHaveProperty("Next");
    expect(st.Review).toEqual({ Type: "Wait", Seconds: 60, Next: "Charge" });
    expect(st.Rejected).toEqual({ Type: "Fail", Error: "Rejected", Cause: "invalid" });
  });

  it("parallel and map", () => {
    expect(st.Fanout.Type).toBe("Parallel");
    expect(st.Fanout.Branches).toEqual([
      { StartAt: "A", States: { A: { Type: "Task", Resource: "arn:charge", Parameters: { __nskit: "workflow", "data.$": "$" }, End: true } } },
      { StartAt: "B", States: { B: { Type: "Pass", Result: { ok: true }, End: true } } },
    ]);
    expect(st.Fanout.ResultPath).toBe("$.fanout");
    expect(st.Fanout.Next).toBe("Items");
    expect(st.Items).toMatchObject({
      Type: "Map",
      ItemsPath: "$.items",
      MaxConcurrency: 5,
      ResultPath: "$.items_out",
      Next: "Charge",
      ItemProcessor: { ProcessorConfig: { Mode: "INLINE" }, StartAt: "I" },
    });
    expect(st.Items.ItemProcessor.States.I.Resource).toBe("arn:charge");
  });

  it("omits comment / timeout when not given", () => {
    const out = compileAsl({ startAt: "S", states: { S: { type: "succeed" } } }, (f) => f);
    expect(out).toEqual({ StartAt: "S", States: { S: { Type: "Succeed" } } });
  });
});

describe("state details", () => {
  const compile = (states: Record<string, unknown>) =>
    compileMachine(definitionData(WorkflowConfig.parse({ startAt: Object.keys(states)[0], states })), (f) => `arn:${f}`).States as Record<
      string,
      Record<string, unknown>
    >;

  it("pass with result, input/result paths", () => {
    expect(compile({ P: { type: "pass", result: [1, 2], input_path: "$.in", result_path: "$.r" } }).P).toEqual({
      Type: "Pass",
      Result: [1, 2],
      InputPath: "$.in",
      ResultPath: "$.r",
      End: true,
    });
    expect(compile({ P: { type: "pass" } }).P).toEqual({ Type: "Pass", End: true });
    expect(compile({ P: { type: "pass", result: null } }).P).toEqual({ Type: "Pass", Result: null, End: true });
  });

  it("wait with secondsPath and inputPath; fractional seconds are truncated", () => {
    expect(compile({ W: { type: "wait", seconds_path: "$.delay", input_path: "$.x" } }).W).toEqual({
      Type: "Wait",
      SecondsPath: "$.delay",
      InputPath: "$.x",
      End: true,
    });
    expect(compile({ W: { type: "wait", seconds: 2.9 } }).W).toEqual({ Type: "Wait", Seconds: 2, End: true });
  });

  it("retry rounding, defaults, maxDelaySeconds and States.ALL", () => {
    const t = compile({
      T: {
        type: "task",
        function: "f",
        retry: [{ interval_seconds: 0.2, max_delay_seconds: 30 }, { errors: ["States.ALL"], max_attempts: 0 }],
        catch: [{ errors: ["*"], next: "T", result_path: null }, { errors: ["A", "B"], next: "T", result_path: "$" }],
      },
    }).T;
    expect(t.Retry).toEqual([
      { ErrorEquals: ["States.ALL"], IntervalSeconds: 1, MaxAttempts: 3, BackoffRate: 2, MaxDelaySeconds: 30 },
      { ErrorEquals: ["States.ALL"], IntervalSeconds: 1, MaxAttempts: 0, BackoffRate: 2 },
    ]);
    expect(t.Catch).toEqual([
      { ErrorEquals: ["States.ALL"], Next: "T", ResultPath: null },
      { ErrorEquals: ["A", "B"], Next: "T", ResultPath: "$" },
    ]);
  });

  it("retry / catch on parallel and map, not on pass", () => {
    const states = compile({
      P: {
        type: "parallel",
        branches: [{ start_at: "X", states: { X: { type: "succeed" } } }],
        retry: [{ errors: ["E"] }],
        catch: [{ next: "F" }],
        next: "M",
      },
      M: { type: "map", iterator: { start_at: "Y", states: { Y: { type: "succeed" } } }, retry: [{}], next: "F" },
      F: { type: "pass", retry: [{}], catch: [{ next: "P" }] },
    });
    expect(states.P.Retry).toHaveLength(1);
    expect(states.P.Catch).toHaveLength(1);
    expect(states.M.Retry).toHaveLength(1);
    expect(states.M).not.toHaveProperty("ItemsPath");
    expect(states.M).not.toHaveProperty("MaxConcurrency");
    expect(states.F).not.toHaveProperty("Retry");
    expect(states.F).not.toHaveProperty("Catch");
  });

  it("choice equals null survives definitionData", () => {
    const c = compile({ C: { type: "choice", choices: [{ variable: "$.x", equals: null, next: "D" }] }, D: { type: "succeed" } }).C;
    expect(c.Choices).toEqual([{ Variable: "$.x", IsNull: true, Next: "D" }]);
  });

  it("rejects unknown state types", () => {
    expect(() => compileMachine({ startAt: "A", states: { A: { type: "loop" } } }, (f) => f)).toThrow("unknown state type loop");
  });
});

describe("compileRule", () => {
  it.each([
    [{ variable: "$.s", equals: "x" }, { Variable: "$.s", StringEquals: "x" }],
    [{ variable: "$.n", equals: 1.5 }, { Variable: "$.n", NumericEquals: 1.5 }],
    [{ variable: "$.b", equals: false }, { Variable: "$.b", BooleanEquals: false }],
    [{ variable: "$.s", equals: null }, { Variable: "$.s", IsNull: true }],
    [{ variable: "$.n", notEquals: 1 }, { Not: { Variable: "$.n", NumericEquals: 1 } }],
    [{ variable: "$.n", gt: 1 }, { Variable: "$.n", NumericGreaterThan: 1 }],
    [{ variable: "$.n", gte: 1 }, { Variable: "$.n", NumericGreaterThanEquals: 1 }],
    [{ variable: "$.n", lt: 1 }, { Variable: "$.n", NumericLessThan: 1 }],
    [{ variable: "$.s", lte: "m" }, { Variable: "$.s", StringLessThanEquals: "m" }],
    [{ variable: "$.s", gt: "m" }, { Variable: "$.s", StringGreaterThan: "m" }],
    [{ variable: "$.s", contains: "ab" }, { Variable: "$.s", StringMatches: "*ab*" }],
    [{ variable: "$.s", contains: "a*b" }, { Variable: "$.s", StringMatches: "*a\\*b*" }],
    [{ variable: "$.s", matches: "img-*.png" }, { Variable: "$.s", StringMatches: "img-*.png" }],
    [
      { variable: "$.n", in: [1, "two"] },
      { Or: [{ Variable: "$.n", NumericEquals: 1 }, { Variable: "$.n", StringEquals: "two" }] },
    ],
    [{ variable: "$.p", isPresent: true }, { Variable: "$.p", IsPresent: true }],
    [{ variable: "$.p", isNull: false }, { Variable: "$.p", IsNull: false }],
    [{ equals: "root" }, { Variable: "$", StringEquals: "root" }],
    [
      { or: [{ variable: "$.a", equals: 1 }, { not: { variable: "$.b", isPresent: true } }] },
      { Or: [{ Variable: "$.a", NumericEquals: 1 }, { Not: { Variable: "$.b", IsPresent: true } }] },
    ],
  ])("%j", (rule, expected) => {
    expect(compileRule(rule)).toEqual(expected);
  });

  it("rejects what ASL cannot express", () => {
    expect(() => compileRule({ variable: "$.o", equals: { a: 1 } })).toThrow(/cannot compare objects\/arrays/);
    expect(() => compileRule({ variable: "$.o", equals: [1] })).toThrow(/cannot compare objects\/arrays/);
    expect(() => compileRule({ variable: "$.b", gt: true })).toThrow("operator gt cannot compare booleans");
    expect(() => compileRule({ variable: "$.x" })).toThrow(/unsupported choice rule/);
  });
});

describe("definitionData", () => {
  it("drops config-only keys, empty values and end: false; keeps resultPath null", () => {
    const wf = WorkflowConfig.parse({
      description: "d",
      engine: "native",
      timeout: 10,
      options: { type: "express" },
      start_at: "A",
      states: {
        A: { type: "task", function: "f", result_path: null, next: "B" },
        B: { type: "succeed" },
      },
    });
    expect(definitionData(wf)).toEqual({
      startAt: "A",
      states: {
        A: { type: "task", function: "f", next: "B", resultPath: null },
        B: { type: "succeed", resultPath: "$" },
      },
    });
  });

  it("keeps nested definitions and catch result paths", () => {
    const wf = WorkflowConfig.parse({
      start_at: "M",
      states: {
        M: {
          type: "map",
          iterator: { start_at: "T", states: { T: { type: "task", function: "f", catch: [{ next: "T" }] } } },
        },
      },
    });
    const data = definitionData(wf) as unknown as { states: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(data.states.M.iterator.states.T).toEqual({
      type: "task",
      function: "f",
      end: true,
      resultPath: "$",
      catch: [{ errors: ["*"], next: "T", resultPath: "$.error" }],
    });
  });
});
