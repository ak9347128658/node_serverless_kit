import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ScheduleEvent } from "../../src/config/schema";
import { Deployer } from "../../src/core/deployer";
import { Project } from "../../src/core/project";
import { AlibabaProvider, timerExpression } from "../../src/providers/alibaba";
import { namedCron5 } from "../../src/providers/schedule";

const HANDLERS = `
export async function hello(event) {
  const name = event.http.pathParams.name ?? event.http.query.name ?? "world";
  return { message: "hello " + name, provider: event.provider };
}
export async function tick(event) { return { type: event.type, data: event.data }; }
export async function worker(event) { return event.records.length; }
export async function step(event) { return { ...(event.data ?? {}), steps: ((event.data ?? {}).steps ?? 0) + 1 }; }
`;

const FULL = `
service: demo
provider:
  name: alibaba
functions:
  worker:
    handler: src/handlers.worker
    events:
      - queue: {name: jobs}
`;

const CONFIG = `
service: demo
provider:
  name: alibaba
  region: cn-shanghai
functions:
  hello:
    handler: src/handlers.hello
    memory: 512
    events:
      - http: GET /hello/{name}
      - http: {path: /hello, method: POST, cors: true}
  tick:
    handler: src/handlers.tick
    events:
      - schedule: 5 minutes
      - schedule: {cron: "0 12 * * 1-5", input: {report: weekly}}
  worker:
    handler: src/handlers.worker
    events:
      - storage: {bucket: demo-uploads-1234, suffix: .csv, events: [created, deleted]}
      - topic: events
  step:
    handler: src/handlers.step
workflows:
  pipeline:
    startAt: First
    states:
      First: {type: task, function: step, end: true}
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeProject(yaml: string): Project {
  const root = mkdtempSync(path.join(os.tmpdir(), "nskit-alibaba-"));
  dirs.push(root);
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "handlers.ts"), HANDLERS);
  writeFileSync(path.join(root, "nskit.yml"), yaml);
  return Project.load(path.join(root, "nskit.yml"));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function render(project: Project): Promise<any> {
  const res = await new Deployer(project, () => undefined).package({ skipInstall: true });
  return JSON.parse(readFileSync(res.tfFile, "utf-8"));
}

describe("AlibabaProvider", () => {
  test("queue events are rejected", () => {
    const errors = makeProject(FULL).validate().filter((i) => i.level === "error");
    expect(errors.some((e) => String(e).includes("does not support `queue`"))).toBe(true);
  });

  test("renders functions and triggers", async () => {
    const doc = await render(makeProject(CONFIG));
    expect(doc.provider.alicloud[0].region).toBe("cn-shanghai");
    expect(doc.terraform.required_providers.alicloud.source).toBe("aliyun/alicloud");

    const fns = doc.resource.alicloud_fcv3_function;
    expect(Object.keys(fns).sort()).toEqual(["hello", "pipeline_orchestrator", "step", "tick", "worker"]);
    const hello = fns.hello;
    expect(hello.function_name).toBe("demo-dev-hello");
    expect(hello.handler).toBe("index.handler");
    expect(hello.runtime).toBe("nodejs20");
    expect(hello.memory_size).toBe(512);
    expect(hello.code.zip_file).toContain("filebase64");
    expect(hello.environment_variables.NSKIT_FUNCTION).toBe("hello");
    expect(hello.environment_variables.NSKIT_PROVIDER).toBe("alibaba");
    expect(fns.pipeline_orchestrator.environment_variables.NSKIT_HANDLER).toBeTruthy();

    const triggers = doc.resource.alicloud_fcv3_trigger;
    const http = JSON.parse(triggers.hello_http.trigger_config);
    expect(http.authType).toBe("anonymous");
    expect(http.methods).toEqual(["GET", "POST", "OPTIONS"]);
    expect(JSON.parse(triggers.tick_timer_0.trigger_config).cronExpression).toBe("@every 5m");
    const cron = JSON.parse(triggers.tick_timer_1.trigger_config);
    expect(cron.cronExpression).toBe("0 0 12 * * MON-FRI");
    expect(JSON.parse(cron.payload)).toEqual({ __nskit: "schedule", data: { report: "weekly" }, source: "alibaba.timer" });

    const oss = triggers.worker_oss_demo_uploads_1234;
    expect(oss.trigger_type).toBe("oss");
    expect(oss.source_arn).toBe("acs:oss:cn-shanghai:${data.alicloud_account.current.id}:demo-uploads-1234");
    expect(oss.invocation_role).toBe("${alicloud_ram_role.triggers.arn}");
    expect(JSON.parse(oss.trigger_config).events).toEqual(["oss:ObjectCreated:*", "oss:ObjectRemoved:*"]);
    expect(triggers.worker_mns_events.trigger_type).toBe("mns_topic");
    expect(doc.resource.alicloud_oss_bucket).toBeDefined();
    expect(doc.resource.alicloud_message_service_topic).toBeDefined();
  });

  test("nskit output", async () => {
    const out = (await render(makeProject(CONFIG))).output.nskit.value;
    const hello = out.functions.hello;
    expect(hello.url).toBe("${alicloud_fcv3_trigger.hello_http.http_trigger[0].url_internet}");
    expect(hello.base_url).toBe(hello.url);
    expect(out.endpoint).toBe(hello.url);
    expect(out.workflows.pipeline.id).toBe("${alicloud_fcv3_function.pipeline_orchestrator.function_name}");
    expect(out.functions.tick.url).toBeUndefined();
  });

  test("bundle exports index.handler and round-trips a native HTTP event", async () => {
    const project = makeProject(CONFIG);
    const res = await new Deployer(project, () => undefined).package({ skipInstall: true });
    const file = path.join(res.artifact.buildDir, "index.js");
    const mod = createRequire(import.meta.url)(file);
    expect(typeof mod.handler).toBe("function");
    process.env.NSKIT_FUNCTION = "hello";
    try {
      const evt = {
        version: "v1",
        rawPath: "/hello/Ada",
        body: "",
        isBase64Encoded: false,
        headers: { Accept: "*/*", "User-Agent": "curl/8.7.1" },
        queryParameters: {},
        requestContext: {
          accountId: "123",
          domainName: "demo.cn-shanghai.fcapp.run",
          domainPrefix: "demo",
          http: { method: "GET", path: "/hello/Ada", protocol: "HTTP/1.1", sourceIp: "1.2.3.4", userAgent: "curl/8.7.1" },
          requestId: "1-abc",
          time: "2026-10-15T08:00:00Z",
          timeEpoch: "1760515200000",
        },
      };
      // FC passes the event as a Buffer.
      const out = await mod.handler(Buffer.from(JSON.stringify(evt)), {
        requestId: "1-abc",
        region: "cn-shanghai",
        function: { name: "demo-dev-hello", memory: 512, timeout: 30 },
      });
      expect(out.statusCode).toBe(200);
      expect(JSON.parse(out.body)).toEqual({ message: "hello Ada", provider: "alibaba" });
      const timer = await (async () => {
        process.env.NSKIT_FUNCTION = "tick";
        const timerEvent = { triggerTime: "2026-10-15T08:00:00Z", triggerName: "timer-0", payload: '{"__nskit":"schedule","data":7}' };
        return mod.handler(Buffer.from(JSON.stringify(timerEvent)), {});
      })();
      expect(timer).toEqual({ type: "schedule", data: 7 });
    } finally {
      delete process.env.NSKIT_FUNCTION;
    }
  });

  test("no role or account data source when unneeded", async () => {
    const doc = await render(
      makeProject(`
service: demo
provider: {name: alibaba}
functions:
  api:
    handler: src/handlers.hello
    events: [{http: GET /}]
`),
    );
    expect(doc.resource.alicloud_ram_role).toBeUndefined();
    expect(doc.data).toBeUndefined();
  });

  test("unsupported auth and iam warning", () => {
    const issues = makeProject(`
service: demo
provider:
  name: alibaba
  iam: {statements: [{actions: ["oss:GetObject"]}]}
functions:
  api:
    handler: src/handlers.hello
    events: [{http: {path: /, auth: jwt}}]
`).validate();
    expect(issues.some((i) => i.level === "error" && i.message.includes("auth `jwt`"))).toBe(true);
    expect(issues.some((i) => i.level === "warning" && i.message.includes("RAM"))).toBe(true);
  });

  test("schedule helpers, names and runtimes", () => {
    expect(namedCron5(ScheduleEvent.parse({ cron: "0 1 * * 0,6" }))).toBe("0 1 * * SUN,SAT");
    expect(timerExpression(ScheduleEvent.parse({ cron: "0 8 * * *", timezone: "Asia/Shanghai" }))).toBe(
      "CRON_TZ=Asia/Shanghai 0 0 8 * * *",
    );
    expect(timerExpression(ScheduleEvent.parse({ rate: "1 hour" }))).toBe("@every 1h");
    const provider = new AlibabaProvider();
    expect(provider.physicalName("demo", "dev", "Hello.World")).toBe("demo-dev-hello-world");
    expect(provider.runtimeId("nodejs18")).toBe("nodejs18");
    expect(provider.defaultRuntime).toBe("nodejs20");
    expect(() => provider.runtimeId("nodejs22")).toThrow(/does not support/);
  });
});
