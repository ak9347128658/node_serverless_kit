/**
 * Decide which on-premises backing services to deploy.
 *
 * A queue, topic or object store is either started with the service (`builtin`,
 * or `redis` / `minio` which deploy a container) or taken from a URL already
 * running on the network. HTTP routes and schedules never need an extra service.
 */

import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eventsOf, runtimeOf, type FunctionConfig, type ServiceConfig } from "../config/schema.js";
import { resolveNodeBinary } from "../onprem/runtime.mjs";
import { Issue } from "./base.js";
import * as sched from "./schedule.js";

export type Engine = "process" | "docker";
export type DeployMode = "local" | "ssh" | "bundle";
export type RuntimeMode = "auto" | "system" | "bundled" | "docker";
export type ServiceMode = "process" | "systemd";
export type TargetOs = "linux" | "windows";
export type SystemdScope = "user" | "system";

export interface ServiceRef {
  kind: "builtin" | "http" | "redis" | "s3" | "dir" | "none";
  url?: string;
  path?: string;
  endpoint?: string;
  accessKey?: string;
  secretKey?: string;
  region?: string;
  /** True when nskit creates the container during deploy. */
  managed?: boolean;
}

export interface OnpremPlan {
  engine: Engine;
  /** Where the files go: this machine, a server over SSH, or a folder you carry. */
  deploy: DeployMode;
  /** What runs the functions once the files are on the server. */
  runtime: RuntimeMode;
  service: ServiceMode;
  targetOs: TargetOs;
  systemdScope: SystemdScope;
  host: string;
  sshUser: string;
  sshPort: number;
  sshKey: string;
  sshStrict: boolean;
  remoteDir: string;
  nodeBinary: string;
  httpHost: string;
  httpPort: number;
  publish: string;
  nodeImage: string;
  redisImage: string;
  minioImage: string;
  minioUser: string;
  minioPassword: string;
  apiKey: string;
  dockerHost: string;
  dataDirName: string;
  queue: ServiceRef;
  topic: ServiceRef;
  storage: ServiceRef;
  deployRedis: boolean;
  deployMinio: boolean;
  usesBuiltin: boolean;
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

export function option(options: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = options[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function flag(value: unknown): boolean {
  const raw = text(value).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function splitSshHost(raw: string): { user: string; host: string } {
  const at = raw.lastIndexOf("@");
  if (at <= 0) return { user: "", host: raw };
  return { user: raw.slice(0, at), host: raw.slice(at + 1) };
}

/** True when Redis or MinIO containers are started for this plan. */
export function containersOnTarget(plan: OnpremPlan): boolean {
  return plan.engine === "docker" || (plan.deploy !== "local" && plan.runtime === "docker");
}

function needed(config: ServiceConfig, kind: "queue" | "topic" | "storage"): boolean {
  return Object.values(config.functions).some((fn) => eventsOf(fn, kind).length > 0);
}

function parseRef(raw: unknown, role: "queue" | "topic" | "storage", neededRole: boolean, options: Record<string, unknown>): ServiceRef {
  const value = text(raw);
  if (!neededRole && !value) return { kind: "none" };
  if (!value || value === "builtin") return { kind: "builtin" };
  if (value === "redis") {
    if (role === "storage") return { kind: "builtin" };
    return { kind: "redis", url: "redis://redis:6379", managed: true };
  }
  if (value === "minio") {
    if (role !== "storage") return { kind: "builtin" };
    return {
      kind: "s3",
      endpoint: "http://minio:9000",
      accessKey: text(option(options, "minio_user", "minioUser")) || "nskit",
      secretKey: text(option(options, "minio_password", "minioPassword")) || "nskit-onprem-change-me",
      region: text(option(options, "storage_region", "storageRegion")) || "us-east-1",
      managed: true,
    };
  }
  if (/^rediss?:\/\//i.test(value)) return { kind: "redis", url: value, managed: false };
  if (/^https?:\/\//i.test(value)) return { kind: "http", url: value.replace(/\/+$/, ""), managed: false };
  if (role === "storage" && /^dir:/i.test(value)) {
    return { kind: "dir", path: value.slice(4), managed: false };
  }
  if (role === "storage" && /^file:/i.test(value)) {
    let filePath: string;
    try {
      filePath = fileURLToPath(value);
    } catch {
      filePath = value.replace(/^file:\/\//i, "");
    }
    return { kind: "dir", path: filePath, managed: false };
  }
  return { kind: "builtin" };
}

export function planOnprem(config: ServiceConfig): OnpremPlan {
  const options = config.provider.options;
  const engine = text(option(options, "engine")) === "docker" ? "docker" : "process";
  const deployRaw = text(option(options, "deploy"));
  const deploy: DeployMode = deployRaw === "ssh" || deployRaw === "bundle" ? deployRaw : "local";
  const runtimeRaw = text(option(options, "runtime"));
  let runtime: RuntimeMode;
  if (runtimeRaw === "auto" || runtimeRaw === "system" || runtimeRaw === "bundled" || runtimeRaw === "docker") runtime = runtimeRaw;
  else if (engine === "docker") runtime = "docker";
  else if (deploy === "local") runtime = "system";
  else runtime = "auto";
  const service: ServiceMode = text(option(options, "service")) === "systemd" ? "systemd" : "process";
  const targetOs: TargetOs = text(option(options, "target_os", "targetOs")) === "windows" ? "windows" : "linux";
  const systemdScope: SystemdScope = text(option(options, "systemd_scope", "systemdScope")) === "system" ? "system" : "user";
  const split = splitSshHost(text(option(options, "host")));
  const sshUser = text(option(options, "ssh_user", "sshUser")) || split.user;
  const host = split.host;
  const portRaw = option(options, "ssh_port", "sshPort");
  const sshPort = portRaw === undefined ? 22 : Number(portRaw);
  const nodeBinary = text(option(options, "node_binary", "nodeBinary"));
  const remoteDir = text(option(options, "remote_dir", "remoteDir"));
  let publish = text(option(options, "publish"));
  if (!publish) publish = deploy === "ssh" && host ? host : "127.0.0.1";
  const port = Number(option(options, "http_port", "httpPort") ?? 8080);
  const queue = parseRef(option(options, "queue"), "queue", needed(config, "queue"), options);
  const topic = parseRef(option(options, "topic"), "topic", needed(config, "topic"), options);
  let storage = parseRef(option(options, "storage"), "storage", needed(config, "storage"), options);
  const endpoint = text(option(options, "storage_endpoint", "storageEndpoint"));
  if (needed(config, "storage") && endpoint && (storage.kind === "builtin" || storage.kind === "none")) {
    storage = {
      kind: "s3",
      endpoint,
      accessKey: text(option(options, "storage_access_key", "storageAccessKey")),
      secretKey: text(option(options, "storage_secret_key", "storageSecretKey")),
      region: text(option(options, "storage_region", "storageRegion")) || "us-east-1",
      managed: false,
    };
  }
  if (storage.kind === "dir" && !storage.path) storage = { kind: "dir", path: text(option(options, "storage_dir", "storageDir")), managed: false };
  const usesBuiltin = [queue, topic, storage].some((ref) => ref.kind === "builtin");
  return {
    engine,
    deploy,
    runtime,
    service,
    targetOs,
    systemdScope,
    host,
    sshUser,
    sshPort: Number.isFinite(sshPort) ? sshPort : 0,
    sshKey: text(option(options, "ssh_key", "sshKey")),
    sshStrict: flag(option(options, "ssh_strict", "sshStrict")),
    remoteDir,
    nodeBinary,
    httpHost: text(option(options, "http_host", "httpHost")) || "0.0.0.0",
    httpPort: Number.isFinite(port) && port > 0 ? port : 8080,
    publish,
    nodeImage: text(option(options, "node_image", "nodeImage")) || "node:22-bookworm-slim",
    redisImage: text(option(options, "redis_image", "redisImage")) || "redis:7-alpine",
    minioImage: text(option(options, "minio_image", "minioImage")) || "minio/minio:RELEASE.2025-04-22T22-12-26Z",
    minioUser: text(option(options, "minio_user", "minioUser")) || "nskit",
    minioPassword: text(option(options, "minio_password", "minioPassword")) || "nskit-onprem-change-me",
    apiKey: text(option(options, "api_key", "apiKey")),
    dockerHost: text(option(options, "docker_host", "dockerHost")),
    dataDirName: "data",
    queue,
    topic,
    storage,
    deployRedis: queue.managed === true || topic.managed === true,
    deployMinio: storage.managed === true,
    usesBuiltin,
  };
}

function oneOf(raw: string, allowed: string[]): boolean {
  return raw === "" || allowed.includes(raw);
}

function shellSafe(value: string): boolean {
  return value === "" || (!/[\r\n\0$`;&|<>"'\\\s]/.test(value) && !value.split("/").includes(".."));
}

export function validateOnprem(config: ServiceConfig): Issue[] {
  const issues: Issue[] = [];
  const plan = planOnprem(config);
  const options = config.provider.options;
  const engineRaw = text(option(options, "engine"));
  const deployRaw = text(option(options, "deploy"));
  const runtimeRaw = text(option(options, "runtime"));
  const serviceRaw = text(option(options, "service"));
  const osRaw = text(option(options, "target_os", "targetOs"));
  const scopeRaw = text(option(options, "systemd_scope", "systemdScope"));
  if (engineRaw && plan.engine !== engineRaw) {
    issues.push(new Issue("error", "options.engine must be `process` or `docker`", "provider.options.engine"));
  }
  if (!oneOf(deployRaw, ["local", "ssh", "bundle"])) {
    issues.push(new Issue("error", "options.deploy must be `local`, `ssh` or `bundle`", "provider.options.deploy"));
  }
  if (!oneOf(runtimeRaw, ["auto", "system", "bundled", "docker"])) {
    issues.push(new Issue("error", "options.runtime must be `auto`, `system`, `bundled` or `docker`", "provider.options.runtime"));
  }
  if (!oneOf(serviceRaw, ["process", "systemd"])) {
    issues.push(new Issue("error", "options.service must be `process` or `systemd`", "provider.options.service"));
  }
  if (!oneOf(osRaw, ["linux", "windows"])) {
    issues.push(new Issue("error", "options.target_os must be `linux` or `windows`", "provider.options.target_os"));
  }
  if (!oneOf(scopeRaw, ["user", "system"])) {
    issues.push(new Issue("error", "options.systemd_scope must be `user` or `system`", "provider.options.systemd_scope"));
  }
  if (engineRaw === "docker" && plan.deploy !== "local") {
    issues.push(
      new Issue(
        "error",
        "engine docker starts containers on the machine that runs Terraform. To use Docker on the server, set deploy: ssh or deploy: bundle and runtime: docker",
        "provider.options.engine",
      ),
    );
  }
  if (plan.engine === "docker" && plan.runtime !== "docker") {
    issues.push(
      new Issue(
        "error",
        "engine docker supplies Node.js inside the image. Leave runtime unset, or set runtime: docker",
        "provider.options.runtime",
      ),
    );
  }
  if (plan.deploy === "local" && plan.runtime === "docker" && plan.engine !== "docker") {
    issues.push(new Issue("error", "runtime docker on this machine is engine: docker", "provider.options.runtime"));
  }
  if ((plan.deployRedis || plan.deployMinio) && !containersOnTarget(plan)) {
    issues.push(
      new Issue(
        "error",
        "engine `process` cannot start Redis or MinIO. Set queue/topic/storage to a URL you already run, leave them as `builtin`, set engine: docker, or set deploy: ssh (or bundle) with runtime: docker",
        "provider.options.engine",
      ),
    );
  }
  if (plan.deploy === "ssh" && !plan.host) {
    issues.push(new Issue("error", "deploy ssh needs options.host (a hostname, or user@host)", "provider.options.host"));
  }
  if (plan.host && !/^[A-Za-z0-9._-]+$/.test(plan.host)) {
    issues.push(new Issue("error", "options.host must be a hostname or address. Set the port with options.ssh_port", "provider.options.host"));
  }
  if (plan.sshUser && !/^[A-Za-z0-9._-]+$/.test(plan.sshUser)) {
    issues.push(new Issue("error", "options.ssh_user must be a single account name", "provider.options.ssh_user"));
  }
  if (plan.sshPort !== 22 && (!Number.isInteger(plan.sshPort) || plan.sshPort < 1 || plan.sshPort > 65535)) {
    issues.push(new Issue("error", "options.ssh_port must be an integer from 1 to 65535", "provider.options.ssh_port"));
  }
  if (/[\r\n\0]/.test(plan.sshKey)) {
    issues.push(new Issue("error", "options.ssh_key is a path to a private key, not the key text", "provider.options.ssh_key"));
  }
  if (!shellSafe(plan.remoteDir)) {
    issues.push(
      new Issue(
        "error",
        "options.remote_dir cannot contain spaces, quotes or shell characters. Use forward slashes",
        "provider.options.remote_dir",
      ),
    );
  }
  if (plan.service === "systemd" && plan.deploy === "local") {
    issues.push(
      new Issue(
        "error",
        "service systemd is installed on the target server. Set deploy: ssh or deploy: bundle",
        "provider.options.service",
      ),
    );
  }
  if (plan.service === "systemd" && plan.targetOs === "windows") {
    issues.push(
      new Issue(
        "error",
        "service systemd is Linux only. On Windows the process is started in the background",
        "provider.options.service",
      ),
    );
  }
  if (plan.runtime === "bundled" && !plan.nodeBinary) {
    issues.push(
      new Issue(
        "error",
        "runtime bundled needs options.node_binary, a Node.js 18+ executable for the server. nskit does not download Node. Python is not used.",
        "provider.options.node_binary",
      ),
    );
  }
  if (plan.nodeBinary) {
    if (/[\r\n\0]/.test(plan.nodeBinary)) {
      issues.push(new Issue("error", "options.node_binary must be a file path", "provider.options.node_binary"));
    } else {
      const resolved = resolveNodeBinary(plan.nodeBinary);
      if (!existsSync(resolved) || !statSync(resolved).isFile()) {
        issues.push(
          new Issue(
            "error",
            "options.node_binary must be a Node.js executable, or a directory containing bin/node or node.exe. nskit does not download or extract Node.",
            "provider.options.node_binary",
          ),
        );
      }
    }
    if (plan.runtime === "system" || plan.runtime === "docker") {
      issues.push(new Issue("warning", "options.node_binary is unused unless runtime is bundled or auto", "provider.options.node_binary"));
    }
  }
  if (plan.deploy !== "local") {
    const fields: [string, string][] = [
      ["publish", plan.publish],
      ["node_image", plan.nodeImage],
      ["redis_image", plan.redisImage],
      ["minio_image", plan.minioImage],
      ["minio_user", plan.deployMinio ? plan.minioUser : ""],
      ["minio_password", plan.deployMinio ? plan.minioPassword : ""],
      ["storage path", plan.storage.path || ""],
    ];
    for (const [name, value] of fields) {
      if (/[\r\n"\\]/.test(value)) {
        issues.push(
          new Issue(
            "error",
            `options.${name} cannot contain quotes, backslashes or newlines when deploy is ${plan.deploy}. Use forward slashes`,
            "provider.options",
          ),
        );
      }
    }
    if (plan.runtime === "auto" && plan.storage.kind === "dir") {
      issues.push(
        new Issue(
          "warning",
          "runtime auto uses Docker only when the server has no Node.js. A dir: store is not mounted into that container. Set runtime: system or runtime: docker",
          "provider.options.storage",
        ),
      );
    }
  }
  for (const [role, ref] of [
    ["queue", plan.queue],
    ["topic", plan.topic],
    ["storage", plan.storage],
  ] as const) {
    const raw = text(option(options, role));
    if (raw && ref.kind === "builtin" && raw !== "builtin") {
      issues.push(
        new Issue(
          "error",
          `options.${role} must be builtin, redis, minio, a redis:// or http(s):// URL${role === "storage" ? ", or dir:/path" : ""}`,
          `provider.options.${role}`,
        ),
      );
    }
  }
  if (plan.storage.kind === "s3" && !plan.storage.managed && (!plan.storage.accessKey || !plan.storage.secretKey)) {
    issues.push(
      new Issue(
        "error",
        "storage_endpoint needs storage_access_key and storage_secret_key",
        "provider.options.storage_endpoint",
      ),
    );
  }
  const runtimes = new Set(Object.values(config.functions).map((fn) => runtimeOf(config, fn)));
  if (runtimes.size > 1) {
    issues.push(
      new Issue(
        "warning",
        `on-premises runs one Node.js process for every function (${[...runtimes].sort().join(", ")} requested). With engine docker, set options.node_image`,
        "provider.runtime",
      ),
    );
  }
  if (plan.deployMinio && plan.minioPassword === "nskit-onprem-change-me") {
    issues.push(new Issue("warning", "MinIO is using the default password; set options.minio_password before a shared deploy", "provider.options.minio_password"));
  }
  for (const [name, fn] of Object.entries(config.functions)) {
    for (const ev of eventsOf(fn, "http")) {
      if (ev.auth === "iam" || ev.auth === "jwt") {
        issues.push(
          new Issue(
            "error",
            `auth \`${ev.auth}\` has no on-premises provider. Use auth: key (options.api_key) or check tokens in the handler`,
            `functions.${name}`,
          ),
        );
      }
      if (ev.auth === "key") {
        const own = text((ev.authorizer || {}).key);
        if (!own && !plan.apiKey) {
          issues.push(new Issue("error", "auth: key needs options.api_key or authorizer.key", `functions.${name}`));
        }
      }
    }
    for (const ev of eventsOf(fn, "schedule")) {
      if (ev.timezone && ev.timezone !== "UTC") {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: ev.timezone });
        } catch {
          issues.push(new Issue("error", `unknown schedule timezone ${JSON.stringify(ev.timezone)}`, `functions.${name}`));
        }
      }
      if (ev.cron) {
        try {
          sched.toCron5(ev);
        } catch (err) {
          issues.push(new Issue("error", (err as Error).message, `functions.${name}`));
        }
      }
    }
    if (Object.keys(fn.options).length) {
      issues.push(
        new Issue(
          "warning",
          "on-premises runs every function in one process; functions.*.options are not applied to a separate resource",
          `functions.${name}`,
        ),
      );
    }
    if (eventsOf(fn, "queue").some((ev) => ev.fifo)) {
      issues.push(
        new Issue(
          "warning",
          "on-premises queues keep order per queue; they are not exactly-once FIFO. fifo is accepted and ignored",
          `functions.${name}`,
        ),
      );
    }
  }
  return issues;
}

export function scheduleSpecs(config: ServiceConfig): Record<string, unknown>[] {
  const specs: Record<string, unknown>[] = [];
  for (const [name, fn] of Object.entries(config.functions)) {
    eventsOf(fn, "schedule").forEach((ev, index) => {
      if (!ev.enabled) return;
      const spec: Record<string, unknown> = {
        function: name,
        name: ev.name || `${name}-${index}`,
        timezone: ev.timezone || "UTC",
        input: ev.input ?? null,
        enabled: true,
      };
      if (ev.rate) spec.everySeconds = sched.toSeconds(ev);
      try {
        spec.cron = sched.toCron5(ev);
      } catch (err) {
        if (!ev.rate) throw err;
      }
      specs.push(spec);
    });
  }
  return specs.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function queueSpecs(config: ServiceConfig, timeoutOf: (fn: FunctionConfig) => number): Record<string, unknown>[] {
  const specs: Record<string, unknown>[] = [];
  for (const [name, fn] of Object.entries(config.functions)) {
    for (const ev of eventsOf(fn, "queue")) {
      specs.push({
        function: name,
        name: ev.name,
        batchSize: ev.batchSize,
        batchWindow: ev.batchWindow,
        visibilityTimeout: ev.visibilityTimeout ?? timeoutOf(fn),
        deadLetter: ev.deadLetter ?? "",
        maxReceive: ev.maxReceive,
        timeout: timeoutOf(fn),
      });
    }
  }
  return specs.sort((a, b) => String(a.function).localeCompare(String(b.function)) || String(a.name).localeCompare(String(b.name)));
}
