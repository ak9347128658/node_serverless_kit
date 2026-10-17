/**
 * Azure: one Linux Function App per service + stage (Node.js v4 programming model).
 *
 * The bundle's generated entry calls `register(app, [...])` from
 * `runtime/adapters/azure.ts` with `require("@azure/functions").app`, so every
 * trigger becomes one Azure function inside the app:
 *
 * - `http`     -> `app.http` (`host.json` sets `routePrefix: ""` so configured paths are served without `/api`)
 * - `schedule` -> `app.timer` (NCRONTAB, UTC)
 * - `queue`    -> `app.storageQueue` on a Storage Queue in the app's storage account
 * - `storage`  -> `app.storageBlob` on a container in the app's storage account (created/updated blobs)
 * - `topic`    -> `app.serviceBusTopic` (Service Bus namespace + topic + one subscription per function)
 *
 * `@azure/functions` is installed into the artifact's node_modules (and kept
 * external by esbuild). Workflows run on the embedded engine.
 *
 * Plans (`options.plan_sku`): `Y1` (Linux Consumption, default; Node <= 22, deployed with a
 * remote build), `FC1` (Flex Consumption: `azurerm_function_app_flex_consumption`, Node 20-24),
 * or an Elastic Premium / Dedicated SKU (`EP1`, `B1`, `P1v3`, ...; run from package).
 *
 * Options: `subscription_id` (or `ARM_SUBSCRIPTION_ID`), `resource_group` (existing), `plan_sku`,
 * `app_insights` (default true), `storage_connection` (app-setting name for `existing` queues /
 * containers in another account), `servicebus_namespace_id` + `servicebus_connection` (for
 * `existing` topics), `instance_memory_in_mb` / `maximum_instance_count` (Flex Consumption only).
 */

import { corsOf, eventsOf, memoryOf, timeoutOf, type FunctionConfig, type ServiceConfig } from "../config/schema.js";
import type { BundleManifest } from "../runtime/manifest.js";
import type { AzureRegistration } from "../runtime/adapters/azure.js";
import {
  HTTP,
  Issue,
  Provider,
  QUEUE,
  SCHEDULE,
  STORAGE,
  TOPIC,
  stableSuffix,
  type BundleTarget,
  type Capability,
  type EntryContext,
  type RenderContext,
} from "./base.js";
import * as sched from "./schedule.js";
import { escape, ref, tfId, type TerraformDoc } from "./terraform-doc.js";

const LINUX_APP = "azurerm_linux_function_app";
const FLEX_APP = "azurerm_function_app_flex_consumption";
const PER_FUNCTION_ENV = new Set(["NSKIT_FUNCTION", "NSKIT_HANDLER"]);
const STORAGE_NAME = /^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/;
export const DEFAULT_CONNECTION = "AzureWebJobsStorage";
export const SERVICEBUS_SETTING = "NSKIT_SERVICEBUS";
export const AZURE_FUNCTIONS_VERSION = "^4.16.5";
const ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
/** Newest Node.js major on Linux Consumption (no new versions are added to that plan). */
const Y1_MAX_NODE = 22;
const FLEX_DEPLOY_CONTAINER = "nskit-deployments";

/** `/files/{path+}` -> `files/{*path}` (Azure route template, no leading slash). */
export function azureRoute(path: string): string {
  return path.replace(/^\/+|\/+$/g, "").replace(/\{(\w+)\+\}/g, "{*$1}");
}

function hms(seconds: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}

/** Azure function names: letters, digits and `_` (hyphens break `AzureWebJobs.<name>.Disabled` on Linux). */
function functionIdent(text: string): string {
  const ident = text.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z]/.test(ident) ? ident : "f_" + ident;
}

function nodeMajor(runtime: string): number {
  return Number(runtime.replace(/\D/g, "")) || 0;
}

/** Flex Consumption instance size (512, 2048 or 4096 MB) that fits the largest configured `memory`. */
function flexMemory(config: ServiceConfig): number {
  const largest = Math.max(config.provider.memory, ...Object.values(config.functions).map((fn) => memoryOf(config, fn)));
  return largest <= 512 ? 512 : largest <= 2048 ? 2048 : 4096;
}

export type AzurePlan = "consumption" | "flex" | "dedicated";

export function planKind(sku: string): AzurePlan {
  const s = sku.toUpperCase();
  if (s === "Y1") return "consumption";
  if (s === "FC1") return "flex";
  return "dedicated";
}

export class AzureProvider extends Provider {
  readonly name = "azure";
  readonly displayName = "Azure Functions";
  override readonly tier = "beta";
  readonly terraformSource = "hashicorp/azurerm";
  override readonly terraformVersion = ">= 4.9";
  override readonly terraformLocalName = "azurerm";
  override readonly defaultRegion = "eastus";
  override readonly capabilities = new Set<Capability>([HTTP, SCHEDULE, QUEUE, STORAGE, TOPIC]);
  override readonly maxNameLength = 60;
  override readonly namePattern = /[^a-z0-9-]/g;
  override readonly runtimes = { nodejs20: "20", nodejs22: "22", nodejs24: "24" };
  override readonly maxTimeout = 600;
  override readonly notes =
    "One Linux Function App per service (Node.js v4 model); Consumption (Y1) by default, Flex Consumption with plan_sku FC1. " +
    "Workflows use the embedded engine.";
  override readonly bundle: BundleTarget = { format: "cjs", platform: "node", entryFile: "index.js", external: ["@azure/functions"] };
  override readonly dependencies = { "@azure/functions": AZURE_FUNCTIONS_VERSION };

  // ------------------------------------------------------------------ naming
  appName(service: string, stage: string): string {
    const base = this.physicalName(service, stage, "");
    return `${base.slice(0, 51).replace(/-+$/, "")}-${stableSuffix([service, stage, "func"], 8)}`;
  }

  static subscriptionName(fn: string): string {
    return fn.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 50);
  }

  private static sku(config: ServiceConfig): string {
    return String(config.provider.options.plan_sku ?? "Y1");
  }

  // ------------------------------------------------------------------ bundle
  /** One registration per trigger (plus a private POST route for invoke-only functions). */
  registrations(config: ServiceConfig): AzureRegistration[] {
    const opts = config.provider.options;
    const storageConn = (existing: boolean) => (existing ? String(opts.storage_connection ?? DEFAULT_CONNECTION) : DEFAULT_CONNECTION);
    const used = new Set<string>();
    const unique = (base: string): string => {
      const ident = functionIdent(base);
      let candidate = ident;
      for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${ident}_${n}`;
      used.add(candidate.toLowerCase());
      return candidate;
    };
    const regs: AzureRegistration[] = [];
    for (const [name, fn] of Object.entries(config.functions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      fn.events.forEach((spec, i) => {
        const ident = unique(`${name}_${spec.type}_${i}`);
        switch (spec.type) {
          case "http": {
            const c = spec.config;
            regs.push({
              kind: "http",
              name: ident,
              function: name,
              route: azureRoute(c.path),
              methods: c.method === "ANY" ? [...ALL_METHODS] : [c.method],
              authLevel: c.auth === "key" ? "function" : "anonymous",
            });
            break;
          }
          case "schedule":
            regs.push({
              kind: "timer",
              name: ident,
              function: name,
              schedule: sched.ncrontab(spec.config),
              ...(spec.config.input !== undefined ? { input: spec.config.input } : {}),
              ...(spec.config.enabled ? {} : { disabled: true }),
            });
            break;
          case "queue":
            regs.push({
              kind: "queue",
              name: ident,
              function: name,
              queueName: spec.config.name,
              connection: storageConn(spec.config.existing),
            });
            break;
          case "storage": {
            const c = spec.config;
            regs.push({
              kind: "blob",
              name: ident,
              function: name,
              path: `${c.bucket}/${c.prefix ?? ""}{name}${c.suffix ?? ""}`,
              container: c.bucket,
              connection: storageConn(c.existing),
            });
            break;
          }
          case "topic":
            regs.push({
              kind: "topic",
              name: ident,
              function: name,
              topicName: spec.config.name,
              subscriptionName: AzureProvider.subscriptionName(name),
              connection: spec.config.existing ? String(opts.servicebus_connection ?? SERVICEBUS_SETTING) : SERVICEBUS_SETTING,
            });
            break;
        }
      });
      if (!fn.events.length) {
        // Invoke-only functions (invoke(), external callers) get a private POST route.
        regs.push({
          kind: "http",
          name: unique(`${name}_invoke`),
          function: name,
          route: `_nskit/invoke/${name}`,
          methods: ["POST"],
          authLevel: "function",
        });
      }
    }
    return regs;
  }

  entryCode(ctx: EntryContext): string {
    const regs = this.registrations(ctx.config);
    return [
      `import { register as __nskitRegister } from ${JSON.stringify(ctx.runtime("adapters/azure"))};`,
      "",
      "// Node.js v4 programming model: package.json `main` points at this bundle, which registers every",
      "// trigger on import. `@azure/functions` is installed into node_modules by nskit (esbuild external).",
      `__nskitRegister(require("@azure/functions").app, ${JSON.stringify(regs, null, 2)});`,
    ].join("\n");
  }

  override extraFiles(config: ServiceConfig, _manifest: BundleManifest): Record<string, string> {
    const fns = Object.values(config.functions);
    const timeout = Math.max(config.provider.timeout, ...fns.map((fn) => timeoutOf(config, fn)));
    const host: Record<string, unknown> = {
      version: "2.0",
      extensionBundle: { id: "Microsoft.Azure.Functions.ExtensionBundle", version: "[4.*, 5.0.0)" },
      functionTimeout: hms(Math.min(timeout, this.maxTimeout)),
      logging: { logLevel: { default: "Information" } },
    };
    const extensions: Record<string, unknown> = { http: { routePrefix: "" } };
    const queues = fns.flatMap((fn) => eventsOf(fn, "queue"));
    if (queues.length) extensions.queues = { maxDequeueCount: Math.max(...queues.map((q) => q.maxReceive)) };
    host.extensions = extensions;
    return {
      "host.json": JSON.stringify(host, null, 2) + "\n",
      "package.json": JSON.stringify({ main: this.bundle.entryFile }, null, 2) + "\n",
    };
  }

  // ------------------------------------------------------------------ validation
  override providerBlock(ctx: RenderContext): Record<string, unknown> {
    const block: Record<string, unknown> = { features: {} };
    if (ctx.opt("subscription_id")) block.subscription_id = ctx.opt("subscription_id");
    return block;
  }

  override extraValidation(config: ServiceConfig): Issue[] {
    const issues: Issue[] = [];
    const opts = config.provider.options;
    const sku = AzureProvider.sku(config);
    const plan = planKind(sku);
    const hasEnv = (key: string) => {
      const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
      return Boolean(proc?.env?.[key]);
    };
    if (!opts.subscription_id && !hasEnv("ARM_SUBSCRIPTION_ID")) {
      issues.push(
        new Issue(
          "warning",
          "azurerm needs a subscription id: set options.subscription_id or ARM_SUBSCRIPTION_ID before deploying",
          "provider.options.subscription_id",
        ),
      );
    }
    if (config.provider.iam.statements.length) {
      issues.push(new Issue("warning", "iam.statements are AWS-style and ignored on Azure", "provider.iam"));
    }
    const runtime = config.provider.runtime;
    if (plan === "consumption" && nodeMajor(runtime) > Y1_MAX_NODE) {
      issues.push(
        new Issue(
          "error",
          `Linux Consumption (plan_sku Y1) supports Node.js up to ${Y1_MAX_NODE}; use plan_sku FC1 (Flex Consumption) ` +
            `or a Premium/Dedicated plan for ${runtime}`,
          "provider.runtime",
        ),
      );
    }
    if (nodeMajor(runtime) === 20) {
      issues.push(new Issue("warning", "Node.js 20 reached end of support on Azure Functions (2026-04-30); use nodejs22", "provider.runtime"));
    }
    if (plan !== "flex" && (opts.instance_memory_in_mb !== undefined || opts.maximum_instance_count !== undefined)) {
      issues.push(
        new Issue("warning", "instance_memory_in_mb / maximum_instance_count only apply to plan_sku FC1", "provider.options"),
      );
    }
    const envSeen = new Map<string, string>();
    for (const [name, fn] of Object.entries(config.functions)) {
      const where = `functions.${name}`;
      if (fn.runtime && fn.runtime !== runtime) {
        issues.push(
          new Issue("error", "all functions share one Function App, so they run the same Node.js version; remove functions.*.runtime", where),
        );
      }
      for (const [key, value] of Object.entries(fn.environment)) {
        if (envSeen.has(key) && envSeen.get(key) !== value) {
          issues.push(
            new Issue(
              "warning",
              `environment ${key} differs between functions; Azure app settings are shared by the whole Function App (last one wins)`,
              where,
            ),
          );
        }
        envSeen.set(key, value);
      }
      if (fn.concurrency !== null && fn.concurrency !== undefined) {
        issues.push(new Issue("warning", "concurrency is per Function App on Azure and is ignored", where));
      }
      for (const ev of eventsOf(fn, "http")) {
        if (ev.auth === "iam" || ev.auth === "jwt") {
          issues.push(
            new Issue(
              "error",
              `http auth '${ev.auth}' is not supported on Azure; use none or key (or put API Management / Easy Auth in front)`,
              where,
            ),
          );
        }
        const route = azureRoute(ev.path);
        if (!route) {
          issues.push(new Issue("error", "Azure Functions cannot route the root path '/' to a function; use a non-root path", where));
        } else if (/^admin(\/|$)/i.test(route)) {
          issues.push(new Issue("error", `path ${ev.path} is reserved by the Azure Functions host (/admin)`, where));
        }
      }
      for (const ev of eventsOf(fn, "schedule")) {
        if (ev.timezone.toUpperCase() !== "UTC") {
          issues.push(new Issue("warning", "Linux Function App timers run in UTC; timezone is ignored", where));
        }
      }
      for (const ev of eventsOf(fn, "queue")) {
        if (!STORAGE_NAME.test(ev.name)) {
          issues.push(new Issue("error", `queue name '${ev.name}' must be 3-63 lowercase letters, digits, dashes`, where));
        }
        if (ev.fifo) issues.push(new Issue("warning", "Storage Queues are not FIFO; queue.fifo is ignored", where));
        if (ev.deadLetter) {
          issues.push(
            new Issue("warning", "Storage Queues move poison messages to '<queue>-poison'; deadLetter is ignored", where),
          );
        }
      }
      for (const ev of eventsOf(fn, "storage")) {
        if (!STORAGE_NAME.test(ev.bucket)) {
          issues.push(new Issue("error", `container name '${ev.bucket}' must be 3-63 lowercase letters, digits, dashes`, where));
        }
        if (ev.events.includes("deleted")) {
          issues.push(new Issue("error", "Azure blob triggers only fire on created/updated blobs", where));
        }
        if (plan === "flex") {
          issues.push(
            new Issue(
              "error",
              "Flex Consumption only supports Event Grid based blob triggers, which nskit does not provision; use plan_sku Y1 or a Premium plan",
              where,
            ),
          );
        }
      }
      for (const ev of eventsOf(fn, "topic")) {
        if (ev.existing && !(opts.servicebus_namespace_id && opts.servicebus_connection)) {
          issues.push(
            new Issue(
              "error",
              "existing topics need options.servicebus_namespace_id and options.servicebus_connection (name of an app setting)",
              where,
            ),
          );
        }
        if (ev.filter) issues.push(new Issue("warning", "topic.filter is not applied on Azure Service Bus subscriptions", where));
      }
    }
    return issues;
  }

  // ------------------------------------------------------------------ render
  renderResources(doc: TerraformDoc, ctx: RenderContext): void {
    const cfg = ctx.config;
    const loc = ctx.region;
    const tags = ctx.tags();
    const sku = AzureProvider.sku(cfg);
    const plan = planKind(sku);

    const rg = ctx.opt<string>("resource_group")
      ? doc.data("azurerm_resource_group", "rg", { name: escape(String(ctx.opt("resource_group"))) })
      : doc.resource("azurerm_resource_group", "rg", { name: `${ctx.prefix}-rg`, location: loc, tags });
    const rgName = ref(rg, "name");

    const saBase = ctx.prefix.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "nskit";
    const sa = doc.resource("azurerm_storage_account", "app", {
      name: saBase + stableSuffix([ctx.prefix, loc], 8),
      resource_group_name: rgName,
      location: loc,
      account_tier: "Standard",
      account_replication_type: "LRS",
      min_tls_version: "TLS1_2",
      tags,
    });
    const servicePlan = doc.resource("azurerm_service_plan", "plan", {
      name: `${ctx.prefix}-plan`,
      resource_group_name: rgName,
      location: loc,
      os_type: "Linux",
      sku_name: sku,
      tags,
    });

    const siteConfig: Record<string, unknown> = {};
    if (ctx.opt("app_insights", true)) {
      const law = doc.resource("azurerm_log_analytics_workspace", "logs", {
        name: `${ctx.prefix}-logs`,
        resource_group_name: rgName,
        location: loc,
        sku: "PerGB2018",
        retention_in_days: Math.max(30, cfg.provider.logRetentionDays ?? 30),
        tags,
      });
      const ai = doc.resource("azurerm_application_insights", "ai", {
        name: `${ctx.prefix}-ai`,
        resource_group_name: rgName,
        location: loc,
        workspace_id: ref(law, "id"),
        application_type: "web",
        tags,
      });
      siteConfig.application_insights_connection_string = ref(ai, "connection_string");
    }
    const cors = Object.values(cfg.functions)
      .flatMap((fn) => eventsOf(fn, "http"))
      .map(corsOf)
      .filter((c) => c !== undefined);
    if (cors.length) {
      siteConfig.cors = {
        allowed_origins: [...new Set(cors.flatMap((c) => c.origins))].sort(),
        support_credentials: cors.some((c) => c.allowCredentials),
      };
    }

    const settings: Record<string, string> = {};
    if (plan === "consumption") {
      // Linux Consumption does not support WEBSITE_RUN_FROM_PACKAGE=1: zip deploy goes through a remote build.
      settings.SCM_DO_BUILD_DURING_DEPLOYMENT = "true";
    } else if (plan === "dedicated") {
      settings.WEBSITE_RUN_FROM_PACKAGE = "1";
    }
    for (const [name, fn] of ctx.functionItems()) {
      for (const [key, value] of Object.entries(ctx.environment(name, fn))) {
        if (!PER_FUNCTION_ENV.has(key)) settings[key] = escape(value);
      }
    }
    for (const reg of this.registrations(cfg)) {
      // Disabled schedules: the host ignores functions with AzureWebJobs.<name>.Disabled=true.
      if (reg.kind === "timer" && reg.disabled) settings[`AzureWebJobs.${reg.name}.Disabled`] = "true";
    }

    this.messaging(doc, ctx, sa, rgName, settings);

    const appName = this.appName(ctx.service, ctx.stage);
    const common = {
      name: appName,
      resource_group_name: rgName,
      location: loc,
      service_plan_id: ref(servicePlan, "id"),
      https_only: true,
      zip_deploy_file: "${path.module}/artifact.zip",
      app_settings: settings,
      site_config: siteConfig,
      tags,
    };
    let app: string;
    if (plan === "flex") {
      const container = doc.resource("azurerm_storage_container", "deployments", {
        name: FLEX_DEPLOY_CONTAINER,
        storage_account_id: ref(sa, "id"),
        container_access_type: "private",
      });
      app = doc.resource(FLEX_APP, "app", {
        ...common,
        storage_container_type: "blobContainer",
        storage_container_endpoint: ref(sa, "primary_blob_endpoint") + ref(container, "name"),
        storage_authentication_type: "StorageAccountConnectionString",
        storage_access_key: ref(sa, "primary_access_key"),
        runtime_name: "node",
        runtime_version: this.runtimeId(cfg.provider.runtime),
        instance_memory_in_mb: Number(ctx.opt("instance_memory_in_mb", flexMemory(cfg))),
        ...(ctx.opt("maximum_instance_count") !== undefined ? { maximum_instance_count: Number(ctx.opt("maximum_instance_count")) } : {}),
      });
    } else {
      app = doc.resource(LINUX_APP, "app", {
        ...common,
        storage_account_name: ref(sa, "name"),
        storage_account_access_key: ref(sa, "primary_access_key"),
        functions_extension_version: "~4",
        // application_stack.node_version also sets FUNCTIONS_WORKER_RUNTIME=node.
        site_config: { ...siteConfig, application_stack: { node_version: this.runtimeId(cfg.provider.runtime) } },
      });
    }
    const host = "https://" + ref(app, "default_hostname");

    const fnOut: Record<string, Record<string, unknown>> = {};
    for (const [name, fn] of ctx.functionItems()) {
      const out: Record<string, unknown> = {
        id: `${appName}/${name}`,
        console: "https://portal.azure.com/#resource" + ref(app, "id") + "/functions",
      };
      const httpEvents = eventsOf(fn, "http");
      if (httpEvents.length) {
        out.base_url = host;
        out.url = host + "/" + azureRoute(httpEvents[0].path);
      }
      fnOut[name] = out;
    }
    const wfOut: Record<string, unknown> = {};
    for (const name of Object.keys(cfg.workflows).sort()) {
      const orch = cfg.functions[`${name}-orchestrator`] as FunctionConfig | undefined;
      const http = orch ? eventsOf(orch, "http")[0] : undefined;
      wfOut[name] = { id: `${appName}/${name}-orchestrator`, ...(http ? { url: host + "/" + azureRoute(http.path) } : {}) };
    }
    doc.output("nskit", { functions: fnOut, workflows: wfOut, endpoint: host }, { description: "node_serverless_kit deployment summary" });
  }

  /** Storage queues, blob containers and Service Bus resources. */
  private messaging(doc: TerraformDoc, ctx: RenderContext, sa: string, rgName: string, settings: Record<string, string>): void {
    for (const [, fn] of ctx.functionItems()) {
      for (const ev of eventsOf(fn, "queue")) {
        if (!ev.existing && !doc.hasResource("azurerm_storage_queue", `q-${ev.name}`)) {
          doc.resource("azurerm_storage_queue", `q-${ev.name}`, { name: ev.name, storage_account_id: ref(sa, "id") });
        }
      }
      for (const ev of eventsOf(fn, "storage")) {
        if (!ev.existing && !doc.hasResource("azurerm_storage_container", `b-${ev.bucket}`)) {
          doc.resource("azurerm_storage_container", `b-${ev.bucket}`, {
            name: ev.bucket,
            storage_account_id: ref(sa, "id"),
            container_access_type: "private",
          });
        }
      }
    }
    let ns: string | undefined;
    for (const [name, fn] of ctx.functionItems()) {
      for (const ev of eventsOf(fn, "topic")) {
        const label = `t-${ev.name}`;
        let topic: string;
        if (ev.existing) {
          topic = doc.data("azurerm_servicebus_topic", label, {
            name: ev.name,
            namespace_id: escape(String(ctx.opt("servicebus_namespace_id"))),
          });
        } else {
          if (!ns) {
            ns = doc.resource("azurerm_servicebus_namespace", "bus", {
              name: `${ctx.prefix.slice(0, 40).replace(/-+$/, "")}-${stableSuffix([ctx.prefix, "bus"], 6)}`,
              resource_group_name: rgName,
              location: ctx.region,
              sku: "Standard",
              tags: ctx.tags(),
            });
            settings[SERVICEBUS_SETTING] = ref(ns, "default_primary_connection_string");
          }
          if (!doc.hasResource("azurerm_servicebus_topic", label)) {
            doc.resource("azurerm_servicebus_topic", label, { name: ev.name, namespace_id: ref(ns, "id") });
          }
          topic = `azurerm_servicebus_topic.${tfId(label)}`;
        }
        doc.resource("azurerm_servicebus_subscription", `${name}-${ev.name}`, {
          name: AzureProvider.subscriptionName(name),
          topic_id: ref(topic, "id"),
          max_delivery_count: 10,
        });
      }
    }
  }
}
