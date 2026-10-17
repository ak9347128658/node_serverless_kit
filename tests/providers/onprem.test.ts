import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { Deployer } from "../../src/core/deployer";
import { Project } from "../../src/core/project";
import { OnpremProvider } from "../../src/providers/onprem";

const HANDLERS = `export async function hello() { return { ok: true }; }
export async function job(event: { type: string }) { return event.type; }
`;

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function makeProject(yaml: string): Project {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nskit-onprem-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "handlers.ts"), HANDLERS);
  writeFileSync(path.join(dir, "nskit.yml"), yaml);
  return Project.load(path.join(dir, "nskit.yml"));
}

const errors = (p: Project) => p.validate().filter((i) => i.level === "error").map(String);

async function render(p: Project) {
  const res = await new Deployer(p, () => undefined).package({ skipInstall: true });
  return { tf: JSON.parse(readFileSync(res.tfFile, "utf-8")) as Record<string, any>, project: p }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const CONFIG = `
service: demo
provider:
  name: onprem
  region: local
  environment:
    FOO: "\${hello}"
  options: {http_port: 8090, publish: "127.0.0.1"}
functions:
  hello:
    handler: src/handlers.hello
    environment: {FN_LABEL: api}
    events:
      - http: GET /hello
  tick:
    handler: src/handlers.job
    events:
      - schedule: 5 minutes
      - schedule: {rate: 7 minutes, input: {r: 1}}
      - schedule: {cron: "0 1 * * *", enabled: false}
  jobs:
    handler: src/handlers.job
    events:
      - queue: {name: jobs, batchSize: 4, deadLetter: jobs-dlq}
      - topic: {name: events, filter: {type: ["created"]}}
      - storage: {bucket: uploads, events: [created], prefix: in/, suffix: .txt}
`;

describe("on-premises provider", () => {
  test("metadata", () => {
    const p = new OnpremProvider();
    expect(p.name).toBe("onprem");
    expect(p.displayName).toBe("On-premises");
    expect(p.tier).toBe("beta");
    expect(p.defaultRegion).toBe("local");
    expect(p.terraformLocalName).toBe("docker");
    expect([...p.capabilities].sort()).toEqual(["http", "queue", "schedule", "storage", "topic"]);
  });

  test("process engine cannot start Redis or MinIO, and auth must be checkable", () => {
    const redis = makeProject(`
service: demo
provider: {name: onprem, options: {queue: redis}}
functions:
  w: {handler: src/handlers.job, events: [{queue: jobs}]}
`);
    expect(errors(redis).join("\n")).toContain("cannot start Redis or MinIO");

    const auth = makeProject(`
service: demo
provider: {name: onprem}
functions:
  w: {handler: src/handlers.hello, events: [{http: {path: /x, auth: iam}}, {http: {path: /y, auth: key}}]}
`);
    const joined = errors(auth).join("\n");
    expect(joined).toContain("auth `iam`");
    expect(joined).toContain("options.api_key");

    const junk = makeProject(`
service: demo
provider: {name: onprem, options: {engine: kubernetes, storage_endpoint: http://minio:9000}}
functions:
  w: {handler: src/handlers.job, events: [{storage: uploads}]}
`);
    const bad = errors(junk).join("\n");
    expect(bad).toContain("options.engine");
    expect(bad).toContain("storage_access_key");
  });

  test("render process mode", async () => {
    const project = makeProject(CONFIG);
    expect(errors(project)).toEqual([]);
    const { tf } = await render(project);
    expect(tf.terraform.required_providers).toEqual({});
    expect(tf.provider).toBeUndefined();
    const data = tf.resource.terraform_data.onprem;
    expect(data.triggers_replace).toHaveLength(2);
    expect(data.input.endpoint).toBe("http://127.0.0.1:8090");
    expect(data.provisioner[0]["local-exec"].command).toBe("node onprem/launch.mjs");
    expect(data.provisioner[1]["local-exec"].when).toBe("destroy");
    expect(data.provisioner[1]["local-exec"].command).toBe("node onprem/stop.mjs");

    const platform = JSON.parse(readFileSync(path.join(project.workDir, "onprem", "platform.json"), "utf-8"));
    expect(platform.processEnv.FOO).toBe("${hello}");
    expect(platform.processEnv.NSKIT_PROVIDER).toBe("onprem");
    expect(platform.functions.hello.environment.FN_LABEL).toBe("api");
    expect(platform.services.queue.kind).toBe("builtin");
    expect(platform.services.topic.kind).toBe("builtin");
    expect(platform.services.storage.kind).toBe("builtin");
    expect(platform.schedules.map((s: { name: string }) => s.name)).toEqual(["tick-0", "tick-1"]);
    expect(platform.schedules[1].cron).toBeUndefined();
    expect(platform.schedules[1].everySeconds).toBe(420);
    expect(existsSync(path.join(project.workDir, "onprem", "supervisor.mjs"))).toBe(true);
    expect(readFileSync(path.join(project.workDir, "onprem", "launch.mjs"), "utf-8")).not.toContain("\r\n");

    const out = tf.output.nskit.value;
    expect(out.endpoint).toBe("http://127.0.0.1:8090");
    expect(out.functions.hello.url).toBe("http://127.0.0.1:8090/hello");
    expect(out.functions.hello.base_url).toBe(out.endpoint);
    expect(out.functions.tick.url).toBeNull();
    expect(out.functions.tick.base_url).toBeUndefined();
  });

  test("render docker engine and keep user strings out of Terraform templates", async () => {
    const project = makeProject(CONFIG.replace("name: onprem", "name: onprem\n  options: {engine: docker, queue: redis, topic: redis, storage: minio, minio_password: s3cret}").replace(
      "options: {http_port: 8090, publish: \"127.0.0.1\"}",
      "",
    ));
    expect(errors(project)).toEqual([]);
    const { tf } = await render(project);
    expect(tf.terraform.required_providers.docker).toMatchObject({ source: "kreuzwerker/docker", version: "~> 3.0" });
    expect(tf.resource.docker_container.platform.network_mode).toBeUndefined();
    expect(tf.resource.docker_container.platform.networks_advanced[0].aliases).toEqual(["platform"]);
    expect(tf.resource.docker_container.platform.entrypoint).toEqual(["node"]);
    expect(tf.resource.docker_container.redis).toBeDefined();
    expect(tf.resource.docker_container.minio.env.join("\n")).toContain("MINIO_ROOT_PASSWORD=s3cret");
    const env = tf.resource.docker_container.platform.env as string[];
    expect(env.some((line) => line.startsWith("NSKIT_PLATFORM_HASH="))).toBe(true);
    expect(env).toContain("FOO=$${hello}");
    expect(tf.resource.docker_container.platform.depends_on).toEqual(["docker_container.redis", "docker_container.minio"]);
    const platform = JSON.parse(readFileSync(path.join(project.workDir, "onprem", "platform.json"), "utf-8"));
    expect(platform.entry).toBe("/opt/nskit/app/index.js");
    expect(platform.services.queue).toMatchObject({ kind: "redis", url: "redis://redis:6379" });
    expect(platform.services.storage.kind).toBe("s3");
    expect(platform.services.storage.endpoint).toBe("http://minio:9000");
  });

  test("drops terraform.extra when asked and points storage at a directory inside Docker", async () => {
    const project = makeProject(`
service: demo
provider:
  name: onprem
  options: {engine: docker, storage: "dir:./objects", drop_terraform_extra: true}
  terraform:
    extra:
      resource:
        aws_dynamodb_table:
          orders: {name: orders}
functions:
  files:
    handler: src/handlers.job
    events: [{storage: {bucket: uploads, events: [created]}}]
`);
    expect(errors(project)).toEqual([]);
    const { tf } = await render(project);
    expect(tf.resource.aws_dynamodb_table).toBeUndefined();
    const platform = JSON.parse(readFileSync(path.join(project.workDir, "onprem", "platform.json"), "utf-8"));
    expect(platform.services.storage).toEqual({ kind: "dir", path: "/var/lib/nskit/objects" });
    const volumes = tf.resource.docker_container.platform.volumes as { container_path: string }[];
    expect(volumes.some((v) => v.container_path === "/var/lib/nskit/objects")).toBe(true);
  });
});
