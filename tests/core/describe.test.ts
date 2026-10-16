import { describe, expect, it } from "vitest";
import { EventSpecSchema } from "../../src/config/schema.js";
import { buildRecord, eventSummary, RECORD_FILE } from "../../src/core/describe.js";
import { VERSION } from "../../src/version.js";
import { fullConfig, makeProject } from "../helpers.js";

describe("eventSummary", () => {
  const sum = (raw: unknown) => eventSummary(EventSpecSchema.parse(raw));

  it("summarizes every trigger", () => {
    expect(sum({ http: { path: "/x", method: "post", auth: "jwt", cors: true } })).toEqual({
      type: "http",
      summary: "POST /x",
      method: "POST",
      path: "/x",
      auth: "jwt",
      cors: true,
    });
    expect(sum({ schedule: "5 minutes" })).toEqual({
      type: "schedule",
      summary: "rate(5 minutes)",
      rate: "5 minutes",
      cron: null,
      enabled: true,
      timezone: "UTC",
    });
    expect(sum({ schedule: { cron: "0 1 * * *", enabled: false } })).toMatchObject({ summary: "cron(0 1 * * *)", rate: null, enabled: false });
    expect(sum({ queue: { name: "jobs", batch_size: 5, existing: true } })).toEqual({
      type: "queue",
      summary: "queue jobs (batch 5)",
      name: "jobs",
      batchSize: 5,
      existing: true,
    });
    expect(sum({ storage: { bucket: "b", events: ["created", "deleted"], prefix: "in/", suffix: ".csv" } })).toEqual({
      type: "storage",
      summary: "bucket b [created, deleted] prefix=in/ suffix=.csv",
      bucket: "b",
      events: ["created", "deleted"],
      prefix: "in/",
      suffix: ".csv",
    });
    expect(sum({ storage: "b" })).toMatchObject({ summary: "bucket b [created]", prefix: null, suffix: null });
    expect(sum({ topic: "t" })).toEqual({ type: "topic", summary: "topic t", name: "t", existing: false });
  });
});

describe("buildRecord", () => {
  const project = makeProject(fullConfig("aws", "eu-west-1").replace("hello:\n", "hello:\n    environment: {B: '1', A: '2'}\n")).load();

  it("combines config and terraform outputs", () => {
    const outputs = {
      nskit: {
        functions: {
          hello: { id: "demo-dev-hello", arn: "arn:hello", base_url: "https://api.example/", console: "https://console/hello" },
          step: { id: "demo-dev-step", url: "" },
        },
        workflows: { pipeline: { id: "arn:sm", console: "https://console/sm" } },
        endpoint: "https://api.example",
      },
      extra_output: "kept",
    };
    const record = buildRecord(project, outputs, { sha256: "abc", size: 1 });
    expect(record).toMatchObject({
      schema: 1,
      status: "deployed",
      service: "demo",
      stage: "dev",
      provider: "aws",
      providerDisplay: "AWS Lambda",
      providerTier: "stable",
      region: "eu-west-1",
      endpoint: "https://api.example",
      nskitVersion: VERSION,
      configFile: "nskit.yml",
      artifact: { sha256: "abc", size: 1 },
      outputs: { extra_output: "kept" },
    });
    expect(record.deployedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(record.functions.map((f) => f.name)).toEqual(["hello", "step", "tick", "worker"]);

    const hello = record.functions[0];
    expect(hello).toMatchObject({
      resourceName: "demo-dev-hello",
      handler: "src/handlers.hello",
      kind: "http",
      generated: false,
      runtime: "nodejs22",
      memory: 256,
      timeout: 30,
      architecture: "x86_64",
      environmentKeys: ["A", "B"],
      id: "demo-dev-hello",
      arn: "arn:hello",
      url: null,
      console: "https://console/hello",
    });
    expect(hello.urls).toEqual([
      { method: "GET", url: "https://api.example/hello/{name}" },
      { method: "POST", url: "https://api.example/hello" },
    ]);
    const step = record.functions[1];
    expect(step).toMatchObject({ kind: "invoke-only", id: "demo-dev-step", url: null, urls: [], arn: null });
    expect(record.functions[2].kind).toBe("scheduled");
    expect(record.functions[3].kind).toBe("event-driven");
    expect(record.functions[3].events.map((e) => e.type)).toEqual(["queue", "storage", "topic"]);

    expect(record.workflows).toEqual([
      {
        name: "pipeline",
        description: "",
        engine: "native",
        startAt: "First",
        states: { First: "task", Second: "task" },
        functions: ["step"],
        id: "arn:sm",
        url: null,
        console: "https://console/sm",
      },
    ]);
  });

  it("works without outputs (packaged / removed)", () => {
    const record = buildRecord(project, {}, {}, "packaged");
    expect(record.status).toBe("packaged");
    expect(record.endpoint).toBeNull();
    expect(record.outputs).toEqual({});
    expect(record.functions.every((f) => f.id === null && f.urls.length === 0)).toBe(true);
    expect(RECORD_FILE).toBe("deployment.json");
  });

  it("marks generated orchestrators", () => {
    const p = makeProject(`
      service: wf
      provider: {name: aws}
      functions: {a: {handler: src/handlers.step}}
      workflows: {w: {engine: embedded, start_at: A, states: {A: {type: task, function: a}}}}
    `).load();
    const record = buildRecord(p);
    expect(record.functions.find((f) => f.name === "w-orchestrator")).toMatchObject({ generated: true, kind: "http" });
    expect(record.workflows[0].engine).toBe("embedded");
  });
});
