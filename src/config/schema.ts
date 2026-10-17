/**
 * Typed model of `nskit.yml`.
 *
 * The model is intentionally provider-neutral. Anything that only makes sense
 * for one cloud goes under an `options:` mapping, which the matching provider
 * renderer reads and the others ignore.
 *
 * Keys are camelCase. snake_case spellings (`batch_size`, `start_at`, ...) are
 * accepted too, so configs written for py-serverless-kit port over easily.
 */

import { z } from "zod";

export const PROVIDERS = [
  "aws",
  "azure",
  "gcp",
  "alibaba",
  "oracle",
  "ibm",
  "digitalocean",
  "tencent",
  "huawei",
  "cloudflare",
  "onprem",
] as const;
export type BuiltinProvider = (typeof PROVIDERS)[number];

export const EVENT_KINDS = ["http", "schedule", "queue", "storage", "topic"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ANY"] as const;
export const HOOKS = [
  "beforePackage",
  "afterPackage",
  "beforeDeploy",
  "afterDeploy",
  "beforeRemove",
  "afterRemove",
] as const;

/** Node.js major versions node_serverless_kit knows about (provider support varies). */
export const NODE_RUNTIMES = ["nodejs18", "nodejs20", "nodejs22", "nodejs24"] as const;
export type NodeRuntime = (typeof NODE_RUNTIMES)[number];
export const PREFERRED_RUNTIME: NodeRuntime = "nodejs22";

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
// `src/orders.getOrder`, `handlers/index.default`, `lib/api.handlers.list` (export path after the module).
const HANDLER_RE = /^[A-Za-z0-9_@~][\w@~./-]*?\.[A-Za-z_$][\w$]*$/;
export const RATE_RE = /^\s*(\d+)\s+(minute|minutes|hour|hours|day|days)\s*$/i;
const PATH_TEMPLATE_RE = /^(\/([\w.~-]+|\{[A-Za-z_]\w*\}))*(\/\{[A-Za-z_]\w*\+\})?\/?$/;

// ------------------------------------------------------------------ helpers

export function camelCase(key: string): string {
  return key.replace(/[_-]([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Rename snake_case / kebab-case keys to the camelCase key the shape defines. */
function normalizeKeys(raw: unknown, keys: Set<string>): unknown {
  if (!isRecord(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const c = camelCase(k);
    out[keys.has(c) ? c : k] = v;
  }
  return out;
}

/** A strict object (unknown keys are errors) that also accepts snake_case keys. */
function obj<T extends z.ZodRawShape>(shape: T) {
  const keys = new Set(Object.keys(shape));
  return z.preprocess((raw) => normalizeKeys(raw, keys), z.strictObject(shape));
}

/** Environment / tag values are strings; objects and arrays become JSON (not "[object Object]"). */
function stringValue(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

// Whole-value variables such as `${env:ENABLED, true}` resolve to strings;
// accept "true"/"false" and numeric strings where booleans and numbers are expected.
function bool() {
  return z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean());
}

function num<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v), schema);
}

const stringMap = z.preprocess(
  (v) =>
    isRecord(v)
      ? Object.fromEntries(Object.entries(v).map(([k, val]) => [String(k), stringValue(val)]))
      : v ?? {},
  z.record(z.string(), z.string()),
);
const anyMap = z.record(z.string(), z.unknown());

// ------------------------------------------------------------------ events

export const CorsConfig = obj({
  origins: z.array(z.string()).default(() => ["*"]),
  methods: z.array(z.string()).nullish(),
  headers: z.array(z.string()).nullish(),
  exposeHeaders: z.array(z.string()).default(() => []),
  allowCredentials: bool().default(false),
  maxAge: num(z.number().int().nonnegative()).default(600),
});
export type CorsConfig = z.infer<typeof CorsConfig>;

export const HttpEvent = obj({
  path: z
    .string()
    .default("/")
    .transform((v) => "/" + v.trim().replace(/^\/+/, ""))
    .refine((v) => !v.includes("{") || PATH_TEMPLATE_RE.test(v), {
      message: "invalid path template; use /users/{id} or /files/{path+}",
    }),
  method: z
    .string()
    .default("GET")
    .transform((v) => (v.toUpperCase() === "*" ? "ANY" : v.toUpperCase()))
    .refine((v) => (HTTP_METHODS as readonly string[]).includes(v), {
      message: `method must be one of ${HTTP_METHODS.join(", ")}`,
    }),
  cors: z.union([bool(), CorsConfig]).default(false),
  auth: z.enum(["none", "iam", "jwt", "key"]).default("none"),
  authorizer: anyMap.default(() => ({})),
});
export type HttpEvent = z.infer<typeof HttpEvent>;

export function corsOf(ev: HttpEvent): CorsConfig | undefined {
  if (ev.cors === true) return CorsConfig.parse({});
  if (ev.cors && typeof ev.cors === "object") return ev.cors;
  return undefined;
}

export const ScheduleEvent = obj({
  rate: z.string().nullish(),
  cron: z.string().nullish(),
  input: z.unknown().optional(),
  enabled: bool().default(true),
  timezone: z.string().default("UTC"),
  name: z.string().nullish(),
}).superRefine((v, ctx) => {
  if (Boolean(v.rate) === Boolean(v.cron)) {
    ctx.addIssue({ code: "custom", message: "schedule needs exactly one of `rate` (e.g. '5 minutes') or `cron` (5 fields)" });
  }
  if (v.rate && !RATE_RE.test(v.rate)) {
    ctx.addIssue({ code: "custom", message: "rate must look like '<n> minutes|hours|days'", path: ["rate"] });
  }
  if (v.cron && v.cron.trim().split(/\s+/).length !== 5) {
    ctx.addIssue({ code: "custom", message: "cron must be a standard 5-field expression: 'min hour dom month dow'", path: ["cron"] });
  }
});
export type ScheduleEvent = z.infer<typeof ScheduleEvent>;

export const QueueEvent = obj({
  name: z.string().min(1),
  existing: bool().default(false),
  batchSize: num(z.number().int().min(1).max(10000)).default(10),
  /** Seconds to wait to fill a batch. */
  batchWindow: num(z.number().int().min(0).max(300)).default(0),
  visibilityTimeout: num(z.number().int().positive()).nullish(),
  /** Queue receiving messages after `maxReceive` failed deliveries. */
  deadLetter: z.string().nullish(),
  maxReceive: num(z.number().int().positive()).default(5),
  fifo: bool().default(false),
});
export type QueueEvent = z.infer<typeof QueueEvent>;

export const StorageEvent = obj({
  bucket: z.string().min(1),
  existing: bool().default(false),
  events: z.array(z.enum(["created", "deleted"])).nonempty().default(["created"]),
  prefix: z.string().nullish(),
  suffix: z.string().nullish(),
});
export type StorageEvent = z.infer<typeof StorageEvent>;

export const TopicEvent = obj({
  name: z.string().min(1),
  existing: bool().default(false),
  filter: anyMap.nullish(),
});
export type TopicEvent = z.infer<typeof TopicEvent>;

export type EventSpec =
  | { type: "http"; config: HttpEvent }
  | { type: "schedule"; config: ScheduleEvent }
  | { type: "queue"; config: QueueEvent }
  | { type: "storage"; config: StorageEvent }
  | { type: "topic"; config: TopicEvent };

const EVENT_MODELS = {
  http: HttpEvent,
  schedule: ScheduleEvent,
  queue: QueueEvent,
  storage: StorageEvent,
  topic: TopicEvent,
} as const;

/** Expand YAML shorthands such as `- http: GET /users/{id}` or `- schedule: 5 minutes`. */
function expandEventShorthand(kind: EventKind, body: unknown): unknown {
  if (typeof body !== "string") return body ?? {};
  const text = body.trim();
  switch (kind) {
    case "http": {
      const idx = text.indexOf(" ");
      return idx > 0 ? { method: text.slice(0, idx), path: text.slice(idx + 1).trim() || "/" } : { path: text };
    }
    case "schedule":
      return RATE_RE.test(text) ? { rate: text } : { cron: text };
    case "queue":
    case "topic":
      return { name: text };
    case "storage":
      return { bucket: text };
  }
}

/** One trigger, written in YAML as a single-key mapping, e.g. `- http: {path: /x}`. */
export const EventSpecSchema: z.ZodType<EventSpec> = z.unknown().transform((raw, ctx): EventSpec => {
  if (isRecord(raw) && Object.keys(raw).length === 2 && "type" in raw && "config" in raw) {
    raw = { [String(raw.type)]: raw.config };
  }
  if (!isRecord(raw) || Object.keys(raw).length !== 1) {
    ctx.addIssue({
      code: "custom",
      message: `each event must be a single-key mapping such as \`- http: {path: /hello}\`; got ${JSON.stringify(raw)}`,
    });
    return z.NEVER;
  }
  const [kind, body] = Object.entries(raw)[0];
  if (!(kind in EVENT_MODELS)) {
    ctx.addIssue({ code: "custom", message: `unknown event type '${kind}'; expected one of ${EVENT_KINDS.join(", ")}` });
    return z.NEVER;
  }
  const model = EVENT_MODELS[kind as EventKind];
  const parsed = model.safeParse(expandEventShorthand(kind as EventKind, body));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: "custom", message: issue.message, path: [kind, ...issue.path.map(String)] });
    }
    return z.NEVER;
  }
  return { type: kind, config: parsed.data } as EventSpec;
});

// ------------------------------------------------------------------ function / provider

export const IamStatement = obj({
  effect: z.enum(["Allow", "Deny"]).default("Allow"),
  actions: z.array(z.string()).nonempty(),
  resources: z.array(z.string()).default(() => ["*"]),
});
export type IamStatement = z.infer<typeof IamStatement>;

export const IamConfig = obj({
  statements: z.array(IamStatement).default(() => []),
  /** Use an existing role / service account instead of creating one. */
  role: z.string().nullish(),
});
export type IamConfig = z.infer<typeof IamConfig>;

export function normalizeRuntime(value: string): string {
  const m = /^(?:nodejs|node)?\s*(\d{2})(?:\.x)?$/i.exec(value.trim());
  return m ? `nodejs${m[1]}` : value.trim();
}

const runtimeField = z
  .union([z.string(), num(z.number())])
  .transform((v) => normalizeRuntime(String(v)))
  .refine((v) => (NODE_RUNTIMES as readonly string[]).includes(v), {
    message: `runtime must be one of ${NODE_RUNTIMES.join(", ")} (provider support varies; "22", "node22" and "nodejs22.x" are accepted)`,
  });

export const FunctionConfig = obj({
  handler: z.string().regex(HANDLER_RE, {
    message: "handler must be '<module path>.<export>', e.g. 'src/orders.getOrder' or 'src/index.default'",
  }),
  description: z.string().default(""),
  runtime: runtimeField.nullish(),
  memory: num(z.number().int().min(64).max(32768)).nullish(),
  timeout: num(z.number().int().min(1).max(3600)).nullish(),
  environment: stringMap.default(() => ({})),
  tags: stringMap.default(() => ({})),
  events: z.array(EventSpecSchema).default(() => []),
  /** Reserved concurrency / max instances. */
  concurrency: num(z.number().int().min(0)).nullish(),
  architecture: z.enum(["x86_64", "arm64"]).nullish(),
  iam: IamConfig.prefault({}),
  options: anyMap.default(() => ({})),
});
export type FunctionConfig = z.infer<typeof FunctionConfig>;

export interface EventConfigOf {
  http: HttpEvent;
  schedule: ScheduleEvent;
  queue: QueueEvent;
  storage: StorageEvent;
  topic: TopicEvent;
}

export function eventsOf<K extends EventKind>(fn: FunctionConfig, kind: K): EventConfigOf[K][] {
  return fn.events.filter((e) => e.type === kind).map((e) => e.config as EventConfigOf[K]);
}

/** Human label used by the dashboard: http / scheduled / event-driven / invoke-only. */
export function functionKind(fn: FunctionConfig): string {
  const types = new Set(fn.events.map((e) => e.type));
  if (!types.size) return "invoke-only";
  if (types.size === 1 && types.has("http")) return "http";
  if (types.size === 1 && types.has("schedule")) return "scheduled";
  if (types.has("http")) return "http+event";
  return "event-driven";
}

export const StateBackend = obj({
  /** Terraform backend type, e.g. s3, gcs, azurerm, http, remote. */
  backend: z.string().nullish(),
  config: anyMap.default(() => ({})),
});

export const TerraformSettings = obj({
  /** `terraform` or `tofu`; autodetected by default. */
  binary: z.string().nullish(),
  requiredVersion: z.string().default(">= 1.5.0"),
  providerVersion: z.string().nullish(),
  /** Raw Terraform JSON deep-merged into the generated config. */
  extra: anyMap.default(() => ({})),
});

export const ProviderConfig = obj({
  // Built-in names are listed in PROVIDERS; plug-in providers are accepted too (checked by the loader).
  name: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
  region: z.string().nullish(),
  stage: z
    .string()
    .default("dev")
    .refine((v) => /^[a-z][a-z0-9-]{0,15}$/.test(v), {
      message: "stage must be lowercase alphanumeric/dash, max 16 chars, e.g. dev, prod",
    }),
  /** Defaults to the newest Node.js version (<= 22) the provider supports. */
  runtime: runtimeField.nullish(),
  memory: num(z.number().int().min(64).max(32768)).default(256),
  timeout: num(z.number().int().min(1).max(3600)).default(30),
  architecture: z.enum(["x86_64", "arm64"]).default("x86_64"),
  environment: stringMap.default(() => ({})),
  tags: stringMap.default(() => ({})),
  iam: IamConfig.prefault({}),
  logRetentionDays: num(z.number().int().positive()).nullable().default(14),
  options: anyMap.default(() => ({})),
  state: StateBackend.prefault({}),
  terraform: TerraformSettings.prefault({}),
});
export type ProviderConfig = z.infer<typeof ProviderConfig> & { runtime: string };

export const PackageConfig = obj({
  /** Directory handler paths are relative to. */
  source: z.string().default("."),
  /** Extra files (templates, data, ...) copied into the artifact next to the bundle. */
  include: z.array(z.string()).default(() => []),
  exclude: z.array(z.string()).default(() => []),
  /** npm packages NOT bundled; installed into the artifact's node_modules instead (native addons, ...). */
  external: z.array(z.string()).default(() => []),
  minify: bool().default(false),
  sourcemap: bool().default(true),
  /** tsconfig used for path aliases / decorators. Default: `tsconfig.json` when present. */
  tsconfig: z.string().nullish(),
  /** Raw esbuild options merged into the build (define, loader, banner, ...). */
  esbuild: anyMap.default(() => ({})),
});
export type PackageConfig = z.infer<typeof PackageConfig>;

// ------------------------------------------------------------------ workflows

export const STATE_TYPES = ["task", "choice", "wait", "pass", "parallel", "map", "succeed", "fail"] as const;

export const RetryRule = obj({
  errors: z.array(z.string()).default(() => ["*"]),
  maxAttempts: num(z.number().int().min(0).max(99)).default(3),
  intervalSeconds: num(z.number().min(0)).default(1),
  backoffRate: num(z.number().min(1)).default(2),
  maxDelaySeconds: num(z.number().positive()).nullish(),
});
export type RetryRule = z.infer<typeof RetryRule>;

export const CatchRule = obj({
  errors: z.array(z.string()).default(() => ["*"]),
  next: z.string(),
  resultPath: z.string().nullable().default("$.error"),
});
export type CatchRule = z.infer<typeof CatchRule>;

const CHOICE_KEY_ALIASES: Record<string, string> = {
  not_equals: "notEquals",
  is_null: "isNull",
  is_present: "isPresent",
};

function normalizeChoice(rule: unknown): unknown {
  if (!isRecord(rule)) return rule;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rule)) {
    const key = CHOICE_KEY_ALIASES[k] ?? k;
    if ((key === "and" || key === "or") && Array.isArray(v)) out[key] = v.map(normalizeChoice);
    else if (key === "not") out[key] = normalizeChoice(v);
    else out[key] = v;
  }
  return out;
}

export interface WorkflowState {
  type: (typeof STATE_TYPES)[number];
  function?: string | null;
  next?: string | null;
  end: boolean;
  comment?: string | null;
  inputPath?: string | null;
  resultPath: string | null;
  retry: RetryRule[];
  catch: CatchRule[];
  timeoutSeconds?: number | null;
  choices: Record<string, unknown>[];
  default?: string | null;
  seconds?: number | null;
  secondsPath?: string | null;
  result?: unknown;
  branches: WorkflowDefinition[];
  itemsPath?: string | null;
  iterator?: WorkflowDefinition | null;
  maxConcurrency?: number | null;
  error?: string | null;
  cause?: string | null;
}

export interface WorkflowDefinition {
  startAt: string;
  states: Record<string, WorkflowState>;
}

export const WorkflowStateSchema: z.ZodType<WorkflowState> = z.lazy(() =>
  obj({
    type: z.enum(STATE_TYPES),
    function: z.string().nullish(),
    next: z.string().nullish(),
    end: bool().default(false),
    comment: z.string().nullish(),
    inputPath: z.string().nullish(),
    resultPath: z.string().nullable().default("$"),
    retry: z.array(RetryRule).default(() => []),
    catch: z.array(CatchRule).default(() => []),
    timeoutSeconds: num(z.number().int().positive()).nullish(),
    choices: z.array(z.preprocess(normalizeChoice, anyMap)).default(() => []),
    default: z.string().nullish(),
    seconds: num(z.number().min(0)).nullish(),
    secondsPath: z.string().nullish(),
    result: z.unknown().optional(),
    branches: z.array(WorkflowDefinitionSchema).default(() => []),
    itemsPath: z.string().nullish(),
    iterator: WorkflowDefinitionSchema.nullish(),
    maxConcurrency: num(z.number().int().positive()).nullish(),
    error: z.string().nullish(),
    cause: z.string().nullish(),
  }).transform((st, ctx) => {
    const t = st.type;
    if (t === "task" && !st.function) ctx.addIssue({ code: "custom", message: "task state needs `function`" });
    if (t === "choice" && !st.choices.length) ctx.addIssue({ code: "custom", message: "choice state needs `choices`" });
    if (t === "wait" && (st.seconds === null || st.seconds === undefined) && !st.secondsPath) {
      ctx.addIssue({ code: "custom", message: "wait state needs `seconds` or `secondsPath`" });
    }
    if (t === "parallel" && !st.branches.length) ctx.addIssue({ code: "custom", message: "parallel state needs `branches`" });
    if (t === "map" && !st.iterator) ctx.addIssue({ code: "custom", message: "map state needs `iterator`" });
    if (["task", "wait", "pass", "parallel", "map"].includes(t) && !(st.next || st.end)) st.end = true;
    return st as WorkflowState;
  }),
);

function checkGraph(def: { startAt: string; states: Record<string, WorkflowState> }, ctx: z.RefinementCtx): void {
  const names = new Set(Object.keys(def.states));
  if (!names.has(def.startAt)) {
    ctx.addIssue({ code: "custom", message: `startAt '${def.startAt}' is not a defined state`, path: ["startAt"] });
  }
  for (const [name, st] of Object.entries(def.states)) {
    const targets = [st.next, st.default, ...st.catch.map((c) => c.next), ...st.choices.map((r) => r.next as string)];
    for (const target of targets) {
      if (target && !names.has(target)) {
        ctx.addIssue({ code: "custom", message: `state '${name}' points to unknown state '${target}'`, path: ["states", name] });
      }
    }
    for (const rule of st.choices) {
      if (!("next" in rule)) {
        ctx.addIssue({ code: "custom", message: `choice rule in '${name}' has no \`next\``, path: ["states", name] });
      }
    }
  }
}

const definitionShape = {
  startAt: z.string(),
  states: z.record(z.string(), WorkflowStateSchema),
};

export const WorkflowDefinitionSchema: z.ZodType<WorkflowDefinition> = z.lazy(() =>
  obj(definitionShape).superRefine(checkGraph),
);

export const WorkflowConfig = obj({
  ...definitionShape,
  description: z.string().default(""),
  engine: z.enum(["auto", "native", "embedded"]).default("auto"),
  timeout: num(z.number().int().positive()).nullish(),
  options: anyMap.default(() => ({})),
}).superRefine(checkGraph);
export type WorkflowConfig = z.infer<typeof WorkflowConfig>;

export function taskFunctions(def: WorkflowDefinition): string[] {
  const found: string[] = [];
  for (const st of Object.values(def.states)) {
    if (st.function) found.push(st.function);
    for (const branch of st.branches) found.push(...taskFunctions(branch));
    if (st.iterator) found.push(...taskFunctions(st.iterator));
  }
  return found;
}

// ------------------------------------------------------------------ root

const namedMap = <T extends z.ZodTypeAny>(schema: T) =>
  z.record(z.string(), schema).superRefine((v, ctx) => {
    for (const name of Object.keys(v)) {
      if (!NAME_RE.test(name)) {
        ctx.addIssue({
          code: "custom",
          message: `name '${name}' must start with a letter and use letters, digits, - or _`,
          path: [name],
        });
      }
    }
  });

const hooksSchema = z
  .preprocess(
    (raw) => normalizeKeys(raw, new Set(HOOKS)),
    z.record(z.string(), z.union([z.string(), z.array(z.string())]).transform((v) => (Array.isArray(v) ? v : [v]))),
  )
  .superRefine((v, ctx) => {
    const unknown = Object.keys(v).filter((k) => !(HOOKS as readonly string[]).includes(k));
    if (unknown.length) {
      ctx.addIssue({ code: "custom", message: `unknown hooks ${unknown.join(", ")}; allowed: ${HOOKS.join(", ")}` });
    }
  });

export const ServiceConfigSchema = obj({
  service: z.string().refine((v) => /^[a-z][a-z0-9-]{1,31}$/.test(v), {
    message: "service must be 2-32 chars of lowercase letters, digits and dashes",
  }),
  provider: ProviderConfig,
  package: PackageConfig.prefault({}),
  functions: namedMap(FunctionConfig).default(() => ({})),
  workflows: namedMap(WorkflowConfig).default(() => ({})),
  hooks: hooksSchema.default(() => ({})),
  /** Free-form values for `${self:custom.x}`. */
  custom: anyMap.default(() => ({})),
}).superRefine((cfg, ctx) => {
  for (const [wfName, wf] of Object.entries(cfg.workflows)) {
    for (const fn of taskFunctions(wf)) {
      if (!(fn in cfg.functions)) {
        ctx.addIssue({ code: "custom", message: `workflow '${wfName}' references unknown function '${fn}'`, path: ["workflows", wfName] });
      }
    }
  }
  const seen = new Map<string, string>();
  for (const [fnName, fn] of Object.entries(cfg.functions)) {
    for (const ev of eventsOf(fn, "http")) {
      const key = `${ev.method} ${ev.path.replace(/\/+$/, "") || "/"}`;
      const prev = seen.get(key);
      if (prev) {
        ctx.addIssue({ code: "custom", message: `route ${key} is used by both '${prev}' and '${fnName}'`, path: ["functions", fnName] });
      }
      seen.set(key, fnName);
    }
  }
});

export type ServiceConfig = Omit<z.infer<typeof ServiceConfigSchema>, "provider"> & { provider: ProviderConfig };

// ------------------------------------------------------------------ convenience

export function memoryOf(cfg: ServiceConfig, fn: FunctionConfig): number {
  return fn.memory ?? cfg.provider.memory;
}

export function timeoutOf(cfg: ServiceConfig, fn: FunctionConfig): number {
  return fn.timeout ?? cfg.provider.timeout;
}

export function runtimeOf(cfg: ServiceConfig, fn: FunctionConfig): string {
  return fn.runtime ?? cfg.provider.runtime;
}

export function architectureOf(cfg: ServiceConfig, fn: FunctionConfig): "x86_64" | "arm64" {
  return fn.architecture ?? cfg.provider.architecture;
}
