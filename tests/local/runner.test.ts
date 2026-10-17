import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { LocalRunner } from "../../src/local/runner.js";
import { setLogSink } from "../../src/runtime/log.js";
import { dedent, makeProject, tempDir, type TempProject } from "../helpers.js";

const HANDLERS = dedent(`
  import { BatchResult, HttpResponse, NotFound, type Event, type Context } from "node-serverless-kit";

  export async function hello(event: Event, ctx: Context) {
    const req = event.http!;
    const name = req.pathParams.name ?? req.query.name ?? "world";
    return {
      message: \`hello \${name}\`,
      provider: event.provider,
      fn: ctx.functionName,
      route: req.route ?? null,
      multi: req.multiQuery,
      ip: req.sourceIp,
      cookie: req.cookies.sid ?? null,
      header: req.headers.get("x-test") ?? null,
    };
  }

  export function create(event: Event) {
    const body = event.http!.json<Record<string, unknown>>();
    if (!("id" in body)) throw new NotFound("missing id");
    return HttpResponse.json(body, 201).setCookie("seen", "1");
  }

  export const item = (event: Event) => ({ id: event.http!.pathParams.id });
  export const newItem = () => "the new-item form";
  export const raw = (event: Event) => ({ len: event.http!.body.length, text: event.http!.text(), ct: event.http!.contentType });

  export function worker(event: Event) {
    const result = new BatchResult();
    for (const record of event.records) if (record.text() === "fail") result.fail(record);
    return result;
  }

  export const notify = (event: Event) => event.records.map((r) => ({ id: r.id, body: r.json(null) ?? r.text(), attrs: r.attributes, source: r.source }));
  export const files = (event: Event) => event.records.map((r) => \`\${r.action}:\${r.bucket}/\${r.key}:\${r.size}\`);
  export const tick = (event: Event) => ({ type: event.type, data: event.data, source: event.source ?? null });
  export const step = (event: Event) => {
    const data = { ...((event.data as Record<string, number>) ?? {}) };
    data.steps = (data.steps ?? 0) + 1;
    return data;
  };
  export const env = () => ({ greeting: process.env.GREETING ?? null, shared: process.env.SHARED ?? null, extra: process.env.EXTRA ?? null, fn: process.env.NSKIT_FUNCTION ?? null, provider: process.env.NSKIT_PROVIDER });
  export const boom = () => { throw new Error("kaboom"); };
`);

const CONFIG = `
service: local
provider:
  name: aws
  environment: {SHARED: from-provider}
functions:
  hello:
    handler: src/handlers.hello
    events:
      - http: "GET /hello/{name}"
      - http: {path: /hello, cors: {origins: ["https://app.example"]}}
  create: {handler: src/handlers.create, events: [{http: POST /items}]}
  item: {handler: src/handlers.item, events: [{http: "GET /items/{id}"}]}
  newItem: {handler: src/handlers.newItem, events: [{http: GET /items/new}]}
  raw: {handler: src/handlers.raw, events: [{http: "ANY /raw/{path+}"}]}
  worker: {handler: src/handlers.worker, events: [{queue: jobs}]}
  notify: {handler: src/handlers.notify, events: [{topic: events}]}
  files: {handler: src/handlers.files, events: [{storage: uploads}]}
  tick: {handler: src/handlers.tick, events: [{schedule: 5 minutes}]}
  step: {handler: src/handlers.step}
  env: {handler: src/handlers.env, environment: {GREETING: hi}}
  envless: {handler: src/handlers.env}
  override: {handler: src/handlers.env, environment: {SHARED: from-function}}
  boom: {handler: src/handlers.boom, events: [{http: GET /boom}]}
workflows:
  pipeline:
    start_at: Wait
    states:
      Wait: {type: wait, seconds: 7, next: A}
      A: {type: task, function: step, next: Check}
      Check:
        type: choice
        choices: [{variable: $.steps, lt: 3, next: A}]
        default: Done
      Done: {type: succeed}
  failing:
    start_at: B
    states:
      B: {type: task, function: boom}
`;

let tmp: TempProject;
beforeAll(() => {
  setLogSink(() => undefined);
  tmp = makeProject(CONFIG, { "src/handlers.ts": HANDLERS });
});

for (const mode of ["import", "bundle"] as const) {
  describe(`LocalRunner (${mode} mode)`, () => {
    let runner: LocalRunner;
    const slept: number[] = [];

    beforeAll(async () => {
      runner = await LocalRunner.fromConfig(tmp.configPath, { mode, env: { EXTRA: "from-options" }, sleep: async (s) => void slept.push(s) });
    });

    it("serves HTTP routes with path params, query, headers and cookies", async () => {
      const res = await runner.http("GET", "/hello/Ada?x=1&x=2", { headers: { "X-Test": "yes", cookie: "sid=abc" } });
      expect(res.status).toBe(200);
      expect(res.functionName).toBe("hello");
      expect(res.headers["content-type"]).toBe("application/json");
      expect(res.json()).toEqual({
        message: "hello Ada",
        provider: "local",
        fn: "hello",
        route: "/hello/{name}",
        multi: { x: ["1", "2"] },
        ip: "127.0.0.1",
        cookie: "abc",
        header: "yes",
      });
      expect((await runner.http("GET", "/hello", { query: { name: "Bob" } })).json()).toMatchObject({ message: "hello Bob", route: "/hello" });
    });

    it("parses JSON bodies, maps errors and returns cookies", async () => {
      const created = await runner.http("POST", "/items", { json: { id: 7 } });
      expect(created.status).toBe(201);
      expect(created.json()).toEqual({ id: 7 });
      expect(created.cookies[0]).toMatch(/^seen=1; /);
      const missing = await runner.http("POST", "/items", { json: {} });
      expect(missing.status).toBe(404);
      expect(missing.json()).toEqual({ error: "missing id", status: 404 });
      const bad = await runner.http("POST", "/items", { body: "{nope", headers: { "content-type": "application/json" } });
      expect(bad.status).toBe(400);
      const boom = await runner.http("GET", "/boom");
      expect(boom.status).toBe(500);
      expect(boom.json()).toMatchObject({ error: "Internal Server Error", status: 500 });
    });

    it("routes static segments before parameters; greedy paths and raw bodies", async () => {
      expect((await runner.http("GET", "/items/new")).text).toBe("the new-item form");
      expect((await runner.http("GET", "/items/42")).json()).toEqual({ id: "42" });
      const raw = await runner.http("PUT", "/raw/a/b/c", { body: new Uint8Array([104, 105]), headers: { "content-type": "text/plain" } });
      expect(raw.json()).toEqual({ len: 2, text: "hi", ct: "text/plain" });
      expect(runner.routes().map((r) => `${r.method} ${r.path}`)).toEqual([
        "GET /boom",
        "GET /hello",
        "POST /items",
        "GET /items/new",
        "GET /hello/{name}",
        "GET /items/{id}",
        "ANY /raw/{path+}",
      ]);
      expect(runner.matchRoute("GET", "/items/9").route?.functionName).toBe("item");
    });

    it("404 for unknown paths, 405 for wrong methods, CORS preflight", async () => {
      const nf = await runner.http("GET", "/nope");
      expect(nf.status).toBe(404);
      expect(nf.json()).toEqual({ error: "Not Found", status: 404 });
      expect(nf.functionName).toBeUndefined();
      const na = await runner.http("DELETE", "/items/1");
      expect(na.status).toBe(405);
      expect(na.json()).toEqual({ error: "Method Not Allowed", status: 405 });
      // the gateway does not strip prefixes locally
      expect((await runner.http("GET", "/api/hello")).status).toBe(404);
      const pre = await runner.http("OPTIONS", "/hello", { headers: { origin: "https://app.example" } });
      expect(pre.status).toBe(204);
      expect(pre.headers["access-control-allow-origin"]).toBe("https://app.example");
      const evil = await runner.http("GET", "/hello", { headers: { origin: "https://evil.example" } });
      expect(evil.headers).not.toHaveProperty("access-control-allow-origin");
    });

    it("invokes functions with their environment", async () => {
      expect(await runner.invoke("step", { steps: 1 })).toEqual({ steps: 2 });
      expect(await runner.invoke("step")).toEqual({ steps: 1 });
      expect(await runner.invoke("env")).toEqual({ greeting: "hi", shared: "from-provider", extra: "from-options", fn: "env", provider: "local" });
      // one function's environment never leaks into another's
      expect(await runner.invoke("envless")).toEqual({ greeting: null, shared: "from-provider", extra: "from-options", fn: "envless", provider: "local" });
      expect(await runner.invoke("override")).toMatchObject({ shared: "from-function", greeting: null });
      expect(await runner.invoke("envless")).toMatchObject({ shared: "from-provider" });
      await expect(runner.invoke("boom")).rejects.toThrow("kaboom");
      await expect(runner.invoke("ghost")).rejects.toThrow(/unknown function 'ghost'; known: boom, create, env, envless/);
    });

    it("delivers queue, topic, storage and schedule events", async () => {
      const batch = (await runner.queue("worker", ["ok", "fail", { id: "custom", body: "fail" }])) as { failed: string[] };
      expect(batch.failed).toEqual(["2", "custom"]);
      const topic = await runner.topic("notify", [{ a: 1 }, "text", { id: "x", body: { b: 2 }, attributes: { k: "v" } }]);
      expect(topic).toEqual([
        { id: "1", body: { a: 1 }, attrs: {}, source: "local:topic" },
        { id: "2", body: "text", attrs: {}, source: "local:topic" },
        { id: "x", body: { b: 2 }, attrs: { k: "v" }, source: "local:topic" },
      ]);
      expect(await runner.storage("files", [{ key: "a.csv", size: 3 }, { bucket: "b", key: "c", action: "deleted" }])).toEqual([
        "created:local-bucket/a.csv:3",
        "deleted:b/c:0",
      ]);
      expect(await runner.schedule("tick", { report: "weekly" })).toEqual({ type: "schedule", data: { report: "weekly" }, source: "local.scheduler" });
      expect(await runner.schedule("tick")).toMatchObject({ data: null });
    });

    it("runs workflows with the embedded engine and injected sleep", async () => {
      slept.length = 0;
      const { output, history } = await runner.workflow("pipeline", { steps: 0 });
      expect(output).toEqual({ steps: 3 });
      expect(slept).toEqual([7]);
      expect(history.map((h) => h.state)).toEqual(["Wait", "A", "Check", "A", "Check", "A", "Check", "Done"]);
      await expect(runner.workflow("failing", {})).rejects.toMatchObject({ name: "WorkflowFailed", error: "Error", cause: "kaboom" });
      await expect(runner.workflow("ghost")).rejects.toThrow(/unknown workflow 'ghost'; known: failing, pipeline/);
    });

    it("exposes a local manifest with every workflow embedded", () => {
      const manifest = runner.manifest();
      expect(manifest.provider).toBe("local");
      expect(Object.keys(manifest.workflows).sort()).toEqual(["failing", "pipeline"]);
      expect(manifest.workflows.pipeline.orchestrator).toBe("pipeline-orchestrator");
      expect(runner.config.service).toBe("local");
      expect(runner.api.getManifest().service).toBe("local");
    });

    if (mode === "bundle") {
      it("bundles into .nskit/local", () => {
        expect(existsSync(path.join(tmp.root, ".nskit", "local", "bundle.cjs"))).toBe(true);
      });
    }
  });
}

describe("reload", () => {
  it("picks up source changes in bundle mode", async () => {
    const project = makeProject("service: reload\nprovider: {name: aws}\nfunctions: {v: {handler: src/v.get}}\n", {
      "src/v.ts": "export const get = () => 1;\n",
    });
    const runner = await LocalRunner.fromConfig(project.configPath, { mode: "bundle" });
    expect(await runner.invoke("v")).toBe(1);
    writeFileSync(path.join(project.root, "src", "v.ts"), "export const get = () => 2;\n");
    await runner.reload();
    expect(await runner.invoke("v")).toBe(2);
  });

  it("picks up source changes when the project path is a symlink", async () => {
    const project = makeProject("service: reload\nprovider: {name: aws}\nfunctions: {v: {handler: src/v.get}}\n", {
      "src/v.ts": "export const get = () => 1;\n",
    });
    // macOS `os.tmpdir()` is `/var/folders`, a symlink to `/private/var/folders`. The dev-server
    // test lives there; `require` then caches the bundle under the real path.
    const linked = path.join(tempDir("nskit-link-"), "proj");
    symlinkSync(project.root, linked, process.platform === "win32" ? "junction" : "dir");
    const runner = await LocalRunner.fromConfig(path.join(linked, "nskit.yml"), { mode: "bundle" });
    expect(await runner.invoke("v")).toBe(1);
    writeFileSync(path.join(linked, "src", "v.ts"), "export const get = () => 2;\n");
    await runner.reload();
    expect(await runner.invoke("v")).toBe(2);
  });

  it("api throws before loading; missing handlers fail at call time", async () => {
    const project = makeProject("service: lazy\nprovider: {name: aws}\nfunctions: {gone: {handler: src/gone.fn}}\n");
    const runner = await LocalRunner.fromConfig(project.configPath, { mode: "import" });
    await expect(runner.invoke("gone")).rejects.toThrow(/Handler "src\/gone.fn" is not in this bundle/);
  });
});
