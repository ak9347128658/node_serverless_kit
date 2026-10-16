import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ScheduleEvent } from "../../src/config/schema";
import { Deployer } from "../../src/core/deployer";
import { Project } from "../../src/core/project";
import { HuaweiProvider, quartzCron, rateExpression } from "../../src/providers/huawei";

const HANDLERS = `
export async function hello(event) {
  const name = event.http.pathParams.name ?? event.http.query.name ?? "world";
  return { message: "hello " + name, provider: event.provider };
}
export async function tick(event) { return { type: event.type, data: event.data }; }
export async function worker(event) { return event.records.length; }
export async function step(event) { return event.data; }
`;

const FULL = `
service: demo
provider:
  name: huawei
functions:
  api:
    handler: src/handlers.hello
    events:
      - http: GET /hello
  worker:
    handler: src/handlers.worker
    events:
      - queue: {name: jobs}
`;

const CONFIG = `
service: demo
provider:
  name: huawei
  options: {apig_instance_id: inst-123}
functions:
  hello:
    handler: src/handlers.hello
    events:
      - http: GET /hello/{name}
      - http: {path: "/files/{path+}", method: ANY, auth: iam}
  tick:
    handler: src/handlers.tick
    events:
      - schedule: 2 hours
      - schedule: {cron: "30 6 * * 1", input: {report: weekly}, enabled: false}
  worker:
    handler: src/handlers.worker
    events:
      - storage: {bucket: uploads, suffix: .csv}
      - topic: {name: events, existing: true}
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
  const root = mkdtempSync(path.join(os.tmpdir(), "nskit-huawei-"));
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

describe("HuaweiProvider", () => {
  test("HTTP needs an APIG instance; queues are rejected", () => {
    const issues = makeProject(FULL).validate().filter((i) => i.level === "error").map(String).join("\n");
    expect(issues).toContain("apig_instance_id");
    expect(issues).toContain("`queue`");
  });

  test("renders the function", async () => {
    const doc = await render(makeProject(CONFIG));
    const fn = doc.resource.huaweicloud_fgs_function.hello;
    expect(fn.name).toBe("demo-dev-hello");
    expect(fn.handler).toBe("index.handler");
    expect(fn.runtime).toBe("Node.js20.15");
    expect(fn.code_type).toBe("zip");
    expect(fn.func_code).toContain("filebase64");
    const env = JSON.parse(fn.user_data);
    expect(env.NSKIT_FUNCTION).toBe("hello");
    expect(env.NSKIT_PROVIDER).toBe("huawei");
    expect(Object.keys(env)).toEqual(Object.keys(env).sort());
    expect(doc.provider.huaweicloud[0].region).toBe("cn-north-4");
  });

  test("dedicated API Gateway", async () => {
    const doc = await render(makeProject(CONFIG));
    const res = doc.resource;
    expect(res.huaweicloud_apig_group.http.instance_id).toBe("inst-123");
    const apis = res.huaweicloud_apig_api;
    expect(apis.hello_0.request_path).toBe("/hello/{name}");
    expect(apis.hello_0.matching).toBe("Exact");
    expect(apis.hello_0.request_params[0].location).toBe("PATH");
    expect(apis.hello_0.func_graph.function_urn).toBe("${huaweicloud_fgs_function.hello.urn}");
    expect(apis.hello_1.request_path).toBe("/files");
    expect(apis.hello_1.matching).toBe("Prefix");
    expect(apis.hello_1.security_authentication).toBe("IAM");
    expect(Object.keys(res.huaweicloud_apig_api_publishment).sort()).toEqual(["hello_0", "hello_1", "pipeline_orchestrator_0"]);
    const out = doc.output.nskit.value;
    expect(out.endpoint).toBe("https://${data.huaweicloud_apig_groups.http.groups[0].sl_domain}");
    expect(out.functions.hello.arn).toBe("${huaweicloud_fgs_function.hello.urn}");
    expect(out.workflows.pipeline.id).toBe("${huaweicloud_fgs_function.pipeline_orchestrator.name}");
  });

  test("timer, OBS and SMN triggers", async () => {
    const doc = await render(makeProject(CONFIG));
    const trig = doc.resource.huaweicloud_fgs_trigger;
    const rate = trig.tick_timer_0;
    expect(rate.type).toBe("TIMER");
    expect(rate.timer.schedule_type).toBe("Rate");
    expect(rate.timer.schedule).toBe("2h");
    const cron = trig.tick_timer_1;
    expect(cron.status).toBe("DISABLED");
    expect(cron.timer.schedule).toBe("0 30 6 ? * MON");
    expect(JSON.parse(cron.timer.additional_information).data).toEqual({ report: "weekly" });
    const obs = trig.worker_obs_uploads;
    expect(obs.obs.bucket_name).toBe("uploads");
    expect(obs.obs.events).toEqual(["ObjectCreated"]);
    expect(obs.obs.suffix).toBe(".csv");
    expect(obs.depends_on).toEqual(["huaweicloud_obs_bucket.b_uploads"]);
    expect(trig.worker_smn_events.smn.topic_urn).toBe("${data.huaweicloud_smn_topics.t_events.topics[0].topic_urn}");
    expect(doc.resource.huaweicloud_smn_topic).toBeUndefined();
  });

  test("bundle exports index.handler and round-trips an APIG event", async () => {
    const res = await new Deployer(makeProject(CONFIG), () => undefined).package({ skipInstall: true });
    const mod = createRequire(import.meta.url)(path.join(res.artifact.buildDir, "index.js"));
    expect(typeof mod.handler).toBe("function");
    process.env.NSKIT_FUNCTION = "hello";
    try {
      const out = await mod.handler(
        {
          body: "",
          requestContext: { apiId: "a1", requestId: "r1", stage: "RELEASE", sourceIp: "9.9.9.9" },
          queryStringParameters: {},
          httpMethod: "GET",
          pathParameters: { name: "Ada" },
          headers: { host: "group.apic.cn-north-4.huaweicloudapis.com" },
          path: "/hello/Ada",
          isBase64Encoded: true,
        },
        {
          getRequestID: () => "r1",
          getRemainingTimeInMilliSeconds: () => 30000,
          getFunctionName: () => "demo-dev-hello",
          getMemorySize: () => 256,
        },
      );
      expect(out.statusCode).toBe(200);
      expect(JSON.parse(out.body)).toEqual({ message: "hello Ada", provider: "huawei" });
    } finally {
      delete process.env.NSKIT_FUNCTION;
    }
  });

  test("helpers and names", () => {
    expect(quartzCron(ScheduleEvent.parse({ cron: "0 0 1 * *" }))).toBe("0 0 0 1 * ?");
    expect(quartzCron(ScheduleEvent.parse({ cron: "15 10 * * *" }))).toBe("0 15 10 * * ?");
    expect(rateExpression(ScheduleEvent.parse({ rate: "1 day" }))).toBe("1d");
    const p = new HuaweiProvider();
    expect(p.physicalName("demo", "dev", "api")).toBe("demo-dev-api");
    expect(p.physicalName("demo", "dev", "api_")).toBe("demo-dev-api");
    expect(p.runtimeId("nodejs18")).toBe("Node.js18.15");
    expect(p.defaultRuntime).toBe("nodejs20");
  });
});
