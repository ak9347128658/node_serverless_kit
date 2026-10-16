import { describe, expect, it } from "vitest";
import {
  architectureOf,
  camelCase,
  corsOf,
  EventSpecSchema,
  eventsOf,
  FunctionConfig,
  functionKind,
  HttpEvent,
  memoryOf,
  normalizeRuntime,
  runtimeOf,
  ScheduleEvent,
  ServiceConfigSchema,
  taskFunctions,
  timeoutOf,
  WorkflowConfig,
  type ServiceConfig,
} from "../../src/config/schema.js";
import { parseConfig } from "../../src/config/loader.js";

function issues(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }): string[] {
  expect(result.success).toBe(false);
  return result.error!.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`);
}

const base = { service: "svc", provider: { name: "aws" } };

describe("helpers", () => {
  it("camelCase converts snake and kebab case", () => {
    expect(camelCase("batch_size")).toBe("batchSize");
    expect(camelCase("log-retention-days")).toBe("logRetentionDays");
    expect(camelCase("already")).toBe("already");
  });

  it.each([
    ["22", "nodejs22"],
    ["node22", "nodejs22"],
    ["nodejs22", "nodejs22"],
    ["nodejs22.x", "nodejs22"],
    ["NodeJS20.x", "nodejs20"],
    [" 24 ", "nodejs24"],
    ["python3.12", "python3.12"],
  ])("normalizeRuntime(%j) = %j", (input, expected) => {
    expect(normalizeRuntime(input)).toBe(expected);
  });
});

describe("event shorthands", () => {
  it.each([
    [{ http: "POST /a/{id}" }, "http", { method: "POST", path: "/a/{id}" }],
    [{ http: "/plain" }, "http", { method: "GET", path: "/plain" }],
    [{ http: "get   /spaced" }, "http", { method: "GET", path: "/spaced" }],
    [{ http: { path: "x", method: "*" } }, "http", { method: "ANY", path: "/x" }],
    [{ http: { path: "//double" } }, "http", { path: "/double" }],
    [{ http: null }, "http", { method: "GET", path: "/" }],
    [{ schedule: "10 minutes" }, "schedule", { rate: "10 minutes", enabled: true, timezone: "UTC" }],
    [{ schedule: "1 Day" }, "schedule", { rate: "1 Day" }],
    [{ schedule: "0 1 * * *" }, "schedule", { cron: "0 1 * * *" }],
    [{ queue: "jobs" }, "queue", { name: "jobs", batchSize: 10, batchWindow: 0, maxReceive: 5, fifo: false, existing: false }],
    [{ storage: "bkt" }, "storage", { bucket: "bkt", events: ["created"], existing: false }],
    [{ topic: "t" }, "topic", { name: "t", existing: false }],
    [{ type: "queue", config: { name: "q" } }, "queue", { name: "q" }],
  ])("%j", (raw, kind, expected) => {
    const spec = EventSpecSchema.parse(raw);
    expect(spec.type).toBe(kind);
    expect(spec.config).toMatchObject(expected);
  });

  it("accepts snake_case and camelCase keys", () => {
    const snake = EventSpecSchema.parse({
      queue: { name: "q", batch_size: 5, batch_window: 3, visibility_timeout: 60, dead_letter: "dlq", max_receive: 2 },
    });
    const camel = EventSpecSchema.parse({
      queue: { name: "q", batchSize: 5, batchWindow: 3, visibilityTimeout: 60, deadLetter: "dlq", maxReceive: 2 },
    });
    expect(snake).toEqual(camel);
    expect(snake.config).toMatchObject({ batchSize: 5, batchWindow: 3, visibilityTimeout: 60, deadLetter: "dlq", maxReceive: 2 });
  });

  it("http defaults and cors", () => {
    const ev = HttpEvent.parse({});
    expect(ev).toEqual({ path: "/", method: "GET", cors: false, auth: "none", authorizer: {} });
    expect(corsOf(ev)).toBeUndefined();
    expect(corsOf(HttpEvent.parse({ cors: true }))).toEqual({
      origins: ["*"],
      exposeHeaders: [],
      allowCredentials: false,
      maxAge: 600,
    });
    const custom = HttpEvent.parse({
      cors: { origins: ["https://a.example"], allow_credentials: true, max_age: 60, expose_headers: ["x-id"], methods: ["GET"] },
    });
    expect(corsOf(custom)).toMatchObject({
      origins: ["https://a.example"],
      allowCredentials: true,
      maxAge: 60,
      exposeHeaders: ["x-id"],
      methods: ["GET"],
    });
  });

  it.each(["/a/{bad-name}", "/a/{x}{y}", "/a/{x+}/b", "/a/{1x}"])("rejects path template %s", (p) => {
    const msgs = issues(EventSpecSchema.safeParse({ http: { path: p } }));
    expect(msgs.join("\n")).toMatch(/http\.path: invalid path template/);
  });

  it.each(["/users/{id}", "/files/{path+}", "/a/{x}/b/{y}", "/v1.0/~me"])("accepts path %s", (p) => {
    expect(EventSpecSchema.safeParse({ http: { path: p } }).success).toBe(true);
  });

  it("rejects unknown methods and auth", () => {
    expect(issues(EventSpecSchema.safeParse({ http: "FETCH /x" })).join()).toMatch(/http\.method: method must be one of/);
    expect(issues(EventSpecSchema.safeParse({ http: { auth: "basic" } })).join()).toMatch(/http\.auth/);
  });

  it("rejects malformed events", () => {
    expect(issues(EventSpecSchema.safeParse({ http: {}, queue: "x" })).join()).toMatch(/single-key mapping/);
    expect(issues(EventSpecSchema.safeParse("http")).join()).toMatch(/single-key mapping/);
    expect(issues(EventSpecSchema.safeParse({ bogus: {} })).join()).toMatch(/unknown event type 'bogus'/);
    expect(issues(EventSpecSchema.safeParse({ queue: {} })).join()).toMatch(/queue\.name/);
    expect(issues(EventSpecSchema.safeParse({ queue: { name: "q", batchSize: 0 } })).join()).toMatch(/queue\.batchSize/);
    expect(issues(EventSpecSchema.safeParse({ queue: { name: "q", nope: 1 } })).join()).toMatch(/nope/);
    expect(issues(EventSpecSchema.safeParse({ storage: { bucket: "b", events: ["modified"] } })).join()).toMatch(
      /storage\.events/,
    );
    expect(issues(EventSpecSchema.safeParse({ storage: { bucket: "b", events: [] } })).join()).toMatch(/storage\.events/);
  });
});

describe("schedule", () => {
  it("needs exactly one of rate / cron", () => {
    expect(issues(ScheduleEvent.safeParse({ rate: "5 minutes", cron: "* * * * *" })).join()).toMatch(/exactly one/);
    expect(issues(ScheduleEvent.safeParse({})).join()).toMatch(/exactly one/);
  });

  it("validates rate and cron syntax", () => {
    expect(issues(ScheduleEvent.safeParse({ rate: "often" })).join()).toMatch(/^rate: rate must look like/);
    expect(issues(ScheduleEvent.safeParse({ rate: "5 seconds" })).join()).toMatch(/rate must look like/);
    expect(issues(ScheduleEvent.safeParse({ cron: "* * * *" })).join()).toMatch(/^cron: cron must be a standard 5-field/);
    expect(issues(ScheduleEvent.safeParse({ cron: "0 0 * * * *" })).join()).toMatch(/5-field/);
  });

  it("keeps input, name, timezone and enabled", () => {
    const ev = ScheduleEvent.parse({ cron: "0 9 * * 1", input: { a: 1 }, name: "weekly", timezone: "Asia/Kolkata", enabled: false });
    expect(ev).toMatchObject({ cron: "0 9 * * 1", input: { a: 1 }, name: "weekly", timezone: "Asia/Kolkata", enabled: false });
  });

  it("reports event errors with the full path inside a function", () => {
    const res = ServiceConfigSchema.safeParse({
      ...base,
      functions: { f: { handler: "a.b", events: [{ http: "/ok" }, { schedule: { rate: "often" } }] } },
    });
    expect(issues(res)).toContain("functions.f.events.1.schedule.rate: rate must look like '<n> minutes|hours|days'");
  });
});

describe("functions", () => {
  it.each(["src/orders.getOrder", "src/index.default", "lib/api.handlers.list", "app.handler", "@scope/x.y", "a-b/c_d.e$f"])(
    "accepts handler %s",
    (handler) => {
      expect(FunctionConfig.safeParse({ handler }).success).toBe(true);
    },
  );

  it.each(["nodots", "src/orders.", ".hidden.x", "src/orders.1abc", "a b.c", ""])("rejects handler %j", (handler) => {
    expect(issues(FunctionConfig.safeParse({ handler })).join()).toMatch(/handler/);
  });

  it("applies defaults", () => {
    const fn = FunctionConfig.parse({ handler: "a.b" });
    expect(fn).toMatchObject({
      handler: "a.b",
      description: "",
      environment: {},
      tags: {},
      events: [],
      iam: { statements: [] },
      options: {},
    });
    expect(fn.runtime ?? null).toBeNull();
    expect(fn.memory ?? null).toBeNull();
  });

  it("coerces environment and tags to strings", () => {
    const fn = FunctionConfig.parse({ handler: "a.b", environment: { N: 1, B: true, E: null, O: { a: [1] } }, tags: { team: 7 } });
    expect(fn.environment).toEqual({ N: "1", B: "true", E: "", O: '{"a":[1]}' });
    expect(fn.tags).toEqual({ team: "7" });
  });

  it.each([
    ["22", "nodejs22"],
    [22, "nodejs22"],
    ["node20", "nodejs20"],
    ["nodejs24.x", "nodejs24"],
  ])("normalizes runtime %j", (runtime, expected) => {
    expect(FunctionConfig.parse({ handler: "a.b", runtime }).runtime).toBe(expected);
  });

  it("rejects unknown runtimes and keys", () => {
    expect(issues(FunctionConfig.safeParse({ handler: "a.b", runtime: "python3.12" })).join()).toMatch(/runtime: runtime must be one of/);
    expect(issues(FunctionConfig.safeParse({ handler: "a.b", runtime: "16" })).join()).toMatch(/runtime/);
    expect(issues(FunctionConfig.safeParse({ handler: "a.b", unknown_key: 1 })).join()).toMatch(/unknown_key/);
    expect(issues(FunctionConfig.safeParse({ handler: "a.b", memory: 32 })).join()).toMatch(/memory/);
    expect(issues(FunctionConfig.safeParse({ handler: "a.b", timeout: 0 })).join()).toMatch(/timeout/);
    expect(issues(FunctionConfig.safeParse({ handler: "a.b", architecture: "arm" })).join()).toMatch(/architecture/);
  });

  it("iam statements default effect and resources", () => {
    const fn = FunctionConfig.parse({ handler: "a.b", iam: { statements: [{ actions: ["s3:GetObject"] }], role: null } });
    expect(fn.iam.statements).toEqual([{ effect: "Allow", actions: ["s3:GetObject"], resources: ["*"] }]);
    expect(issues(FunctionConfig.safeParse({ handler: "a.b", iam: { statements: [{ actions: [] }] } })).join()).toMatch(/actions/);
  });

  it("functionKind and eventsOf", () => {
    const kind = (events: unknown[]) => functionKind(FunctionConfig.parse({ handler: "a.b", events }));
    expect(kind([])).toBe("invoke-only");
    expect(kind([{ http: "/x" }])).toBe("http");
    expect(kind([{ schedule: "1 day" }])).toBe("scheduled");
    expect(kind([{ http: "/x" }, { queue: "q" }])).toBe("http+event");
    expect(kind([{ queue: "q" }, { topic: "t" }])).toBe("event-driven");
    const fn = FunctionConfig.parse({ handler: "a.b", events: [{ http: "/x" }, { queue: "q" }, { http: "POST /y" }] });
    expect(eventsOf(fn, "http").map((e) => e.path)).toEqual(["/x", "/y"]);
    expect(eventsOf(fn, "queue").map((e) => e.name)).toEqual(["q"]);
  });
});

describe("provider and package", () => {
  it("applies defaults", () => {
    const cfg = parseConfig(base);
    expect(cfg.provider).toMatchObject({
      name: "aws",
      stage: "dev",
      memory: 256,
      timeout: 30,
      architecture: "x86_64",
      environment: {},
      tags: {},
      iam: { statements: [] },
      logRetentionDays: 14,
      options: {},
      state: { config: {} },
      terraform: { requiredVersion: ">= 1.5.0", extra: {} },
    });
    expect(cfg.provider.runtime ?? null).toBeNull();
    expect(cfg.package).toEqual({
      source: ".",
      include: [],
      exclude: [],
      external: [],
      minify: false,
      sourcemap: true,
      esbuild: {},
    });
    expect(cfg.functions).toEqual({});
    expect(cfg.workflows).toEqual({});
    expect(cfg.hooks).toEqual({});
    expect(cfg.custom).toEqual({});
  });

  it("accepts snake_case provider keys", () => {
    const cfg = parseConfig({
      service: "svc",
      provider: {
        name: "aws",
        log_retention_days: null,
        runtime: "nodejs20.x",
        terraform: { required_version: ">= 1.6", provider_version: "~> 5.0" },
        state: { backend: "s3", config: { bucket: "b" } },
      },
      package: { tsconfig: "tsconfig.build.json", external: ["sharp"] },
    });
    expect(cfg.provider.logRetentionDays).toBeNull();
    expect(cfg.provider.runtime).toBe("nodejs20");
    expect(cfg.provider.terraform).toMatchObject({ requiredVersion: ">= 1.6", providerVersion: "~> 5.0" });
    expect(cfg.provider.state).toEqual({ backend: "s3", config: { bucket: "b" } });
    expect(cfg.package.tsconfig).toBe("tsconfig.build.json");
    expect(cfg.package.external).toEqual(["sharp"]);
  });

  it("validates service, stage and provider name", () => {
    expect(issues(ServiceConfigSchema.safeParse({ service: "x", provider: { name: "aws" } })).join()).toMatch(/service: service must be/);
    expect(issues(ServiceConfigSchema.safeParse({ service: "Bad_Name", provider: { name: "aws" } })).join()).toMatch(/service/);
    expect(issues(ServiceConfigSchema.safeParse({ ...base, provider: { name: "aws", stage: "Prod" } })).join()).toMatch(
      /provider\.stage: stage must be lowercase/,
    );
    expect(issues(ServiceConfigSchema.safeParse({ ...base, provider: { name: "A" } })).join()).toMatch(/provider\.name/);
    expect(issues(ServiceConfigSchema.safeParse({ ...base, provider: { name: "aws", bogus: 1 } })).join()).toMatch(/bogus/);
    expect(issues(ServiceConfigSchema.safeParse({ ...base, extra_top: 1 })).join()).toMatch(/extra_top/);
  });

  it("validates function and workflow names", () => {
    const res = ServiceConfigSchema.safeParse({ ...base, functions: { "1bad": { handler: "a.b" } } });
    expect(issues(res).join()).toMatch(/functions\.1bad: name '1bad' must start with a letter/);
  });

  it("convenience accessors fall back to provider values", () => {
    const cfg = parseConfig({
      service: "svc",
      provider: { name: "aws", memory: 512, timeout: 10, runtime: "20", architecture: "arm64" },
      functions: { a: { handler: "m.a" }, b: { handler: "m.b", memory: 128, timeout: 3, runtime: "22", architecture: "x86_64" } },
    }) as ServiceConfig;
    const { a, b } = cfg.functions;
    expect([memoryOf(cfg, a), timeoutOf(cfg, a), runtimeOf(cfg, a), architectureOf(cfg, a)]).toEqual([512, 10, "nodejs20", "arm64"]);
    expect([memoryOf(cfg, b), timeoutOf(cfg, b), runtimeOf(cfg, b), architectureOf(cfg, b)]).toEqual([128, 3, "nodejs22", "x86_64"]);
  });
});

describe("routes and hooks", () => {
  it("rejects duplicate routes (trailing slash insensitive)", () => {
    const res = ServiceConfigSchema.safeParse({
      ...base,
      functions: { a: { handler: "m.a", events: [{ http: "GET /x" }] }, b: { handler: "m.b", events: [{ http: "GET /x/" }] } },
    });
    expect(issues(res)).toContain("functions.b: route GET /x is used by both 'a' and 'b'");
  });

  it("allows the same path with different methods", () => {
    const res = ServiceConfigSchema.safeParse({
      ...base,
      functions: { a: { handler: "m.a", events: [{ http: "GET /x" }] }, b: { handler: "m.b", events: [{ http: "POST /x" }] } },
    });
    expect(res.success).toBe(true);
  });

  it("normalizes hooks (snake_case, single string)", () => {
    const cfg = parseConfig({ ...base, hooks: { before_package: "echo a", afterDeploy: ["echo b", "echo c"] } });
    expect(cfg.hooks).toEqual({ beforePackage: ["echo a"], afterDeploy: ["echo b", "echo c"] });
  });

  it("rejects unknown hooks", () => {
    expect(issues(ServiceConfigSchema.safeParse({ ...base, hooks: { whenever: ["ls"] } })).join()).toMatch(
      /unknown hooks whenever; allowed: beforePackage/,
    );
    expect(issues(ServiceConfigSchema.safeParse({ ...base, hooks: { beforeDeploy: 5 } })).join()).toMatch(/beforeDeploy/);
  });
});

describe("workflows", () => {
  const wf = (states: Record<string, unknown>, startAt = "A") => WorkflowConfig.safeParse({ start_at: startAt, states });

  it("parses snake_case keys and applies defaults", () => {
    const res = WorkflowConfig.parse({
      start_at: "A",
      states: {
        A: {
          type: "task",
          function: "f",
          input_path: "$.in",
          result_path: "$.out",
          timeout_seconds: 5,
          retry: [{ max_attempts: 2, interval_seconds: 0.5, backoff_rate: 1.5, max_delay_seconds: 4 }],
          catch: [{ errors: ["Boom"], next: "F", result_path: null }],
          next: "B",
        },
        B: { type: "wait", seconds_path: "$.delay", next: "C" },
        C: {
          type: "map",
          items_path: "$.items",
          max_concurrency: 2,
          iterator: { start_at: "I", states: { I: { type: "pass" } } },
        },
        F: { type: "fail", error: "E", cause: "c" },
      },
    });
    const a = res.states.A;
    expect(a).toMatchObject({ inputPath: "$.in", resultPath: "$.out", timeoutSeconds: 5, end: false, next: "B" });
    expect(a.retry).toEqual([{ errors: ["*"], maxAttempts: 2, intervalSeconds: 0.5, backoffRate: 1.5, maxDelaySeconds: 4 }]);
    expect(a.catch).toEqual([{ errors: ["Boom"], next: "F", resultPath: null }]);
    expect(res.states.B.secondsPath).toBe("$.delay");
    expect(res.states.C).toMatchObject({ itemsPath: "$.items", maxConcurrency: 2, end: true });
    expect(res.states.C.iterator!.states.I.end).toBe(true);
    expect(res.description).toBe("");
    expect(res.engine).toBe("auto");
    expect(res.options).toEqual({});
  });

  it("defaults retry and catch rules", () => {
    const res = WorkflowConfig.parse({
      startAt: "A",
      states: { A: { type: "task", function: "f", retry: [{}], catch: [{ next: "A" }] } },
    });
    expect(res.states.A.retry[0]).toEqual({ errors: ["*"], maxAttempts: 3, intervalSeconds: 1, backoffRate: 2 });
    expect(res.states.A.catch[0]).toEqual({ errors: ["*"], next: "A", resultPath: "$.error" });
    expect(res.states.A.resultPath).toBe("$");
  });

  it("normalizes choice operators recursively", () => {
    const res = WorkflowConfig.parse({
      start_at: "C",
      states: {
        C: {
          type: "choice",
          choices: [
            { variable: "$.a", not_equals: 1, next: "D" },
            { and: [{ variable: "$.b", is_null: true }, { not: { variable: "$.c", is_present: false } }], next: "D" },
            { or: [{ variable: "$.d", isPresent: true }], next: "D" },
          ],
          default: "D",
        },
        D: { type: "succeed" },
      },
    });
    expect(res.states.C.choices).toEqual([
      { variable: "$.a", notEquals: 1, next: "D" },
      { and: [{ variable: "$.b", isNull: true }, { not: { variable: "$.c", isPresent: false } }], next: "D" },
      { or: [{ variable: "$.d", isPresent: true }], next: "D" },
    ]);
  });

  it("marks implicit ends but not for terminal / choice states", () => {
    const res = WorkflowConfig.parse({
      start_at: "A",
      states: { A: { type: "pass", next: "B" }, B: { type: "pass" } },
    });
    expect(res.states.A.end).toBe(false);
    expect(res.states.B.end).toBe(true);
  });

  it.each([
    [{ A: { type: "task" } }, /task state needs `function`/],
    [{ A: { type: "choice" } }, /choice state needs `choices`/],
    [{ A: { type: "wait" } }, /wait state needs `seconds` or `secondsPath`/],
    [{ A: { type: "parallel" } }, /parallel state needs `branches`/],
    [{ A: { type: "map" } }, /map state needs `iterator`/],
    [{ A: { type: "loop" } }, /states\.A\.type/],
    [{ A: { type: "task", function: "f", next: "Z" } }, /states\.A: state 'A' points to unknown state 'Z'/],
    [{ A: { type: "task", function: "f", catch: [{ next: "Z" }] } }, /unknown state 'Z'/],
    [{ A: { type: "choice", choices: [{ variable: "$.x", equals: 1, next: "Z" }] } }, /unknown state 'Z'/],
    [{ A: { type: "choice", choices: [{ variable: "$.x", equals: 1 }], default: "A" } }, /choice rule in 'A' has no `next`/],
    [{ A: { type: "choice", choices: [{ variable: "$.x", equals: 1, next: "A" }], default: "Q" } }, /unknown state 'Q'/],
  ])("rejects invalid state %#", (states, pattern) => {
    expect(issues(wf(states)).join("\n")).toMatch(pattern);
  });

  it("checks startAt", () => {
    expect(issues(wf({ A: { type: "succeed" } }, "Q")).join()).toMatch(/startAt: startAt 'Q' is not a defined state/);
  });

  it("checks nested branch graphs", () => {
    const res = wf({
      A: { type: "parallel", branches: [{ start_at: "X", states: { Y: { type: "succeed" } } }] },
    });
    expect(issues(res).join()).toMatch(/startAt 'X' is not a defined state/);
  });

  it("collects task functions recursively", () => {
    const res = WorkflowConfig.parse({
      start_at: "A",
      states: {
        A: { type: "task", function: "f", next: "P" },
        P: {
          type: "parallel",
          branches: [{ start_at: "B", states: { B: { type: "task", function: "g" } } }],
          next: "M",
        },
        M: { type: "map", iterator: { start_at: "C", states: { C: { type: "task", function: "h" } } } },
      },
    });
    expect(taskFunctions(res)).toEqual(["f", "g", "h"]);
  });

  it("rejects references to unknown functions at the service level", () => {
    const res = ServiceConfigSchema.safeParse({
      ...base,
      functions: { a: { handler: "m.a" } },
      workflows: { w: { start_at: "A", states: { A: { type: "task", function: "zzz" } } } },
    });
    expect(issues(res)).toContain("workflows.w: workflow 'w' references unknown function 'zzz'");
  });

  it("validates engine", () => {
    expect(issues(WorkflowConfig.safeParse({ startAt: "A", engine: "turbo", states: { A: { type: "succeed" } } })).join()).toMatch(/engine/);
  });
});

describe("full config", () => {
  it("parses a realistic config with mixed key styles", () => {
    const cfg = parseConfig({
      service: "orders",
      provider: { name: "aws", log_retention_days: 7, runtime: "22" },
      functions: {
        get: {
          handler: "src/orders.getOrder",
          events: [{ http: "GET /orders/{id}" }, { queue: { name: "q", batch_size: 5 } }, { schedule: "5 minutes" }],
        },
        v: { handler: "src/v.validate" },
      },
      workflows: {
        wf: {
          start_at: "A",
          states: {
            A: { type: "task", function: "v", retry: [{ max_attempts: 2 }], next: "B" },
            B: { type: "choice", choices: [{ variable: "$.x", not_equals: 1, next: "A" }], default: "C" },
            C: { type: "succeed" },
          },
        },
      },
      hooks: { before_deploy: "echo hi" },
    });
    expect(cfg.provider.logRetentionDays).toBe(7);
    expect(cfg.provider.runtime).toBe("nodejs22");
    expect(cfg.functions.get.events[1]).toMatchObject({ type: "queue", config: { batchSize: 5, maxReceive: 5 } });
    expect(cfg.workflows.wf.states.A.retry[0].maxAttempts).toBe(2);
    expect(cfg.workflows.wf.states.B.choices[0]).toHaveProperty("notEquals", 1);
    expect(cfg.hooks.beforeDeploy).toEqual(["echo hi"]);
  });

  it("formats multiple errors with dotted paths", () => {
    expect(() =>
      parseConfig({ service: "x1", provider: { name: "aws" }, functions: { a: { handler: "nope", bogus: 1 } } }, "my.yml"),
    ).toThrow(/^my\.yml is invalid:\n {2}- functions\.a\.handler: handler must be/);
  });
});
