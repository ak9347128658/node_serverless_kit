import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { Project } from "../../src/core/project";
import { Deployer } from "../../src/core/deployer";
import { AzureProvider, azureRoute } from "../../src/providers/azure";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const HANDLERS = `
import { HttpResponse, type Event } from "node_serverless_kit";
export async function hello(event: Event) {
  const r = HttpResponse.json({ name: event.http?.pathParams.name ?? null, path: event.http?.path }, 201);
  r.setCookie("sid", "1");
  return r;
}
export async function echo(event: Event) {
  return { type: event.type, data: event.data ?? null, n: event.records.length };
}
export async function step(event: Event) {
  return { stepped: event.data };
}
`;

const FULL = `
service: demo
provider:
  name: azure
  region: westeurope
  options:
    subscription_id: sub
functions:
  hello:
    handler: src/handlers.hello
    environment: {GREETING: hi}
    events:
      - http: GET /hello/{name}
      - http: {path: "/files/{path+}", method: ANY, auth: key, cors: true}
  tick:
    handler: src/handlers.echo
    events:
      - schedule: {rate: 5 minutes, input: {report: weekly}}
      - schedule: {cron: "0 3 * * 1", enabled: false}
  jobs:
    handler: src/handlers.echo
    events:
      - queue: {name: jobs, maxReceive: 7}
  uploads:
    handler: src/handlers.echo
    events:
      - storage: {bucket: demo-uploads-1234, suffix: .csv}
  worker:
    handler: src/handlers.echo
    events:
      - topic: events
  step:
    handler: src/handlers.step
workflows:
  pipeline:
    startAt: A
    states:
      A: {type: task, function: step, end: true}
`;

function makeProject(yaml: string): Project {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nskit-azure-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "nskit.yml"), yaml);
  writeFileSync(path.join(dir, "src", "handlers.ts"), HANDLERS);
  return Project.load(path.join(dir, "nskit.yml"));
}

const errors = (p: Project) => p.validate().filter((i) => i.level === "error").map((i) => i.message);

async function packaged(yaml: string) {
  const project = makeProject(yaml);
  const result = await new Deployer(project, () => undefined).package({ skipInstall: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tf: any = JSON.parse(readFileSync(result.tfFile, "utf-8"));
  return { project, result, tf, build: result.artifact.buildDir };
}

describe("render", () => {
  test("full config (Linux Consumption)", async () => {
    const { project, tf } = await packaged(FULL);
    expect(errors(project)).toEqual([]);
    const res = tf.resource;
    for (const type of [
      "azurerm_resource_group",
      "azurerm_storage_account",
      "azurerm_service_plan",
      "azurerm_linux_function_app",
      "azurerm_storage_queue",
      "azurerm_storage_container",
      "azurerm_servicebus_namespace",
      "azurerm_servicebus_topic",
      "azurerm_servicebus_subscription",
      "azurerm_application_insights",
      "azurerm_log_analytics_workspace",
    ]) {
      expect(res, type).toHaveProperty(type);
    }
    expect(tf.terraform.required_providers.azurerm).toEqual({ source: "hashicorp/azurerm", version: ">= 4.9" });
    expect(tf.provider.azurerm[0]).toEqual({ features: {}, subscription_id: "sub" });
    expect(res.azurerm_service_plan.plan.sku_name).toBe("Y1");
    const app = res.azurerm_linux_function_app.app;
    expect(app.zip_deploy_file).toBe("${path.module}/artifact.zip");
    expect(app.functions_extension_version).toBe("~4");
    expect(app.site_config.application_stack).toEqual({ node_version: "22" });
    expect(app.site_config.cors.allowed_origins).toEqual(["*"]);
    expect(app.site_config.application_insights_connection_string).toBe("${azurerm_application_insights.ai.connection_string}");
    const settings = app.app_settings;
    expect(settings.SCM_DO_BUILD_DURING_DEPLOYMENT).toBe("true");
    expect(settings.NSKIT_SERVICE).toBe("demo");
    expect(settings.GREETING).toBe("hi");
    expect(settings).not.toHaveProperty("NSKIT_FUNCTION");
    expect(settings).not.toHaveProperty("NSKIT_HANDLER");
    expect(settings.NSKIT_SERVICEBUS).toBe("${azurerm_servicebus_namespace.bus.default_primary_connection_string}");
    expect(settings["AzureWebJobs.tick_schedule_1.Disabled"]).toBe("true");
    expect(app.name.length).toBeLessThanOrEqual(60);
    expect(res.azurerm_storage_account.app.name).toMatch(/^[a-z0-9]{3,24}$/);
    expect(res.azurerm_servicebus_subscription.worker_events).toMatchObject({ name: "worker", max_delivery_count: 10 });

    const out = tf.output.nskit.value;
    expect(out.endpoint).toBe("https://${azurerm_linux_function_app.app.default_hostname}");
    expect(out.functions.hello.url).toBe("https://${azurerm_linux_function_app.app.default_hostname}/hello/{name}");
    expect(out.functions.jobs.id).toMatch(/\/jobs$/);
    expect(out.workflows.pipeline.url).toMatch(/\/workflows\/pipeline$/);
  });

  test("Flex Consumption, existing resource group and topic, no App Insights", async () => {
    const { project, tf } = await packaged(`
service: demo
provider:
  name: azure
  runtime: nodejs24
  memory: 1024
  options:
    plan_sku: FC1
    app_insights: false
    resource_group: my-rg
    servicebus_namespace_id: /subscriptions/s/resourceGroups/r/providers/Microsoft.ServiceBus/namespaces/n
    servicebus_connection: SB_CONN
    maximum_instance_count: 40
functions:
  hello: {handler: src/handlers.hello, events: [{http: GET /hello}]}
  worker: {handler: src/handlers.echo, events: [{topic: {name: events, existing: true}}]}
`);
    expect(errors(project)).toEqual([]);
    expect(tf.data.azurerm_resource_group.rg).toEqual({ name: "my-rg" });
    expect(tf.data.azurerm_servicebus_topic.t_events.namespace_id).toMatch(/namespaces\/n$/);
    expect(tf.resource).not.toHaveProperty("azurerm_linux_function_app");
    expect(tf.resource).not.toHaveProperty("azurerm_application_insights");
    expect(tf.resource).not.toHaveProperty("azurerm_servicebus_namespace");
    expect(tf.resource.azurerm_service_plan.plan.sku_name).toBe("FC1");
    const app = tf.resource.azurerm_function_app_flex_consumption.app;
    expect(app).toMatchObject({
      runtime_name: "node",
      runtime_version: "24",
      storage_container_type: "blobContainer",
      storage_authentication_type: "StorageAccountConnectionString",
      instance_memory_in_mb: 2048,
      maximum_instance_count: 40,
      zip_deploy_file: "${path.module}/artifact.zip",
    });
    expect(app.app_settings).not.toHaveProperty("SCM_DO_BUILD_DURING_DEPLOYMENT");
    expect(app.app_settings).not.toHaveProperty("WEBSITE_RUN_FROM_PACKAGE");
    expect(tf.resource.azurerm_storage_container.deployments.name).toBe("nskit-deployments");
    expect(tf.output.nskit.value.endpoint).toBe("https://${azurerm_function_app_flex_consumption.app.default_hostname}");
  });

  test("premium plan runs from package", async () => {
    const { tf } = await packaged(`
service: demo
provider: {name: azure, options: {plan_sku: EP1}}
functions:
  hello: {handler: src/handlers.hello, events: [{http: GET /hello}]}
`);
    expect(tf.resource.azurerm_linux_function_app.app.app_settings.WEBSITE_RUN_FROM_PACKAGE).toBe("1");
  });
});

describe("bundle", () => {
  test("host.json, package.json and dependencies", async () => {
    const { build } = await packaged(FULL);
    const host = JSON.parse(readFileSync(path.join(build, "host.json"), "utf-8"));
    expect(host.extensions.http.routePrefix).toBe("");
    expect(host.extensions.queues.maxDequeueCount).toBe(7);
    expect(host.extensionBundle.version).toBe("[4.*, 5.0.0)");
    expect(host.functionTimeout).toBe("00:10:00"); // the embedded orchestrator defaults to the 600 s maximum
    const pkg = JSON.parse(readFileSync(path.join(build, "package.json"), "utf-8"));
    expect(pkg.main).toBe("index.js");
    expect(pkg.type).toBe("commonjs");
    expect(pkg.dependencies["@azure/functions"]).toMatch(/^\^4\./);
  });

  test("the built bundle registers every trigger on a fake app and round-trips HTTP", async () => {
    const { build } = await packaged(FULL);
    // Stand-in for @azure/functions (the real package is installed by `nskit package` without --skip-install).
    const fake = path.join(build, "node_modules", "@azure", "functions");
    mkdirSync(fake, { recursive: true });
    writeFileSync(path.join(fake, "package.json"), JSON.stringify({ name: "@azure/functions", main: "index.js" }));
    writeFileSync(
      path.join(fake, "index.js"),
      `const calls = []; const rec = (k) => (name, options) => calls.push({ kind: k, name, options });
       module.exports = { calls, app: { http: rec("http"), timer: rec("timer"), storageQueue: rec("storageQueue"),
         storageBlob: rec("storageBlob"), serviceBusTopic: rec("serviceBusTopic") } };`,
    );
    const req = createRequire(path.join(build, "index.js"));
    req(path.join(build, "index.js"));
    const { calls } = req("@azure/functions") as { calls: { kind: string; name: string; options: Record<string, unknown> }[] };
    expect(calls.map((c) => `${c.kind}:${c.name}`).sort()).toEqual([
      "http:hello_http_0",
      "http:hello_http_1",
      "http:pipeline_orchestrator_http_0",
      "http:step_invoke",
      "serviceBusTopic:worker_topic_0",
      "storageBlob:uploads_storage_0",
      "storageQueue:jobs_queue_0",
      "timer:tick_schedule_0",
      "timer:tick_schedule_1",
    ]);
    const byName = Object.fromEntries(calls.map((c) => [c.name, c.options]));
    expect(byName.hello_http_0).toMatchObject({ route: "hello/{name}", methods: ["GET"], authLevel: "anonymous" });
    expect(byName.hello_http_1).toMatchObject({ route: "files/{*path}", authLevel: "function" });
    expect((byName.hello_http_1.methods as string[]).length).toBe(7);
    expect(byName.step_invoke).toMatchObject({ route: "_nskit/invoke/step", methods: ["POST"], authLevel: "function" });
    expect(byName.tick_schedule_0).toMatchObject({ schedule: "0 */5 * * * *" });
    expect(byName.uploads_storage_0).toMatchObject({ path: "demo-uploads-1234/{name}.csv", connection: "AzureWebJobsStorage" });
    expect(byName.worker_topic_0).toMatchObject({ topicName: "events", subscriptionName: "worker", connection: "NSKIT_SERVICEBUS" });
    expect(byName.jobs_queue_0).toMatchObject({ queueName: "jobs", connection: "AzureWebJobsStorage" });

    const handler = byName.hello_http_0.handler as (r: unknown, c: unknown) => Promise<Record<string, unknown>>;
    const res = await handler(
      {
        method: "GET",
        url: "https://demo.azurewebsites.net/hello/Ada",
        headers: new Headers(),
        query: new URLSearchParams(),
        params: { name: "Ada" },
        arrayBuffer: async () => new ArrayBuffer(0),
      },
      { invocationId: "i1" },
    );
    expect(res.status).toBe(201);
    expect(JSON.parse(new TextDecoder().decode(res.body as Uint8Array))).toEqual({ name: "Ada", path: "/hello/Ada" });
    expect((res.cookies as { name: string }[])[0].name).toBe("sid");

    const orch = byName.pipeline_orchestrator_http_0.handler as (r: unknown, c: unknown) => Promise<Record<string, unknown>>;
    const wf = await orch(
      {
        method: "POST",
        url: "https://demo.azurewebsites.net/workflows/pipeline",
        headers: new Headers({ "content-type": "application/json" }),
        query: new URLSearchParams(),
        params: {},
        arrayBuffer: async () => new TextEncoder().encode('{"x":1}').buffer,
      },
      { invocationId: "i2" },
    );
    expect(wf.status).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(wf.body as Uint8Array))).toMatchObject({ status: "SUCCEEDED", output: { stepped: { x: 1 } } });

    const timer = byName.tick_schedule_0.handler as (t: unknown, c: unknown) => Promise<unknown>;
    await expect(timer({ isPastDue: false }, { invocationId: "i3" })).resolves.toBeUndefined();
  });
});

describe("validation", () => {
  test("unsupported combinations", () => {
    const project = makeProject(`
service: demo
provider: {name: azure}
functions:
  a:
    handler: src/handlers.echo
    events:
      - http: {path: /a, auth: jwt}
      - http: {path: /, method: POST}
      - http: {path: /admin/x, method: POST}
      - storage: {bucket: up-x, events: [deleted]}
      - topic: {name: t, existing: true}
      - queue: {name: Bad_Name}
`);
    const msgs = errors(project).join(" | ");
    expect(msgs).toContain("auth 'jwt'");
    expect(msgs).toContain("root path");
    expect(msgs).toContain("reserved");
    expect(msgs).toContain("created/updated");
    expect(msgs).toContain("servicebus_namespace_id");
    expect(msgs).toContain("queue name 'Bad_Name'");
  });

  test("Node 24 needs Flex or Premium; Flex has no polling blob trigger", () => {
    expect(errors(makeProject(`
service: demo
provider: {name: azure, runtime: nodejs24}
functions: {a: {handler: src/handlers.echo}}
`)).join(" ")).toContain("plan_sku FC1");
    expect(errors(makeProject(`
service: demo
provider: {name: azure, runtime: nodejs24, options: {plan_sku: FC1}}
functions: {a: {handler: src/handlers.echo, events: [{storage: up-x}]}}
`)).join(" ")).toContain("Event Grid");
    expect(errors(makeProject(`
service: demo
provider: {name: azure, runtime: nodejs18}
functions: {a: {handler: src/handlers.echo}}
`)).join(" ")).toContain("does not support nodejs18");
  });

  test("subscription id warning", () => {
    const saved = process.env.ARM_SUBSCRIPTION_ID;
    delete process.env.ARM_SUBSCRIPTION_ID;
    try {
      const project = makeProject(`
service: demo
provider: {name: azure}
functions: {a: {handler: src/handlers.echo}}
`);
      expect(project.validate().some((i) => i.level === "warning" && i.message.includes("subscription id"))).toBe(true);
      process.env.ARM_SUBSCRIPTION_ID = "x";
      expect(project.validate().some((i) => i.message.includes("subscription id"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.ARM_SUBSCRIPTION_ID;
      else process.env.ARM_SUBSCRIPTION_ID = saved;
    }
  });
});

test("helpers", () => {
  expect(azureRoute("/files/{path+}")).toBe("files/{*path}");
  expect(azureRoute("/hello/")).toBe("hello");
  expect(AzureProvider.subscriptionName("my fn")).toBe("my-fn");
  const p = new AzureProvider();
  expect(p.defaultRuntime).toBe("nodejs22");
  expect(p.appName("demo", "dev")).toMatch(/^demo-dev-[0-9a-f]{8}$/);
});
