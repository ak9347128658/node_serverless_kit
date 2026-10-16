import { describe, expect, test } from "vitest";
import { WorkflowConfig } from "../../src/config/schema";
import { compileGcpWorkflow, readExpr, ruleExpr, assignTarget } from "../../src/workflows/gcp";
import { definitionData } from "../../src/workflows/index";

/* eslint-disable @typescript-eslint/no-explicit-any */

const WF = WorkflowConfig.parse({
  description: "demo",
  startAt: "Validate",
  states: {
    Validate: {
      type: "task",
      function: "validate",
      retry: [{ errors: ["Timeout"], maxAttempts: 4, intervalSeconds: 2, backoffRate: 1.5 }],
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
        { startAt: "A", states: { A: { type: "task", function: "charge", end: true } } },
        { startAt: "B", states: { B: { type: "pass", result: { ok: true }, end: true } } },
      ],
      resultPath: "$.fanout",
      next: "Items",
    },
    Items: {
      type: "map",
      itemsPath: "$.items",
      maxConcurrency: 5,
      iterator: { startAt: "I", states: { I: { type: "task", function: "charge", end: true } } },
      resultPath: "$.itemsOut",
      next: "Charge",
    },
    Charge: { type: "task", function: "charge", resultPath: null, end: true },
    Rejected: { type: "fail", error: "Rejected", cause: "invalid" },
  },
});

const stepNamed = (steps: any[], name: string) => steps.find((s) => name in s)?.[name];

describe("compileGcpWorkflow", () => {
  test("structure", () => {
    const { source, warnings } = compileGcpWorkflow(definitionData(WF), (f) => `https://${f}`, "orders");
    const main = source.main as any;
    expect(main.params).toEqual(["input"]);
    const names = main.steps.map((s: any) => Object.keys(s)[0]);
    expect(names[0]).toBe("s_init");
    expect(stepNamed(main.steps, "s_init").next).toBe("s_Validate_pre");
    for (const n of ["s_Validate_pre", "s_Validate_route", "s_Validate_out"]) expect(names).toContain(n);
    const validate = stepNamed(main.steps, "s_Validate");
    expect(validate.try.call).toBe("http.post");
    expect(validate.try.args.url).toBe("https://validate");
    expect(validate.try.args.auth).toEqual({ type: "OIDC" });
    expect(validate.try.args.body).toEqual({ __nskit: "workflow", data: "${data}" });
    expect(validate.retry.max_retries).toBe(4);
    expect(validate.retry.backoff).toEqual({ initial_delay: 2, max_delay: 300, multiplier: 1.5 });
    const pred = source[validate.retry.predicate.slice(2, -1)];
    expect(JSON.stringify(pred)).toContain("Timeout");
    expect(validate.except.as).toBe("e");
    const route = stepNamed(main.steps, "s_Validate_route");
    expect(route.switch[0]).toEqual({ condition: '${_caught == "Rejected"}', next: "s_Rejected" });

    // choice
    const choice = stepNamed(main.steps, "s_Route");
    expect(choice.switch[0]).toEqual({ condition: '${(map.get(data, ["amount"]) > 100)}', next: "s_Review" });
    expect(choice.next).toBe("s_Charge");
    // parallel / map branches become subworkflows
    expect(Object.keys(source).some((k) => k.startsWith("orders_s_Fanout_b"))).toBe(true);
    expect(Object.keys(source).some((k) => k.startsWith("orders_s_Items_it"))).toBe(true);
    expect(stepNamed(main.steps, "s_Items").parallel.concurrency_limit).toBe(5);
    expect(stepNamed(main.steps, "s_Fanout_out").assign[0]).toEqual({ "data.fanout": "${[par_s_Fanout.b0, par_s_Fanout.b1]}" });
    // Charge discards its result
    const out = stepNamed(main.steps, "s_Charge_out");
    expect(out.assign[0]).toHaveProperty("_discard");
    expect(out.return).toBe("${data}");
    expect(stepNamed(main.steps, "s_Rejected")).toEqual({ raise: { error: "Rejected", cause: "invalid" } });
    expect(warnings).toEqual([]);
    expect(() => JSON.stringify(source)).not.toThrow();
  });

  test("expressions", () => {
    expect(readExpr("$")).toBe("data");
    expect(readExpr("$.a.b")).toBe('map.get(data, ["a", "b"])');
    expect(readExpr("$.a[0]")).toBe('data["a"][0]');
    expect(assignTarget("$.a[1]")).toBe("data.a[1]");
    expect(assignTarget(null)).toBeNull();
    expect(ruleExpr({ variable: "$.n", gte: 3 })).toBe('(map.get(data, ["n"]) >= 3)');
    expect(ruleExpr({ variable: "$.n", notEquals: 3 })).toBe('(map.get(data, ["n"]) != 3)');
    expect(ruleExpr({ not: { variable: "$.s", in: ["a"] } })).toBe('(not (map.get(data, ["s"]) in ["a"]))');
    expect(ruleExpr({ variable: "$.s", matches: "a*.txt" })).toBe('text.match_regex(map.get(data, ["s"]), "^a.*\\\\.txt$")');
    expect(ruleExpr({ variable: "$.s", isNull: true })).toBe('(map.get(data, ["s"]) == null)');
    expect(ruleExpr({ variable: "$.s", isPresent: true })).toBe('(map.get(data, ["s"]) != null)');
    expect(() => ruleExpr({ variable: "$.s", bogus: 1 })).toThrow();
  });

  test("warns on multiple retries and retry on parallel states", () => {
    const wf = WorkflowConfig.parse({
      startAt: "T",
      states: {
        T: { type: "task", function: "f", retry: [{ errors: ["A"] }, { errors: ["B"] }], next: "P" },
        P: {
          type: "parallel",
          retry: [{ errors: ["A"] }],
          branches: [{ startAt: "X", states: { X: { type: "succeed" } } }],
          end: true,
        },
      },
    });
    const { warnings } = compileGcpWorkflow(definitionData(wf), (f) => f, "w");
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("first retry");
    expect(warnings[1]).toContain("parallel");
  });

  test("choice without default raises", () => {
    const wf = WorkflowConfig.parse({
      startAt: "C",
      states: { C: { type: "choice", choices: [{ variable: "$.x", equals: 1, next: "D" }] }, D: { type: "succeed" } },
    });
    const { source } = compileGcpWorkflow(definitionData(wf), (f) => f, "w");
    const sw = stepNamed((source.main as any).steps, "s_C").switch;
    expect(sw[1]).toEqual({ condition: true, raise: { error: "States.NoChoiceMatched", cause: "C" } });
  });
});
