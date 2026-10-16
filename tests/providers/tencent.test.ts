import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Deployer } from "../../src/core/deployer";
import { Project } from "../../src/core/project";
import { ProviderError } from "../../src/providers/base";
import { gatewayPath, TencentProvider } from "../../src/providers/tencent";

const HANDLERS = `
export async function hello(event) {
  const name = event.http.pathParams.name ?? event.http.query.name ?? "world";
  return { message: "hello " + name, provider: event.provider };
}
export async function create(event) { return { status: "created", ...event.http.json() }; }
export async function tick(event) { return { type: event.type, data: event.data }; }
export async function worker(event) { return event.records.length; }
export async function step(event) { return event.data; }
`;

const FULL = `
service: demo
provider:
  name: tencent
functions:
  worker:
    handler: src/handlers.worker
    events:
      - queue: {name: jobs}
      - topic: events
`;

const CONFIG = `
service: demo
provider:
  name: tencent
  runtime: nodejs18
functions:
  hello:
    handler: src/handlers.hello
    events:
      - http: GET /hello/{name}
      - http: {path: "/files/{path+}", method: ANY, cors: true}
  tick:
    handler: src/handlers.tick
    events:
      - schedule: 5 minutes
      - schedule: {cron: "0 12 * * 1", input: {report: weekly}, name: weekly}
  worker:
    handler: src/handlers.worker
    events:
      - storage: {bucket: uploads-1250000000, prefix: in/}
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
  const root = mkdtempSync(path.join(os.tmpdir(), "nskit-tencent-"));
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

describe("TencentProvider", () => {
  test("unsupported events are reported and the default runtime is supported", () => {
    const issues = makeProject(FULL).validate().filter((i) => i.level === "error");
    const text = issues.map(String).join("\n");
    expect(text).toContain("`queue`");
    expect(text).toContain("`topic`");
    expect(text).not.toContain("runtime");
  });

  test("renders the function", async () => {
    const project = makeProject(CONFIG);
    const doc = await render(project);
    const hello = doc.resource.tencentcloud_scf_function.hello;
    expect(hello.name).toBe("demo-dev-hello");
    expect(hello.handler).toBe("index.main_handler");
    expect(hello.runtime).toBe("Nodejs18.15");
    expect(hello.namespace).toBe("default");
    expect(hello.enable_public_net).toBe(true);
    const zipName = hello.zip_file.split("/").pop();
    expect(zipName).toMatch(/^artifact-[0-9a-f]{16}\.zip$/);
    expect(existsSync(path.join(project.workDir, zipName))).toBe(true);
    expect(hello.environment.NSKIT_PROVIDER).toBe("tencent");
  });

  test("artifact copy is content addressed", async () => {
    const project = makeProject(CONFIG);
    const list = () => readdirSync(project.workDir).filter((f) => /^artifact-.+\.zip$/.test(f));
    await render(project);
    const first = list();
    writeFileSync(path.join(project.root, "src", "handlers.ts"), HANDLERS + "\nexport const extra = 1;\n");
    await render(project);
    const second = list();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first).not.toEqual(second);
  });

  test("timer and COS triggers", async () => {
    const doc = await render(makeProject(CONFIG));
    const fns = doc.resource.tencentcloud_scf_function;
    const timers = Object.fromEntries(fns.tick.triggers.map((t: { name: string }) => [t.name, t]));
    expect(timers["timer-0"].trigger_desc).toBe("0 */5 * * * * *");
    expect(timers.weekly.trigger_desc).toBe("0 0 12 * * MON *");
    const cfg = doc.resource.tencentcloud_scf_trigger_config.tick_weekly;
    expect(cfg.enable).toBe("OPEN");
    expect(JSON.parse(cfg.custom_argument)).toEqual({ __nskit: "schedule", data: { report: "weekly" }, source: "tencent.timer" });
    const cos = fns.worker.triggers[0];
    expect(cos.type).toBe("cos");
    expect(cos.name).toBe("uploads-1250000000.cos.ap-guangzhou.myqcloud.com");
    expect(JSON.parse(cos.trigger_desc)).toEqual({ event: "cos:ObjectCreated:*", filter: { Prefix: "in/", Suffix: "" } });
    expect(doc.resource.tencentcloud_cos_bucket).toBeDefined();
  });

  test("API Gateway and nskit output", async () => {
    const doc = await render(makeProject(CONFIG));
    const apis = doc.resource.tencentcloud_api_gateway_api;
    expect(apis.hello_0.request_config_path).toBe("/hello/{name}");
    expect(apis.hello_0.request_config_method).toBe("GET");
    expect(apis.hello_0.service_config_type).toBe("SCF");
    expect(apis.hello_0.service_config_scf_is_integrated_response).toBe(true);
    expect(apis.hello_0.request_parameters[0].name).toBe("name");
    expect(apis.hello_1.request_config_path).toBe("/files");
    expect(apis.hello_1.enable_cors).toBe(true);
    const release = doc.resource.tencentcloud_api_gateway_service_release.release;
    expect(release.environment_name).toBe("release");
    expect(release.depends_on).toHaveLength(3); // two routes + the orchestrator's route
    const out = doc.output.nskit.value;
    expect(out.endpoint).toBe("https://${tencentcloud_api_gateway_service.http.outer_sub_domain}/release");
    expect(out.functions.hello.base_url).toBe(out.endpoint);
    expect(out.workflows.pipeline.id).toBe("${tencentcloud_scf_function.pipeline_orchestrator.name}");
  });

  test("bundle exports main_handler and round-trips an API Gateway event", async () => {
    const res = await new Deployer(makeProject(CONFIG), () => undefined).package({ skipInstall: true });
    const mod = createRequire(import.meta.url)(path.join(res.artifact.buildDir, "index.js"));
    expect(typeof mod.main_handler).toBe("function");
    process.env.NSKIT_FUNCTION = "hello";
    try {
      const out = await mod.main_handler(
        {
          requestContext: {
            serviceId: "service-abc",
            path: "/hello/{name}",
            httpMethod: "GET",
            requestId: "r1",
            sourceIp: "10.0.0.1",
            stage: "release",
          },
          headers: { host: "service-abc-125000.gz.apigw.tencentcs.com", "user-agent": "curl/8.7.1" },
          body: "",
          pathParameters: { name: "Ada" },
          queryStringParameters: {},
          headerParameters: {},
          stageVariables: { stage: "release" },
          path: "/hello/Ada",
          queryString: {},
          httpMethod: "GET",
        },
        { request_id: "r1", function_name: "demo-dev-hello", memory_limit_in_mb: 256, time_limit_in_ms: 30000 },
      );
      expect(out.statusCode).toBe(200);
      expect(out.isBase64Encoded).toBe(false);
      expect(JSON.parse(out.body)).toEqual({ message: "hello Ada", provider: "tencent" });
    } finally {
      delete process.env.NSKIT_FUNCTION;
    }
  });

  test("validation rules", () => {
    const issues = makeProject(`
service: demo
provider: {name: tencent, memory: 300}
functions:
  api:
    handler: src/handlers.hello
    events: [{http: PATCH /x}, {http: {path: /y, auth: iam}}]
`)
      .validate()
      .filter((i) => i.level === "error")
      .map(String)
      .join("\n");
    expect(issues).toContain("PATCH");
    expect(issues).toContain("multiple of 128");
    expect(issues).toContain("auth `iam`");
  });

  test("COS bucket needs an APPID suffix", () => {
    const issues = makeProject(`
service: demo
provider: {name: tencent}
functions:
  worker:
    handler: src/handlers.worker
    events: [{storage: uploads}]
`).validate();
    expect(issues.some((i) => i.level === "error" && i.message.includes("APPID"))).toBe(true);
  });

  test("names, runtimes and gateway paths", () => {
    const p = new TencentProvider();
    expect(p.physicalName("demo", "dev", "api_")).toBe("demo-dev-api");
    expect(p.physicalName("demo", "dev", "x".repeat(80)).length).toBeLessThanOrEqual(60);
    expect(p.runtimeId("nodejs20")).toBe("Nodejs20.19");
    expect(p.defaultRuntime).toBe("nodejs20");
    expect(() => p.runtimeId("nodejs22")).toThrow(ProviderError);
    expect(gatewayPath("/files/{path+}")).toBe("/files");
    expect(gatewayPath("/")).toBe("/");
  });
});
