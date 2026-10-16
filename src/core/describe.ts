/** Builds the deployment record that powers `nskit info` and the dashboard. */

import path from "node:path";
import {
  architectureOf,
  functionKind,
  memoryOf,
  runtimeOf,
  taskFunctions,
  timeoutOf,
  type EventSpec,
  type FunctionConfig,
} from "../config/schema.js";
import { ORCHESTRATOR_HANDLER } from "../providers/base.js";
import { VERSION } from "../version.js";
import type { Project } from "./project.js";

export const RECORD_FILE = "deployment.json";

export interface EventSummary {
  type: string;
  summary: string;
  [key: string]: unknown;
}

export interface FunctionRecord {
  name: string;
  resourceName: string;
  handler: string;
  description: string;
  kind: string;
  generated: boolean;
  runtime: string;
  memory: number;
  timeout: number;
  architecture: string;
  events: EventSummary[];
  environmentKeys: string[];
  id?: string | null;
  arn?: string | null;
  url?: string | null;
  urls: { method: string; url: string }[];
  console?: string | null;
}

export interface WorkflowRecord {
  name: string;
  description: string;
  engine: string;
  startAt: string;
  states: Record<string, string>;
  functions: string[];
  id?: string | null;
  url?: string | null;
  console?: string | null;
}

export interface DeploymentRecord {
  schema: 1;
  status: "deployed" | "removed" | "packaged";
  service: string;
  stage: string;
  provider: string;
  providerDisplay: string;
  providerTier: string;
  region: string;
  endpoint?: string | null;
  deployedAt: string;
  nskitVersion: string;
  configFile: string;
  artifact: Record<string, unknown>;
  functions: FunctionRecord[];
  workflows: WorkflowRecord[];
  outputs: Record<string, unknown>;
}

export function eventSummary(ev: EventSpec): EventSummary {
  switch (ev.type) {
    case "http": {
      const c = ev.config;
      return { type: "http", summary: `${c.method} ${c.path}`, method: c.method, path: c.path, auth: c.auth, cors: Boolean(c.cors) };
    }
    case "schedule": {
      const c = ev.config;
      return {
        type: "schedule",
        summary: c.rate ? `rate(${c.rate})` : `cron(${c.cron})`,
        rate: c.rate ?? null,
        cron: c.cron ?? null,
        enabled: c.enabled,
        timezone: c.timezone,
      };
    }
    case "queue": {
      const c = ev.config;
      return { type: "queue", summary: `queue ${c.name} (batch ${c.batchSize})`, name: c.name, batchSize: c.batchSize, existing: c.existing };
    }
    case "storage": {
      const c = ev.config;
      const filt = [c.prefix ? ` prefix=${c.prefix}` : "", c.suffix ? ` suffix=${c.suffix}` : ""].join("");
      return {
        type: "storage",
        summary: `bucket ${c.bucket} [${c.events.join(", ")}]${filt}`,
        bucket: c.bucket,
        events: [...c.events],
        prefix: c.prefix ?? null,
        suffix: c.suffix ?? null,
      };
    }
    case "topic": {
      const c = ev.config;
      return { type: "topic", summary: `topic ${c.name}`, name: c.name, existing: c.existing };
    }
  }
}

type Out = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function functionRecord(project: Project, name: string, fn: FunctionConfig, out: Out): FunctionRecord {
  const cfg = project.config;
  const events = fn.events.map(eventSummary);
  const baseUrl = str(out.base_url);
  const urls = baseUrl
    ? events.filter((e) => e.type === "http").map((e) => ({ method: String(e.method), url: baseUrl.replace(/\/+$/, "") + String(e.path) }))
    : [];
  return {
    name,
    resourceName: project.provider.physicalName(cfg.service, cfg.provider.stage, name),
    handler: fn.handler,
    description: fn.description,
    kind: functionKind(fn),
    generated: fn.handler === ORCHESTRATOR_HANDLER,
    runtime: runtimeOf(cfg, fn),
    memory: memoryOf(cfg, fn),
    timeout: timeoutOf(cfg, fn),
    architecture: architectureOf(cfg, fn),
    events,
    environmentKeys: [...new Set([...Object.keys(cfg.provider.environment), ...Object.keys(fn.environment)])].sort(),
    id: str(out.id),
    arn: str(out.arn),
    url: str(out.url),
    urls,
    console: str(out.console),
  };
}

export function buildRecord(
  project: Project,
  outputs: Record<string, unknown> = {},
  artifact: Record<string, unknown> = {},
  status: DeploymentRecord["status"] = "deployed",
): DeploymentRecord {
  const nskitOut = (outputs.nskit ?? {}) as Out;
  const fnOut = (nskitOut.functions ?? {}) as Record<string, Out>;
  const wfOut = (nskitOut.workflows ?? {}) as Record<string, Out>;
  const cfg = project.config;
  const functions = Object.entries(cfg.functions)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, fn]) => functionRecord(project, name, fn, fnOut[name] ?? {}));
  const workflows = Object.entries(cfg.workflows)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, wf]): WorkflowRecord => {
      const out = wfOut[name] ?? {};
      return {
        name,
        description: wf.description,
        engine: project.engines[name] ?? "native",
        startAt: wf.startAt,
        states: Object.fromEntries(Object.entries(wf.states).map(([k, v]) => [k, v.type])),
        functions: [...new Set(taskFunctions(wf))].sort(),
        id: str(out.id),
        url: str(out.url),
        console: str(out.console),
      };
    });
  const rest = Object.fromEntries(Object.entries(outputs).filter(([k]) => k !== "nskit"));
  return {
    schema: 1,
    status,
    service: cfg.service,
    stage: cfg.provider.stage,
    provider: cfg.provider.name,
    providerDisplay: project.provider.displayName,
    providerTier: project.provider.tier,
    region: project.region,
    endpoint: str(nskitOut.endpoint),
    deployedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    nskitVersion: VERSION,
    configFile: path.basename(project.loaded.path),
    artifact,
    functions,
    workflows,
    outputs: rest,
  };
}
