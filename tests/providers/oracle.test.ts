import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { Deployer } from "../../src/core/deployer";
import { Project } from "../../src/core/project";
import { OracleProvider, ociPath } from "../../src/providers/oracle";

const HANDLERS = `export async function hello() { return { ok: true }; }
export async function worker(event: { records: unknown[] }) { return event.records.length; }
export async function step(event: { data: unknown }) { return event.data; }
`;

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function makeProject(yaml: string): Project {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nskit-oracle-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "handlers.ts"), HANDLERS);
  writeFileSync(path.join(dir, "nskit.yml"), yaml);
  return Project.load(path.join(dir, "nskit.yml"));
}

const errors = (p: Project) => p.validate().filter((i) => i.level === "error").map(String);

async function render(p: Project) {
  const res = await new Deployer(p, () => undefined).package({ skipInstall: true });
  return JSON.parse(readFileSync(res.tfFile, "utf-8"));
}

const OPTIONS = "{compartment_id: ocid1.compartment.oc1..c, subnet_ids: [ocid1.subnet.oc1..s], %s}";
const CONFIG = `
service: demo
provider:
  name: oracle
  options: %s
functions:
  hello:
    handler: src/handlers.hello
    events:
      - http: "GET /hello/{name}"
      - http: {path: "/files/{path+}", method: POST, cors: true}
  worker:
    handler: src/handlers.worker
    events:
      - storage: {bucket: uploads, events: [created, deleted]}
`;
const config = (opts: string) => CONFIG.replace("%s", OPTIONS.replace("%s", opts));

describe("oracle provider", () => {
  test("metadata", () => {
    const p = new OracleProvider();
    expect(p.tier).toBe("experimental");
    expect(p.defaultRuntime).toBe("nodejs22");
    expect(p.runtimeId("nodejs24")).toBe("24");
    expect(p.bundle.external).toContain("@fnproject/fdk");
    expect(p.dependencies).toHaveProperty("@fnproject/fdk");
    expect(p.remoteInstall).toBe(true);
  });

  test("required options and unsupported events", () => {
    const p = makeProject(`
service: demo
provider: {name: oracle}
functions:
  tick:
    handler: src/handlers.step
    events: [{schedule: 5 minutes}, {queue: jobs}, {topic: events}, {storage: b}]
`);
    const joined = errors(p).join("\n");
    expect(joined).toContain("options.compartment_id is required");
    expect(joined).toContain("options.subnet_ids");
    expect(joined).toContain("docker build -t <image>");
    for (const kind of ["schedule", "queue", "topic"]) expect(joined).toContain(`\`${kind}\` events`);
    expect(joined).not.toContain("`storage` events");
  });

  test("auth is rejected and a gateway policy warning is emitted", () => {
    const p = makeProject(config("image: x").replace('"GET /hello/{name}"', "{path: /x, auth: jwt}"));
    expect(errors(p).some((e) => e.includes("auth `jwt`"))).toBe(true);
    expect(p.validate().some((i) => i.level === "warning" && i.message.includes("functions-family"))).toBe(true);
  });

  test("render with docker build + push", async () => {
    const project = makeProject(config("image_repository: iad.ocir.io/ns/demo/"));
    expect(errors(project)).toEqual([]);
    const tf = await render(project);
    const res = tf.resource;
    expect(tf.terraform.required_providers.oci.source).toBe("oracle/oci");
    expect(tf.provider.oci[0].region).toBe("us-ashburn-1");

    const imageBuild = res.terraform_data.image;
    const image: string = imageBuild.triggers_replace[0];
    expect(image).toMatch(/^iad\.ocir\.io\/ns\/demo:[0-9a-f]{16}$/);
    const cmd: string = imageBuild.provisioner[0]["local-exec"].command;
    expect(cmd).toBe(`docker build --platform linux/amd64 -t ${image} build && docker push ${image}`);

    const fn = res.oci_functions_function.hello;
    expect(fn.source_details).toEqual({ source_type: "CONTAINER_IMAGE", image });
    expect(fn.image).toBeUndefined();
    expect(fn.memory_in_mbs).toBe("256");
    expect(fn.timeout_in_seconds).toBe(30);
    expect(fn.depends_on).toEqual(["terraform_data.image"]);
    expect(fn.config.NSKIT_HANDLER).toBe("src/handlers.hello");
    expect(fn.config.NSKIT_FUNCTION).toBe("hello");
    expect(res.oci_functions_application.app.shape).toBe("GENERIC_X86");
    expect(res.oci_functions_application.app.subnet_ids).toEqual(["ocid1.subnet.oc1..s"]);

    const deployment = res.oci_apigateway_deployment.http;
    expect(deployment.path_prefix).toBe("/demo");
    const routes = deployment.specification.routes;
    expect(Object.fromEntries(routes.map((r: { path: string; methods: string[] }) => [r.path, r.methods]))).toEqual({
      "/hello/{name}": ["GET"],
      "/files/{path*}": ["POST", "OPTIONS"],
    });
    expect(routes[0].backend).toEqual({ type: "ORACLE_FUNCTIONS_BACKEND", function_id: "${oci_functions_function.hello.id}" });
    expect(res.oci_apigateway_gateway.gateway.subnet_id).toBe("ocid1.subnet.oc1..s");

    expect(res.oci_objectstorage_bucket.b_uploads.object_events_enabled).toBe(true);
    const rule = res.oci_events_rule.worker_uploads;
    const cond = JSON.parse(rule.condition);
    expect(cond.data.additionalDetails.bucketName).toBe("uploads");
    expect(cond.eventType).toContain("com.oraclecloud.objectstorage.deleteobject");
    expect(rule.actions.actions[0]).toMatchObject({ action_type: "FAAS", function_id: "${oci_functions_function.worker.id}" });
    expect(rule.depends_on).toEqual(["oci_objectstorage_bucket.b_uploads"]);

    const build = path.join(project.workDir, "build");
    const dockerfile = readFileSync(path.join(build, "Dockerfile"), "utf-8");
    expect(dockerfile).toContain("FROM fnproject/node:22-dev AS build-stage");
    expect(dockerfile).toContain("FROM fnproject/node:22\n");
    expect(dockerfile).toContain("RUN npm install");
    expect(dockerfile).toContain('ENTRYPOINT ["node", "func.js"]');
    const funcJs = readFileSync(path.join(build, "func.js"), "utf-8");
    expect(funcJs).toContain('require("@fnproject/fdk")');
    expect(funcJs).toContain('inputMode: "buffer"');
    expect(readFileSync(path.join(build, "func.yaml"), "utf-8")).toContain("run_image: fnproject/node:22");
    const pkg = JSON.parse(readFileSync(path.join(build, "package.json"), "utf-8"));
    expect(pkg.dependencies["@fnproject/fdk"]).toBeTruthy();
    expect(pkg.type).toBe("commonjs");
    // The FDK is not bundled into the runtime code.
    expect(readFileSync(path.join(build, "index.js"), "utf-8")).not.toContain("fn-fdk");

    // Round trip: the bundle's FDK handler with an API Gateway request (FDK-style context).
    const bundle = createRequire(import.meta.url)(path.join(build, "index.js"));
    const responseHeaders: Record<string, string[]> = {};
    const ctx = {
      headers: { "Fn-Http-Method": ["GET"], "Fn-Http-Request-Url": ["/demo/hello/Ada"], "Fn-Call-Id": ["c1"] },
      callID: "c1",
      setResponseHeader: (k: string, ...v: string[]) => (responseHeaders[k] = v),
    };
    process.env.NSKIT_FUNCTION = "hello";
    const raw = await bundle.handler(Buffer.alloc(0), ctx, (b: Uint8Array) => Buffer.from(b).toString());
    expect(JSON.parse(raw)).toEqual({ ok: true });
    expect(responseHeaders["Fn-Http-Status"]).toEqual(["200"]);
    delete process.env.NSKIT_FUNCTION;

    const out = tf.output.nskit.value;
    expect(out.endpoint).toBe("${oci_apigateway_deployment.http.endpoint}");
    expect(out.functions.hello.base_url).toBe("${oci_apigateway_deployment.http.endpoint}");
    expect(out.functions.worker.base_url).toBeUndefined();
    expect(out.functions.worker.id).toBe("${oci_functions_function.worker.id}");
  });

  test("prebuilt image, arm64 and existing bucket", async () => {
    const yaml = config("image: iad.ocir.io/ns/demo:v1, gateway_subnet_id: ocid1.subnet.oc1..gw")
      .replace("name: oracle", "name: oracle\n  architecture: arm64\n  runtime: nodejs20")
      .replace("events: [created, deleted]", "events: [created], existing: true");
    const tf = await render(makeProject(yaml));
    expect(tf.resource.terraform_data).toBeUndefined();
    expect(tf.resource.oci_functions_function.worker.source_details.image).toBe("iad.ocir.io/ns/demo:v1");
    expect(tf.resource.oci_functions_function.worker.depends_on).toBeUndefined();
    expect(tf.resource.oci_functions_application.app.shape).toBe("GENERIC_ARM");
    expect(tf.resource.oci_apigateway_gateway.gateway.subnet_id).toBe("ocid1.subnet.oc1..gw");
    expect(tf.resource.oci_objectstorage_bucket).toBeUndefined();
    expect(tf.resource.oci_events_rule.worker_uploads.depends_on).toBeUndefined();
  });

  test("ociPath", () => {
    expect(ociPath("/files/{path+}")).toBe("/files/{path*}");
    expect(ociPath("/users/{id}")).toBe("/users/{id}");
  });
});
