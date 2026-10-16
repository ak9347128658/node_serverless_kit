/** Workflow tests: once with the real handlers, once with stubbed tasks. */

import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";
import { LocalRunner, WorkflowEngine, WorkflowFailed } from "node-serverless-kit/testing";

let runner: LocalRunner;

beforeAll(async () => {
  runner = await LocalRunner.fromConfig(fileURLToPath(new URL("../nskit.yml", import.meta.url)), { mode: "import" });
});

it("approves VIP customers end to end", async () => {
  const { output, history } = await runner.workflow("scoring", { customer: "ada", vip: true });
  expect(output).toEqual({ customer: "ada", vip: true, enriched: true, score: 90 });
  expect(history.filter((h) => h.event === "enter").map((h) => h.state)).toEqual(["Enrich", "Score", "Route", "Approve"]);
});

it("declines everybody else", async () => {
  const run = runner.workflow("scoring", { customer: "bob" });
  await expect(run).rejects.toBeInstanceOf(WorkflowFailed);
  await expect(run).rejects.toMatchObject({ error: "LowScore" });
});

it("tests only the routing with stubbed tasks", async () => {
  const calls: string[] = [];
  const definition = runner.manifest().workflows.scoring.definition;
  const engine = new WorkflowEngine(definition, (fn, data) => {
    calls.push(fn);
    return fn === "score" ? { ...(data as object), score: 85 } : data;
  });
  expect(await engine.run({ x: 1 })).toEqual({ x: 1, score: 85 });
  expect(calls).toEqual(["enrich", "score"]);
});
