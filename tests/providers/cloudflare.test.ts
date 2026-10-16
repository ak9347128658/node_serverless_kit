import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Project } from "../../src/core/project";
import { Deployer } from "../../src/core/deployer";
import { CloudflareProvider } from "../../src/providers/cloudflare";
import { type Json } from "../../src/providers/terraform-doc";

const CONFIG = `
service: demo
provider:
  name: cloudflare
  options: {account_id: acc1, workers_subdomain: myco, zone_id: zone1}
  environment: {GREETING: hello}
functions:
  hello:
    handler: src/handlers.hello
    events:
      - http: "GET /hello/{name}"
      - http: "POST /echo"
    options: {route: "api.example.com/hello*"}
  tick:
    handler: src/handlers.tick
    events:
      - schedule: 5 minutes
      - schedule: {cron: "0 12 * * 1", input: {report: weekly}}
      - schedule: {cron: "0 0 1 * *", enabled: false}
  orders:
    handler: src/handlers.orders
    events:
      - queue: {name: orders, batchSize: 50, batchWindow: 5, deadLetter: orders-dlq, maxReceive: 4}
  legacy:
    handler: src/handlers.orders
    events:
      - queue: {name: old-queue, existing: true}
  double:
    handler: src/handlers.double
  caller:
    handler: src/handlers.double
    options: {invokes: [double]}
workflows:
  pipeline:
    startAt: Double
    states:
      Double: {type: task, function: double, end: true}
`;

const HANDLERS = `
import { createHash } from "node:crypto";
import { BatchResult, HttpResponse, defineHandler, getEnv } from "node-serverless-kit";

export const hello = defineHandler(async (event, ctx) => {
  if (event.http?.method === "POST") return { echoed: event.http.json(), path: event.http.path };
  const name = event.http?.pathParams.name ?? "world";
  ctx.waitUntil(Promise.resolve("bg"));
  const resp = HttpResponse.json({
    message: getEnv("GREETING") + " " + name,
    fn: ctx.functionName,
    provider: event.provider,
    hash: createHash("sha256").update(name).digest("hex").slice(0, 8),
  });
  resp.setCookie("seen", "1");
  return resp;
});

export const tick = defineHandler(async (event) => {
  (globalThis as any).__tick = { type: event.type, data: event.data, source: event.source };
  return { type: event.type, data: event.data };
});

export const orders = defineHandler(async (event) =>
  BatchResult.of(event.records.filter((r) => (r.json() as { bad?: boolean }).bad)),
);

export const double = defineHandler(async (event) => ({ value: (event.data as { value: number }).value * 2 }));
`;

let root: string;
let project: Project;
let tf: Json;
let workerFile: string;

function writeProject(dir: string, config: string): void {
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "nskit.yml"), config);
  writeFileSync(path.join(dir, "src", "handlers.ts"), HANDLERS);
}

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "nskit-cf-"));
  writeProject(root, CONFIG);
  project = Project.load(path.join(root, "nskit.yml"));
  const res = await new Deployer(project, () => undefined).package();
  tf = JSON.parse(readFileSync(res.tfFile, "utf-8"));
  workerFile = path.join(res.artifact.buildDir, res.artifact.entryFile);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function errors(config: string): string[] {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nskit-cf-v-"));
  try {
    writeProject(dir, config);
    return Project.load(path.join(dir, "nskit.yml"))
      .validate()
      .map(String);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("validation", () => {
  test("requires account_id and rejects unsupported events / auth", () => {
    const issues = errors(`
service: vv
provider: {name: cloudflare}
functions:
  a:
    handler: src/handlers.hello
    events:
      - http: {path: /a, auth: jwt}
      - storage: uploads
      - topic: news
      - queue: {name: q, fifo: true, batchSize: 500}
      - schedule: {cron: "0 9 * * *", timezone: Europe/Berlin}
    options: {route: "x.example.com/*"}
`).join("\n");
    expect(issues).toContain("options.account_id is required");
    expect(issues).toContain("`storage` events");
    expect(issues).toContain("`topic` events");
    expect(issues).toContain("auth `jwt` is not supported");
    expect(issues).toContain("no FIFO queues");
    expect(issues).toContain("exceeds the Cloudflare Queues max of 100");
    expect(issues).toContain("Cron Triggers always run in UTC");
    expect(issues).toContain("options.route needs provider.options.zone_id");
  });

  test("invokes must reference known functions without cycles", () => {
    const issues = errors(`
service: vv
provider: {name: cloudflare, options: {account_id: a}}
functions:
  a: {handler: src/handlers.hello, options: {invokes: [b, ghost]}}
  b: {handler: src/handlers.hello, options: {invokes: [a]}}
`).join("\n");
    expect(issues).toContain("unknown function 'ghost'");
    expect(issues).toContain("forms a cycle (a -> b -> a)");
  });

  test("the sample config is clean", () => {
    expect(project.validate().filter((i) => i.level === "error")).toEqual([]);
  });

  test("bundle target follows nodejs_compat", () => {
    const p = new CloudflareProvider();
    expect(p.bundleTarget(project.config).external).toContain("node:*");
    const noCompat = { ...project.config, provider: { ...project.config.provider, options: { compatibility_flags: [] } } };
    expect(p.bundleTarget(noCompat).external).toEqual([]);
  });
});

describe("terraform", () => {
  test("provider and scripts", () => {
    expect(tf.terraform.required_providers.cloudflare.source).toBe("cloudflare/cloudflare");
    const scripts = tf.resource.cloudflare_workers_script;
    expect(Object.keys(scripts).sort()).toEqual(["caller", "double", "hello", "legacy", "orders", "pipeline_orchestrator", "tick"].sort());
    const hello = scripts.hello;
    expect(hello.script_name).toBe("demo-dev-hello");
    expect(hello.main_module).toBe("worker.mjs");
    expect(hello.content_file).toBe("${path.module}/build/worker.mjs");
    expect(hello.content_sha256).toBe('${filesha256("${path.module}/build/worker.mjs")}');
    expect(hello.compatibility_flags).toEqual(["nodejs_compat"]);
    expect(hello.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(hello).not.toHaveProperty("route");
    const env = Object.fromEntries(hello.bindings.map((b: Json) => [b.name, b]));
    expect(env.NSKIT_FUNCTION).toEqual({ name: "NSKIT_FUNCTION", type: "plain_text", text: "hello" });
    expect(env.GREETING.text).toBe("hello");
    expect(env).not.toHaveProperty("NSKIT_REGION"); // empty values are skipped
  });

  test("http, routes and workers.dev", () => {
    const sub = tf.resource.cloudflare_workers_script_subdomain;
    expect(sub.hello.enabled).toBe(true);
    expect(sub.tick.enabled).toBe(false);
    expect(sub.pipeline_orchestrator.enabled).toBe(true);
    expect(tf.resource.cloudflare_workers_route.hello).toEqual({
      zone_id: "zone1",
      pattern: "api.example.com/hello*",
      script: "${cloudflare_workers_script.hello.script_name}",
    });
  });

  test("cron triggers use named weekdays and skip disabled schedules", () => {
    const crons = tf.resource.cloudflare_workers_cron_trigger.tick.schedules.map((s: Json) => s.cron);
    expect(crons).toEqual(["*/5 * * * *", "0 12 * * MON"]);
  });

  test("queues", () => {
    const q = tf.resource.cloudflare_queue;
    expect(q.q_orders.queue_name).toBe("orders");
    expect(q.q_orders_dlq.queue_name).toBe("orders-dlq");
    const consumer = tf.resource.cloudflare_queue_consumer["orders-orders".replace(/-/g, "_")];
    expect(consumer).toMatchObject({
      queue_id: "${cloudflare_queue.q_orders.queue_id}",
      script_name: "${cloudflare_workers_script.orders.script_name}",
      type: "worker",
      settings: { batch_size: 50, max_retries: 3, max_wait_time_ms: 5000 },
      dead_letter_queue: "${cloudflare_queue.q_orders_dlq.queue_name}",
    });
    const legacy = tf.resource.cloudflare_queue_consumer.legacy_old_queue;
    expect(legacy.queue_id).toBe('${one([for q in data.cloudflare_queues.all.result : q.queue_id if q.queue_name == "old-queue"])}');
    expect(tf.data.cloudflare_queues.all.account_id).toBe("acc1");
  });

  test("options.invokes -> service bindings", () => {
    const caller = tf.resource.cloudflare_workers_script.caller;
    expect(caller).not.toHaveProperty("invokes");
    const svc = caller.bindings.filter((b: Json) => b.type === "service");
    expect(svc).toEqual([{ name: "NSKIT_BINDING_DOUBLE", type: "service", service: "${cloudflare_workers_script.double.script_name}" }]);
    expect(tf.resource.cloudflare_workers_script.pipeline_orchestrator.bindings.some((b: Json) => b.type === "service")).toBe(false);
  });

  test("nskit output", () => {
    const out = tf.output.nskit.value;
    expect(out.functions.hello.url).toBe("https://demo-dev-hello.myco.workers.dev");
    expect(out.functions.hello.id).toBe("${cloudflare_workers_script.hello.script_name}");
    expect(out.functions.tick.url).toBeUndefined();
    expect(out.workflows.pipeline.url).toBe("https://demo-dev-pipeline-orchestrator.myco.workers.dev");
    expect(out.endpoint).toBe("https://demo-dev-hello.myco.workers.dev");
  });
});

describe("built worker module", () => {
  const ctx = () => {
    const waited: Promise<unknown>[] = [];
    return { waited, waitUntil: (p: Promise<unknown>) => waited.push(p), passThroughOnException: () => undefined };
  };

  test("fetch: HTTP request", async () => {
    const mod = await import(pathToFileURL(workerFile).href);
    const c = ctx();
    const resp: Response = await mod.default.fetch(
      new Request("https://demo-dev-hello.myco.workers.dev/hello/ada", { headers: { "cf-ray": "ray-1" } }),
      { NSKIT_FUNCTION: "hello", GREETING: "hi", SOME_KV: { get() {} } },
      c,
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toMatchObject({ message: "hi ada", fn: "hello", provider: "cloudflare" });
    expect(body.hash).toHaveLength(8);
    expect(resp.headers.get("set-cookie")).toContain("seen=1");
    expect(c.waited).toHaveLength(1);

    const posted: Response = await mod.default.fetch(
      new Request("https://x/echo", { method: "POST", body: JSON.stringify({ a: 1 }), headers: { "content-type": "application/json" } }),
      { NSKIT_FUNCTION: "hello" },
      ctx(),
    );
    expect(await posted.json()).toEqual({ echoed: { a: 1 }, path: "/echo" });

    const notAllowed: Response = await mod.default.fetch(new Request("https://x/hello/ada", { method: "DELETE" }), { NSKIT_FUNCTION: "hello" }, ctx());
    expect(notAllowed.status).toBe(405);
  });

  test("fetch: __nskit envelope (invoke / workflow task)", async () => {
    const mod = await import(pathToFileURL(workerFile).href);
    const resp: Response = await mod.default.fetch(
      new Request("https://x/", { method: "POST", body: JSON.stringify({ __nskit: "invoke", data: { value: 21 } }) }),
      { NSKIT_FUNCTION: "double" },
      ctx(),
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ value: 42 });
  });

  test("scheduled: input found by cron", async () => {
    const mod = await import(pathToFileURL(workerFile).href);
    await mod.default.scheduled({ cron: "0 12 * * MON", scheduledTime: 1_700_000_000_000 }, { NSKIT_FUNCTION: "tick" }, ctx());
    const tick = (): { type: string; data: unknown; source: string } =>
      (globalThis as { __tick: { type: string; data: unknown; source: string } }).__tick;
    expect(tick()).toEqual({ type: "schedule", data: { report: "weekly" }, source: "0 12 * * MON" });
    await mod.default.scheduled({ cron: "*/5 * * * *", scheduledTime: 0 }, { NSKIT_FUNCTION: "tick" }, ctx());
    expect(tick().data).toBeNull();
  });

  test("queue: failed messages are retried, the rest acked", async () => {
    const mod = await import(pathToFileURL(workerFile).href);
    const calls: string[] = [];
    const msg = (id: string, body: unknown) => ({
      id,
      body,
      timestamp: new Date(0),
      attempts: 1,
      ack: () => calls.push(`ack:${id}`),
      retry: () => calls.push(`retry:${id}`),
    });
    await mod.default.queue({ queue: "orders", messages: [msg("m1", { ok: 1 }), msg("m2", { bad: true })] }, { NSKIT_FUNCTION: "orders" }, ctx());
    expect(calls.sort()).toEqual(["ack:m1", "retry:m2"]);
  });

  test("workflow orchestrator runs over HTTP", async () => {
    const mod = await import(pathToFileURL(workerFile).href);
    const resp: Response = await mod.default.fetch(
      new Request("https://x/workflows/pipeline", { method: "POST", body: JSON.stringify({ value: 5 }) }),
      { NSKIT_FUNCTION: "pipeline-orchestrator" },
      ctx(),
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({ workflow: "pipeline", status: "SUCCEEDED", output: { value: 10 } });
  });

  test("invokeViaBinding reaches another Worker of the bundle", async () => {
    const mod = await import(pathToFileURL(workerFile).href);
    // The binding is the `double` Worker: same bundle, NSKIT_FUNCTION=double.
    const double = { fetch: (input: string, init: RequestInit) => mod.default.fetch(new Request(input, init), { NSKIT_FUNCTION: "double" }, ctx()) };
    const { invokeViaBinding, installEnv } = await import("../../src/runtime/adapters/cloudflare");
    installEnv({ NSKIT_FUNCTION: "caller", NSKIT_BINDING_DOUBLE: double });
    expect(await invokeViaBinding("double", { value: 4 })).toEqual({ result: { value: 8 } });
    expect(await invokeViaBinding("missing", {})).toBeUndefined();
  });
});
