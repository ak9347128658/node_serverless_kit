import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, test } from "vitest";
import { Deployer } from "../../src/core/deployer";
import { Project } from "../../src/core/project";
import { RenderContext } from "../../src/providers/base";
import { getProvider } from "../../src/providers/registry";
import { planDeployments, serviceAccountId, labels } from "../../src/providers/gcp";

/* eslint-disable @typescript-eslint/no-explicit-any */

const HANDLERS = `
export const hello = async (event) => ({ hello: event.http?.pathParams?.name ?? "world" });
export const worker = async (event) => ({ type: event.type, n: event.records.length, data: event.data ?? null });
export const step = async (event) => ({ ...(event.data ?? {}), stepped: true });
`;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function makeProject(yaml: string): Project {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nskit-gcp-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "app"), { recursive: true });
  writeFileSync(path.join(dir, "app", "handlers.js"), HANDLERS);
  writeFileSync(path.join(dir, "nskit.yml"), yaml.replace(/^\n/, ""));
  return Project.load(path.join(dir, "nskit.yml"));
}

function render(project: Project): any {
  const ctx = new RenderContext({
    config: project.config,
    provider: project.provider,
    root: project.root,
    workDir: project.workDir,
    artifact: {
      path: path.join(project.workDir, "artifact.zip"),
      sha256: "ab".repeat(32),
      sha256Base64: "q".repeat(43) + "=",
      size: 1,
      fileCount: 1,
      buildDir: path.join(project.workDir, "build"),
      entryFile: "index.js",
    },
    region: project.region,
    workflowEngines: { ...project.engines },
  });
  const doc = project.provider.render(ctx);
  return { ...doc.toObject(), warnings: doc.warnings };
}

const errors = (project: Project) => project.validate().filter((i) => i.level === "error");

const GCP_CONFIG = `
service: demo
provider:
  name: gcp
  options: {project: my-proj}
functions:
  hello:
    handler: app/handlers.hello
    events:
      - http: GET /hello/{name}
      - schedule: {cron: "0 12 * * 1", input: {a: 1}}
  worker:
    handler: app/handlers.worker
    events:
      - queue: jobs
      - schedule: 5 minutes
  files:
    handler: app/handlers.worker
    events: [{storage: {bucket: demo-uploads-1234, suffix: .csv}}]
  step:
    handler: app/handlers.step
workflows:
  pipeline:
    startAt: First
    states:
      First: {type: task, function: step, next: Second}
      Second: {type: task, function: step, end: true}
`;

describe("gcp provider", () => {
  test("metadata", () => {
    const p = getProvider("gcp");
    expect(p.tier).toBe("beta");
    expect(p.defaultRuntime).toBe("nodejs22");
    expect(p.runtimeId("nodejs24")).toBe("nodejs24");
    expect(() => p.runtimeId("nodejs18")).toThrow();
    expect(p.remoteInstall).toBe(true);
    expect(p.dependencies).toHaveProperty("@google-cloud/functions-framework");
    expect(p.bundle.external).toContain("@google-cloud/functions-framework");
  });

  test("renders all resources", () => {
    const project = makeProject(GCP_CONFIG);
    expect(errors(project)).toEqual([]);
    const tf = render(project);
    const res = tf.resource;
    for (const type of [
      "google_storage_bucket",
      "google_storage_bucket_object",
      "google_service_account",
      "google_cloudfunctions2_function",
      "google_cloud_run_service_iam_member",
      "google_cloud_scheduler_job",
      "google_pubsub_topic",
      "google_project_iam_member",
      "google_workflows_workflow",
    ]) {
      expect(res, type).toHaveProperty(type);
    }
    const fns = res.google_cloudfunctions2_function;
    expect(fns.hello.build_config.entry_point).toBe("nskit_http");
    expect(fns.hello.build_config.runtime).toBe("nodejs22");
    expect(fns.hello.build_config.source.storage_source).toEqual({
      bucket: "${google_storage_bucket_object.source.bucket}",
      object: "${google_storage_bucket_object.source.name}",
    });
    expect(fns.worker.build_config.entry_point).toBe("nskit_event");
    expect(fns.worker.event_trigger.event_type).toBe("google.cloud.pubsub.topic.v1.messagePublished");
    expect(fns.worker.event_trigger.pubsub_topic).toBe("${google_pubsub_topic.t_jobs.id}");
    const env = fns.worker.service_config.environment_variables;
    expect(env.NSKIT_TRIGGER_KIND).toBe("queue");
    expect(env.NSKIT_GCP_PROJECT).toBe("my-proj");
    expect(env.NSKIT_FUNCTION).toBe("worker");
    expect(fns.files.event_trigger.event_type).toBe("google.cloud.storage.object.v1.finalized");
    expect(fns.files.event_trigger.event_filters).toEqual([
      { attribute: "bucket", value: "${google_storage_bucket.b_demo_uploads_1234.name}" },
    ]);
    expect(fns.files.service_config.environment_variables.NSKIT_STORAGE_SUFFIX).toBe(".csv");
    expect(fns.hello.service_config.available_memory).toBe("256M");
    expect(res.google_cloud_run_service_iam_member).toHaveProperty("hello_public");
    expect(res.google_cloud_run_service_iam_member).not.toHaveProperty("worker_public");
    expect(res.google_cloud_run_service_iam_member.hello_public.member).toBe("allUsers");

    const jobs = res.google_cloud_scheduler_job;
    const body = JSON.parse(Buffer.from(jobs.hello_0.http_target.body, "base64").toString("utf-8"));
    expect(body).toEqual({ __nskit: "schedule", data: { a: 1 }, source: "gcp.scheduler" });
    expect(jobs.hello_0.http_target.oidc_token.audience).toBe("${google_cloudfunctions2_function.hello.url}");
    expect(jobs.worker_0.pubsub_target.topic_name).toBe("${google_pubsub_topic.t_jobs.id}");
    expect(jobs.worker_0.schedule).toBe("*/5 * * * *");

    const wf = res.google_workflows_workflow.wf_pipeline.source_contents;
    expect(wf).toContain("${google_cloudfunctions2_function.step.url}");
    expect(wf).toContain("$${data}"); // workflow expressions escaped for terraform
    expect(wf).toContain('"__nskit": "workflow"');

    const out = tf.output.nskit.value;
    expect(out.functions.hello.url).toBe("${google_cloudfunctions2_function.hello.url}");
    expect(out.functions.worker).not.toHaveProperty("url");
    expect(out.workflows.pipeline.id).toBe("${google_workflows_workflow.wf_pipeline.id}");
    expect(out.endpoint).toBeNull();
    expect(tf.provider.google[0]).toEqual({ region: "us-central1", project: "my-proj" });
    expect(tf.terraform.required_providers.google.source).toBe("hashicorp/google");
  });

  test("functions with several triggers are split", () => {
    const project = makeProject(`
service: demo
provider: {name: gcp, options: {project: p}}
functions:
  mixed:
    handler: app/handlers.hello
    events:
      - http: GET /x
      - topic: t
      - storage: {bucket: up-123, events: [created, deleted]}
      - schedule: 5 minutes
  worker:
    handler: app/handlers.worker
    events: [{queue: jobs}, {storage: up-123}, {topic: t}]
`);
    expect(errors(project)).toEqual([]);
    const tf = render(project);
    const fns = tf.resource.google_cloudfunctions2_function;
    expect(Object.keys(fns).sort()).toEqual(
      ["mixed", "mixed_storage0", "mixed_storage1", "mixed_topic0", "worker_queue0", "worker_storage0", "worker_topic0"].sort(),
    );
    expect(fns.mixed.build_config.entry_point).toBe("nskit_http");
    expect(fns.mixed_storage0.event_trigger.event_type).toMatch(/finalized$/);
    expect(fns.mixed_storage1.event_trigger.event_type).toMatch(/deleted$/);
    expect(fns.worker_queue0.name).toBe("demo-dev-worker-queue0");
    for (const key of ["worker_queue0", "worker_storage0", "worker_topic0"]) {
      expect(fns[key].service_config.environment_variables.NSKIT_FUNCTION).toBe("worker");
    }
    expect(tf.resource.google_cloud_scheduler_job.mixed_0.http_target.uri).toBe("${google_cloudfunctions2_function.mixed.url}");
    const out = tf.output.nskit.value.functions;
    expect(out.mixed.id).toBe("${google_cloudfunctions2_function.mixed.name}");
    expect(out.mixed.extra).toHaveLength(3);
    expect(out.worker.id).toBe("${google_cloudfunctions2_function.worker_queue0.name}");
    expect(out.worker.extra).toEqual([
      "${google_cloudfunctions2_function.worker_storage0.name}",
      "${google_cloudfunctions2_function.worker_topic0.name}",
    ]);
    // one bucket / topic resource even when shared
    expect(Object.keys(tf.resource.google_pubsub_topic).sort()).toEqual(["t_jobs", "t_t"]);
    expect(tf.warnings.some((w: string) => w.includes("deployed as 4 Cloud Functions"))).toBe(true);
  });

  test("workflow task with only event triggers gets an HTTP deployment", () => {
    const project = makeProject(`
service: demo
provider: {name: gcp, options: {project: p}}
functions:
  step:
    handler: app/handlers.step
    events: [{queue: jobs}]
workflows:
  wf:
    startAt: A
    states: {A: {type: task, function: step}}
`);
    expect(errors(project)).toEqual([]);
    const tf = render(project);
    const fns = tf.resource.google_cloudfunctions2_function;
    expect(Object.keys(fns).sort()).toEqual(["step", "step_queue0"]);
    expect(fns.step.build_config.entry_point).toBe("nskit_http");
    expect(tf.resource.google_cloud_run_service_iam_member).not.toHaveProperty("step_public");
    expect(tf.resource.google_workflows_workflow.wf_wf.source_contents).toContain("${google_cloudfunctions2_function.step.url}");
  });

  test("storage + schedule gets an HTTP deployment for the scheduler", () => {
    const project = makeProject(`
service: demo
provider: {name: gcp, options: {project: p}}
functions:
  f:
    handler: app/handlers.worker
    events: [{storage: {bucket: up-123, existing: true, prefix: in/}}, {schedule: 1 hours}]
`);
    const tf = render(project);
    expect(Object.keys(tf.resource.google_cloudfunctions2_function).sort()).toEqual(["f", "f_storage0"]);
    expect(tf.resource.google_cloud_scheduler_job.f_0).toHaveProperty("http_target");
    const storage = tf.resource.google_cloudfunctions2_function.f_storage0;
    expect(storage.event_trigger.event_filters[0].value).toBe("up-123");
    expect(storage.service_config.environment_variables.NSKIT_STORAGE_PREFIX).toBe("in/");
    expect(tf.resource.google_storage_bucket).not.toHaveProperty("b_up_123");
    expect(tf.data.google_storage_project_service_account).toHaveProperty("gcs");
  });

  test("single trigger function keeps its name; existing topic uses a data source", () => {
    const project = makeProject(`
service: demo
provider: {name: gcp, options: {project: p, service_account: run@p.iam.gserviceaccount.com, enable_apis: true}}
functions:
  w:
    handler: app/handlers.worker
    concurrency: 5
    events: [{topic: {name: shared, existing: true}}]
`);
    const tf = render(project);
    const fn = tf.resource.google_cloudfunctions2_function.w;
    expect(fn.event_trigger.pubsub_topic).toBe("${data.google_pubsub_topic.t_shared.id}");
    expect(fn.service_config.environment_variables.NSKIT_TRIGGER_KIND).toBe("topic");
    expect(fn.service_config.max_instance_count).toBe(5);
    expect(fn.service_config.service_account_email).toBe("run@p.iam.gserviceaccount.com");
    expect(fn.depends_on).toContain("google_project_service.api_run");
    expect(tf.resource).not.toHaveProperty("google_pubsub_topic");
  });

  test("embedded workflow uses an orchestrator function", () => {
    const project = makeProject(`
service: demo
provider: {name: gcp, options: {project: p}}
functions:
  step: {handler: app/handlers.step}
workflows:
  wf:
    engine: embedded
    startAt: A
    states: {A: {type: task, function: step}}
`);
    const tf = render(project);
    expect(tf.resource.google_cloudfunctions2_function).toHaveProperty("wf_orchestrator");
    expect(tf.resource).not.toHaveProperty("google_workflows_workflow");
    expect(tf.output.nskit.value.workflows.wf.id).toBe("${google_cloudfunctions2_function.wf_orchestrator.name}");
  });

  test("validation", () => {
    const noProject = makeProject(`
service: demo
provider: {name: gcp}
functions:
  hello: {handler: app/handlers.hello, events: [{http: GET /x}]}
`);
    expect(errors(noProject).some((i) => i.message.includes("options.project"))).toBe(true);
    const slow = makeProject(`
service: demo
provider: {name: gcp, options: {project: p}}
functions:
  slow:
    handler: app/handlers.worker
    timeout: 900
    events: [{topic: t}]
  jwt:
    handler: app/handlers.hello
    events: [{http: {path: /j, auth: jwt}}]
  q:
    handler: app/handlers.worker
    events: [{queue: {name: q, fifo: true, deadLetter: dlq}}]
`);
    const issues = slow.validate();
    expect(issues.some((i) => i.level === "error" && i.message.includes("540"))).toBe(true);
    expect(issues.some((i) => i.level === "error" && i.message.includes("jwt"))).toBe(true);
    expect(issues.filter((i) => i.level === "warning" && /fifo|deadLetter/.test(i.message))).toHaveLength(2);
    const old = makeProject(`
service: demo
provider: {name: gcp, runtime: nodejs20, options: {project: p}}
functions:
  hello: {handler: app/handlers.hello}
`);
    expect(old.validate().some((i) => i.level === "warning" && i.message.includes("deprecated"))).toBe(true);
  });

  test("planDeployments", () => {
    const project = makeProject(GCP_CONFIG);
    const plan = planDeployments("worker", project.config.functions.worker);
    expect(plan.map((d) => [d.key, d.kind, d.pubsubSchedules, d.schedules.length])).toEqual([["worker", "queue", true, 1]]);
    expect(planDeployments("step", project.config.functions.step)[0].kind).toBe("http");
  });

  test("helpers", () => {
    expect(serviceAccountId("demo-dev-", "inv")).toBe("demo-dev-inv");
    expect(serviceAccountId("1-very-long-service-name-for-testing-dev", "inv")).toMatch(/^[a-z][-a-z0-9]{4,28}[a-z0-9]$/);
    expect(labels({ "Managed-By": "Node Serverless", "9x": "y" })).toEqual({ "managed-by": "node_serverless", k9x: "y" });
  });

  test("package writes the bundle with both entry points and a package.json for Cloud Build", async () => {
    const project = makeProject(GCP_CONFIG);
    const result = await new Deployer(project, () => undefined).package();
    const pkg = JSON.parse(readFileSync(path.join(result.artifact.buildDir, "package.json"), "utf-8"));
    expect(pkg.main).toBe("index.js");
    expect(pkg.type).toBe("commonjs");
    expect(pkg.dependencies["@google-cloud/functions-framework"]).toBe("^5.0.0");
    const code = readFileSync(path.join(result.artifact.buildDir, "index.js"), "utf-8");
    expect(code).toContain('require("@google-cloud/functions-framework")');
    const tf = JSON.parse(readFileSync(result.tfFile, "utf-8"));
    expect(tf.resource.google_storage_bucket_object.source.name).toBe(`demo-dev/source-${result.artifact.sha256.slice(0, 16)}.zip`);

    // The bundle works without the framework installed (plain exports).
    const mod = createRequire(import.meta.url)(path.join(result.artifact.buildDir, "index.js"));
    expect(typeof mod.nskit_http).toBe("function");
    expect(typeof mod.nskit_event).toBe("function");
    process.env.NSKIT_FUNCTION = "worker";
    process.env.NSKIT_TRIGGER_KIND = "queue";
    try {
      const out = await mod.nskit_event({
        type: "google.cloud.pubsub.topic.v1.messagePublished",
        id: "1",
        data: { message: { data: Buffer.from('{"a":1}').toString("base64"), messageId: "m1" } },
      });
      expect(out).toEqual({ type: "queue", n: 1, data: null });
      process.env.NSKIT_FUNCTION = "hello";
      const res: any = { statusCode: 0, headers: {}, setHeader(k: string, v: string) { this.headers[k] = v; }, end(b: any) { this.body = Buffer.from(b).toString(); } };
      await mod.nskit_http({ method: "GET", url: "/hello/Ada", headers: {} }, res);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ hello: "Ada" });
    } finally {
      delete process.env.NSKIT_FUNCTION;
      delete process.env.NSKIT_TRIGGER_KIND;
    }
  }, 60_000);
});
