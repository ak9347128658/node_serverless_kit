/**
 * Decide which on-premises backing services to deploy.
 *
 * A queue, topic or object store is either started with the service (`builtin`,
 * or `redis` / `minio` which deploy a container) or taken from a URL already
 * running on the network. HTTP routes and schedules never need an extra service.
 */

import { fileURLToPath } from "node:url";
import { eventsOf, runtimeOf, type FunctionConfig, type ServiceConfig } from "../config/schema.js";
import { Issue } from "./base.js";
import * as sched from "./schedule.js";

export type Engine = "process" | "docker";

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
    httpHost: text(option(options, "http_host", "httpHost")) || "0.0.0.0",
    httpPort: Number.isFinite(port) && port > 0 ? port : 8080,
    publish: text(option(options, "publish")) || "127.0.0.1",
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

export function validateOnprem(config: ServiceConfig): Issue[] {
  const issues: Issue[] = [];
  const plan = planOnprem(config);
  const options = config.provider.options;
  if (text(option(options, "engine")) && plan.engine !== text(option(options, "engine"))) {
    issues.push(new Issue("error", "options.engine must be `process` or `docker`", "provider.options.engine"));
  }
  if (plan.engine === "process" && (plan.deployRedis || plan.deployMinio)) {
    issues.push(
      new Issue(
        "error",
        "engine `process` cannot start Redis or MinIO. Set queue/topic/storage to a URL you already run, leave them as `builtin`, or set engine: docker",
        "provider.options.engine",
      ),
    );
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
