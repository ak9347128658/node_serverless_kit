import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { Deployer } from "../../src/core/deployer";
import { Project } from "../../src/core/project";
import { IbmProvider, sizeFor } from "../../src/providers/ibm";

const HANDLERS = `export async function hello() { return { ok: true }; }
export async function step(event: { data: unknown }) { return event.data; }
`;

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function makeProject(yaml: string): Project {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nskit-ibm-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "handlers.ts"), HANDLERS);
  writeFileSync(path.join(dir, "nskit.yml"), yaml);
  return Project.load(path.join(dir, "nskit.yml"));
}

const errors = (p: Project) => p.validate().filter((i) => i.level === "error").map(String);

async function render(p: Project) {
  const res = await new Deployer(p, () => undefined).package({ skipInstall: true });
  return { tf: JSON.parse(readFileSync(res.tfFile, "utf-8")), warnings: res.warnings };
}

const CONFIG = `
service: demo
provider:
  name: ibm
  memory: 1024
  environment: {GREETING: "\${HOME_DIR}"}
functions:
  hello:
    handler: src/handlers.hello
    events:
      - http: "GET /hello/{name}"
  step:
    handler: src/handlers.step
    memory: 300
`;

describe("ibm provider", () => {
  test("metadata", () => {
    const p = new IbmProvider();
    expect(p.tier).toBe("beta");
    expect(p.defaultRuntime).toBe("nodejs22");
    expect(p.runtimeId("nodejs24")).toBe("nodejs-24");
    expect(() => p.runtimeId("nodejs20")).toThrow(/does not support nodejs20/);
    expect(p.bundle.entryFile).toBe("main.js");
  });

  test("unsupported events are flagged", () => {
    const p = makeProject(`
service: demo
provider: {name: ibm}
functions:
  tick:
    handler: src/handlers.step
    events: [{schedule: 5 minutes}, {queue: jobs}, {storage: b}, {topic: events}]
`);
    const joined = errors(p).join("\n");
    expect(joined).not.toContain("runtime");
    for (const kind of ["schedule", "queue", "storage", "topic"]) expect(joined).toContain(`\`${kind}\` events`);
  });

  test("render", async () => {
    const project = makeProject(CONFIG);
    expect(errors(project)).toEqual([]);
    const { tf, warnings } = await render(project);
    expect(warnings).toEqual([]);
    expect(tf.terraform.required_providers.ibm.source).toBe("IBM-Cloud/ibm");
    expect(tf.provider.ibm[0].region).toBe("us-south");
    const res = tf.resource;
    expect(res.ibm_code_engine_project.project.name).toBe("demo-dev");
    const hello = res.ibm_code_engine_function.hello;
    expect(hello.project_id).toBe("${ibm_code_engine_project.project.project_id}");
    expect(hello.runtime).toBe("nodejs-22");
    expect(hello.code_binary).toBe(true);
    expect(hello.code_main).toBe("main");
    expect(hello.code_reference).toBe('data:text/plain;base64,${filebase64("${path.module}/artifact.zip")}');
    expect([hello.scale_cpu_limit, hello.scale_memory_limit]).toEqual(["0.25", "1G"]);
    expect(hello.managed_domain_mappings).toBe("local_public");
    expect(res.ibm_code_engine_function.step.scale_memory_limit).toBe("0.5G");
    const env = Object.fromEntries(hello.run_env_variables.map((e: { name: string; value: string }) => [e.name, e.value]));
    expect(env.NSKIT_FUNCTION).toBe("hello");
    expect(env.GREETING).toBe("$${HOME_DIR}"); // escaped for terraform
    expect(hello.run_env_variables.every((e: { type: string }) => e.type === "literal")).toBe(true);

    const build = path.join(project.workDir, "build");
    const pkg = JSON.parse(readFileSync(path.join(build, "package.json"), "utf-8"));
    expect(pkg.main).toBe("main.js");
    expect(readFileSync(path.join(build, "main.js"), "utf-8")).toContain("main");

    // Round trip: Code Engine calls `main(params)` from main.js.
    const bundle = createRequire(import.meta.url)(path.join(build, "main.js"));
    process.env.NSKIT_FUNCTION = "hello";
    const resp = await bundle.main({ __ce_method: "GET", __ce_path: "/hello/Ada", __ce_headers: { Accept: "*/*" }, __ce_query: "" });
    expect(resp).toMatchObject({ statusCode: 200, body: { ok: true } });
    delete process.env.NSKIT_FUNCTION;

    const out = tf.output.nskit.value;
    expect(out.functions.hello.base_url).toBe("${ibm_code_engine_function.hello.endpoint}");
    expect(out.functions.hello.id).toBe("${ibm_code_engine_function.hello.function_id}");
    expect(out.functions.step.base_url).toBeUndefined();
    expect(out.endpoint).toBe("${ibm_code_engine_function.hello.endpoint}");
  });

  test("existing project, custom code reference, visibility and auth", async () => {
    const cfg = CONFIG.replace(
      "memory: 1024",
      "memory: 1024\n  options: {project_id: proj-123, visibility: local_private, code_reference: icr.io/ns/bundle:1, code_secret: reg}",
    ).replace("memory: 300", "memory: 300\n    concurrency: 10\n    options: {visibility: local, scale_down_delay: 5}");
    const { tf } = await render(makeProject(cfg));
    expect(tf.resource.ibm_code_engine_project).toBeUndefined();
    const hello = tf.resource.ibm_code_engine_function.hello;
    expect(hello.project_id).toBe("proj-123");
    expect(hello.code_reference).toBe("icr.io/ns/bundle:1");
    expect(hello.code_secret).toBe("reg");
    expect(hello.managed_domain_mappings).toBe("local_private");
    const step = tf.resource.ibm_code_engine_function.step;
    expect(step.managed_domain_mappings).toBe("local");
    expect(step.visibility).toBeUndefined();
    expect(step.scale_down_delay).toBe(5);
    expect(step.scale_concurrency).toBe(10);

    const bad = makeProject(CONFIG.replace('"GET /hello/{name}"', "{path: /x, auth: jwt}").replace("memory: 300", "memory: 8192"));
    const errs = errors(bad);
    expect(errs.some((e) => e.includes("auth `jwt`"))).toBe(true);
    expect(errs.some((e) => e.includes("at most 4096 MB"))).toBe(true);
  });

  test("size mapping", () => {
    expect(sizeFor(128)).toEqual(["0.125", "0.5G"]);
    expect(sizeFor(2048)).toEqual(["0.5", "2G"]);
    expect(sizeFor(9999)).toEqual(["1", "4G"]);
  });
});
