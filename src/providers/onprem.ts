/**
 * On-premises.
 *
 * One Node.js process serves every function. HTTP is the process itself.
 * Schedules are timers in that process. Queues, topics and object storage use
 * a built-in broker that deploys with the service, or a service named in
 * `provider.options` (`redis://`, `http://`, `dir:`, `minio`, `redis`).
 *
 * `options.engine`:
 * - `process` (default) starts Node on this machine. Terraform tracks it with
 *   `terraform_data` and a background supervisor. No Docker and no cloud account.
 * - `docker` runs the same supervisor in a container (`kreuzwerker/docker`) and
 *   can start Redis or MinIO beside it.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eventsOf, type FunctionConfig, type ServiceConfig } from "../config/schema.js";
import {
  HTTP,
  Provider,
  QUEUE,
  SCHEDULE,
  STORAGE,
  TOPIC,
  type BundleTarget,
  type Capability,
  type EntryContext,
  type RenderContext,
} from "./base.js";
import { option, planOnprem, queueSpecs, scheduleSpecs, validateOnprem, type OnpremPlan, type ServiceRef } from "./onprem-plan.js";
import { escape, TerraformDoc } from "./terraform-doc.js";

const PLATFORM_DIR = "onprem";
const SCRIPT_FILES = ["supervisor.mjs", "broker.mjs", "redis.mjs", "s3.mjs", "launch.mjs", "stop.mjs"];

export function onpremScriptDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../onprem"),
    path.resolve(here, "../src/onprem"),
    path.resolve(here, "../../src/onprem"),
    path.resolve(here, "onprem"),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, "supervisor.mjs"))) return dir;
  }
  throw new Error("on-premises platform scripts are missing from the package");
}

function dockerPath(file: string): string {
  return path.resolve(file).replace(/\\/g, "/");
}

function serviceJson(ref: ServiceRef): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: ref.kind };
  if (ref.url) out.url = ref.url;
  if (ref.path) out.path = ref.path;
  if (ref.endpoint) out.endpoint = ref.endpoint;
  if (ref.accessKey) out.accessKey = ref.accessKey;
  if (ref.secretKey) out.secretKey = ref.secretKey;
  if (ref.region) out.region = ref.region;
  return out;
}

export class OnpremProvider extends Provider {
  readonly name = "onprem";
  readonly displayName = "On-premises";
  override readonly tier = "beta";
  readonly terraformSource = "kreuzwerker/docker";
  override readonly terraformVersion = "~> 3.0";
  override readonly terraformLocalName = "docker";
  override readonly defaultRegion = "local";
  override readonly capabilities = new Set<Capability>([HTTP, SCHEDULE, QUEUE, STORAGE, TOPIC]);
  override readonly maxNameLength = 63;
  override readonly runtimes = { nodejs18: "nodejs18", nodejs20: "nodejs20", nodejs22: "nodejs22", nodejs24: "nodejs24" };
  override readonly maxTimeout = 3600;
  override readonly notes =
    "Runs on a machine you control. HTTP and schedules need nothing else. Queues, topics and " +
    "storage use a built-in broker unless options.queue / topic / storage names Redis, MinIO, " +
    "a directory or an http:// URL. engine: process (default) or docker.";
  override readonly bundle: BundleTarget = { format: "cjs", platform: "node", entryFile: "index.js" };

  override initDoc(ctx: RenderContext): TerraformDoc {
    if (planOnprem(ctx.config).engine === "process") {
      const doc = new TerraformDoc();
      doc.requiredVersion(ctx.config.provider.terraform.requiredVersion);
      const state = ctx.config.provider.state;
      if (state.backend) doc.backend(state.backend, state.config);
      return doc;
    }
    return super.initDoc(ctx);
  }

  override providerBlock(ctx: RenderContext): Record<string, unknown> | undefined {
    const host = planOnprem(ctx.config).dockerHost;
    return host ? { host: escape(host) } : {};
  }

  override render(ctx: RenderContext): TerraformDoc {
    const doc = this.initDoc(ctx);
    this.renderResources(doc, ctx);
    if (!option(ctx.config.provider.options, "drop_terraform_extra", "dropTerraformExtra")) {
      const extra = ctx.config.provider.terraform.extra;
      if (Object.keys(extra).length) doc.merge(extra);
    }
    return doc;
  }

  entryCode(ctx: EntryContext): string {
    return `export { handler } from ${JSON.stringify(ctx.runtime("adapters/onprem"))};`;
  }

  override extraFiles(): Record<string, string> {
    return { "package.json": JSON.stringify({ main: this.bundle.entryFile }, null, 2) + "\n" };
  }

  override extraValidation(config: ServiceConfig) {
    return validateOnprem(config);
  }

  // ---------------------------------------------------------------- platform files

  platformDocument(ctx: RenderContext, plan: OnpremPlan): Record<string, unknown> {
    const functions: Record<string, unknown> = {};
    for (const [name, fn] of ctx.functionItems()) {
      functions[name] = {
        timeout: ctx.timeoutOf(fn),
        memory: ctx.memoryOf(fn),
        environment: ctx.environment(name, fn),
        routes: eventsOf(fn, "http").map((ev) => ({
          method: ev.method,
          path: ev.path,
          auth: ev.auth,
          key: typeof ev.authorizer.key === "string" ? ev.authorizer.key : "",
        })),
      };
    }
    const storage = { ...plan.storage };
    if (plan.engine === "docker" && storage.kind === "dir") storage.path = "/var/lib/nskit/objects";
    if (plan.engine === "docker" && storage.kind === "builtin") {
      /* data dir is the container path; the broker reads platform.dataDir */
    }
    const workflows: Record<string, unknown> = {};
    for (const name of Object.keys(ctx.config.workflows).sort()) workflows[name] = { orchestrator: `${name}-orchestrator` };
    return {
      service: ctx.service,
      stage: ctx.stage,
      provider: "onprem",
      region: ctx.region,
      entry: plan.engine === "docker" ? "/opt/nskit/app/index.js" : dockerPath(path.join(ctx.artifact.buildDir, ctx.artifact.entryFile)),
      dataDir: plan.engine === "docker" ? "/var/lib/nskit" : dockerPath(path.join(ctx.workDir, PLATFORM_DIR, plan.dataDirName)),
      pollMs: Number(ctx.opt("poll_ms", 1000)) || 1000,
      apiKey: plan.apiKey,
      http: { host: plan.httpHost, port: plan.httpPort },
      processEnv: {
        NSKIT_PROVIDER: "onprem",
        NSKIT_SERVICE: ctx.service,
        NSKIT_STAGE: ctx.stage,
        NSKIT_REGION: ctx.region,
        ...ctx.config.provider.environment,
        ...(plan.queue.kind === "http" && plan.queue.url ? { NSKIT_QUEUE_URL: plan.queue.url } : {}),
        ...(plan.topic.kind === "http" && plan.topic.url ? { NSKIT_TOPIC_URL: plan.topic.url } : {}),
        ...(plan.storage.kind === "http" && plan.storage.url ? { NSKIT_STORAGE_URL: plan.storage.url } : {}),
      },
      functions,
      workflows,
      schedules: scheduleSpecs(ctx.config),
      queues: queueSpecs(ctx.config, (fn: FunctionConfig) => ctx.timeoutOf(fn)),
      topics: topicSpecs(ctx.config),
      storage: storageSpecs(ctx.config),
      services: {
        queue: serviceJson(plan.queue),
        topic: serviceJson(plan.topic),
        storage: serviceJson(storage),
      },
    };
  }

  writePlatform(ctx: RenderContext, plan: OnpremPlan): { dir: string; json: string; hash: string } {
    const dir = path.join(ctx.workDir, PLATFORM_DIR);
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(dir, plan.dataDirName), { recursive: true });
    const scripts = onpremScriptDir();
    for (const file of SCRIPT_FILES) {
      const text = readFileSync(path.join(scripts, file), "utf8").replace(/\r\n/g, "\n");
      writeFileSync(path.join(dir, file), text.endsWith("\n") ? text : text + "\n");
    }
    const document = this.platformDocument(ctx, plan);
    const json = JSON.stringify(document, null, 2) + "\n";
    writeFileSync(path.join(dir, "platform.json"), json);
    const hash = createHash("sha256").update(json).digest("hex");
    return { dir, json, hash };
  }

  // ---------------------------------------------------------------- terraform

  renderResources(doc: TerraformDoc, ctx: RenderContext): void {
    const plan = planOnprem(ctx.config);
    const written = this.writePlatform(ctx, plan);
    if (plan.engine === "docker") this.renderDocker(doc, ctx, plan, written);
    else this.renderProcess(doc, ctx, plan, written);
    this.renderOutput(doc, ctx, plan);
  }

  private renderProcess(doc: TerraformDoc, ctx: RenderContext, plan: OnpremPlan, written: { dir: string; hash: string }): void {
    const pid = dockerPath(path.join(written.dir, "supervisor.pid"));
    const platformFile = dockerPath(path.join(written.dir, "platform.json"));
    const entry = dockerPath(path.join(ctx.artifact.buildDir, ctx.artifact.entryFile));
    const dataDir = dockerPath(path.join(written.dir, plan.dataDirName));
    doc.resource("terraform_data", "onprem", {
      triggers_replace: [ctx.artifact.sha256, written.hash],
      input: { endpoint: `http://${plan.publish}:${plan.httpPort}`, pidfile: pid },
      provisioner: [
        {
          "local-exec": {
            working_dir: "${path.module}",
            command: "node onprem/launch.mjs",
            environment: {
              NSKIT_PLATFORM: platformFile,
              NSKIT_ENTRY: entry,
              NSKIT_PIDFILE: pid,
              NSKIT_DATA_DIR: dataDir,
            },
          },
        },
        {
          "local-exec": {
            when: "destroy",
            working_dir: "${path.module}",
            command: "node onprem/stop.mjs",
            environment: { NSKIT_PIDFILE: pid },
          },
        },
      ],
    });
  }

  private renderDocker(doc: TerraformDoc, ctx: RenderContext, plan: OnpremPlan, written: { dir: string; hash: string }): void {
    const network = doc.resource("docker_network", "nskit", { name: ctx.prefix.replace(/-$/, "") || "nskit", driver: "bridge" });
    const node = doc.resource("docker_image", "node", { name: plan.nodeImage, keep_locally: true });
    const env = [
      `NSKIT_PLATFORM=/opt/nskit/platform/platform.json`,
      `NSKIT_ENTRY=/opt/nskit/app/index.js`,
      `NSKIT_DATA_DIR=/var/lib/nskit`,
    ];
    env.push(`NSKIT_PLATFORM_HASH=${written.hash}`);
    for (const [key, value] of Object.entries(ctx.config.provider.environment).sort(([a], [b]) => a.localeCompare(b))) {
      env.push(`${key}=${escape(value)}`);
    }
    const volumes: Record<string, unknown>[] = [
      { host_path: dockerPath(ctx.artifact.buildDir), container_path: "/opt/nskit/app" },
      { host_path: dockerPath(written.dir), container_path: "/opt/nskit/platform" },
      { host_path: dockerPath(path.join(written.dir, plan.dataDirName)), container_path: "/var/lib/nskit" },
    ];
    if (plan.storage.kind === "dir" && plan.storage.path) {
      volumes.push({ host_path: dockerPath(plan.storage.path), container_path: "/var/lib/nskit/objects" });
    }
    const depends: string[] = [];
    if (plan.deployRedis) {
      const image = doc.resource("docker_image", "redis", { name: plan.redisImage, keep_locally: true });
      depends.push(doc.resource("docker_container", "redis", this.container(ctx, "redis", image, network, ["redis"], {
        command: ["redis-server", "--save", "", "--appendonly", "no"],
        restart: "unless-stopped",
      })));
    }
    if (plan.deployMinio) {
      const image = doc.resource("docker_image", "minio", { name: plan.minioImage, keep_locally: true });
      mkdirSync(path.join(written.dir, "minio"), { recursive: true });
      depends.push(doc.resource("docker_container", "minio", this.container(ctx, "minio", image, network, ["minio"], {
        command: ["server", "/data", "--console-address", ":9001"],
        env: [`MINIO_ROOT_USER=${escape(plan.minioUser)}`, `MINIO_ROOT_PASSWORD=${escape(plan.minioPassword)}`],
        volumes: [{ host_path: dockerPath(path.join(written.dir, "minio")), container_path: "/data" }],
        restart: "unless-stopped",
      })));
    }
    let memory = 0;
    for (const [, fn] of ctx.functionItems()) memory = Math.max(memory, ctx.memoryOf(fn));
    const platform = this.container(ctx, "platform", node, network, ["platform"], {
      entrypoint: ["node"],
      command: ["/opt/nskit/platform/supervisor.mjs"],
      working_dir: "/opt/nskit/app",
      env,
      volumes,
      memory: memory || undefined,
      ports: [{ internal: plan.httpPort, external: plan.httpPort, ip: plan.publish, protocol: "tcp" }],
      restart: "unless-stopped",
    });
    if (depends.length) platform.depends_on = depends;
    doc.resource("docker_container", "platform", platform);
  }

  private container(
    ctx: RenderContext,
    role: string,
    image: string,
    network: string,
    aliases: string[],
    body: Record<string, unknown>,
  ): Record<string, unknown> {
    const labels = Object.entries(ctx.tags()).map(([label, value]) => ({ label, value: escape(String(value)) }));
    return {
      name: ctx.physicalName(role),
      image: `\${${image}.image_id}`,
      networks_advanced: [{ name: `\${${network}.name}`, aliases }],
      labels,
      ...body,
    };
  }

  private renderOutput(doc: TerraformDoc, ctx: RenderContext, plan: OnpremPlan): void {
    const endpoint = `http://${plan.publish}:${plan.httpPort}`;
    const functions: Record<string, unknown> = {};
    for (const [name, fn] of ctx.functionItems()) {
      const routes = eventsOf(fn, "http");
      const url = routes.length ? endpoint + routes[0].path : null;
      const record: Record<string, unknown> = { id: ctx.physicalName(name), url, console: null };
      if (url) record.base_url = endpoint;
      functions[name] = record;
    }
    const workflows: Record<string, unknown> = {};
    for (const name of Object.keys(ctx.config.workflows).sort()) {
      workflows[name] = { id: ctx.physicalName(`${name}-orchestrator`), engine: "embedded" };
    }
    doc.output("nskit", { functions, workflows, endpoint }, { description: "node_serverless_kit deployment summary" });
  }
}

function topicSpecs(config: ServiceConfig): Record<string, unknown>[] {
  const specs: Record<string, unknown>[] = [];
  for (const [name, fn] of Object.entries(config.functions)) {
    for (const ev of eventsOf(fn, "topic")) {
      specs.push({ function: name, name: ev.name, filter: ev.filter ?? null });
    }
  }
  return specs.sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.function).localeCompare(String(b.function)));
}

function storageSpecs(config: ServiceConfig): Record<string, unknown>[] {
  const specs: Record<string, unknown>[] = [];
  for (const [name, fn] of Object.entries(config.functions)) {
    for (const ev of eventsOf(fn, "storage")) {
      specs.push({
        function: name,
        bucket: ev.bucket,
        events: ev.events,
        prefix: ev.prefix ?? "",
        suffix: ev.suffix ?? "",
        existing: ev.existing,
      });
    }
  }
  return specs.sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)) || String(a.function).localeCompare(String(b.function)));
}
