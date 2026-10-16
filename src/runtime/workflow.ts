/**
 * Embedded workflow (state machine) engine.
 *
 * The same definition the CLI compiles to AWS Step Functions (ASL) or Google
 * Cloud Workflows is interpreted here for:
 *
 * - `nskit workflow run` - test workflows on your laptop;
 * - providers without a native orchestrator - the CLI deploys an extra
 *   *orchestrator* function whose handler is {@link orchestrate}, which calls
 *   task handlers in-process (they live in the same bundle).
 *
 * Supported state types: task, choice, wait, pass, parallel, map, succeed, fail.
 */

import { Context } from "./context.js";
import { execute } from "./dispatch.js";
import { errorMessage, errorName } from "./errors.js";
import { Event, EventType } from "./event.js";
import { getManifest, type WorkflowDefinitionData } from "./manifest.js";
import { HttpResponse } from "./response.js";

export type TaskRunner = (fn: string, input: unknown) => Promise<unknown> | unknown;
type State = Record<string, unknown>;
const ALL_ERRORS = new Set(["*", "States.ALL"]);

export interface HistoryEntry {
  ts: string;
  state: string;
  type: string;
  event: string;
  [key: string]: unknown;
}

export class WorkflowFailed extends Error {
  readonly error: string;
  override readonly cause: string;
  readonly history: HistoryEntry[];

  constructor(error: string, cause = "", history: HistoryEntry[] = []) {
    super(cause ? `${error}: ${cause}` : error);
    this.name = "WorkflowFailed";
    this.error = error;
    this.cause = cause;
    this.history = history;
  }
}

// --------------------------------------------------------------------- JSON path

export function pathTokens(path: string | undefined | null): (string | number)[] {
  if (path === undefined || path === null || path === "" || path === "$") return [];
  if (!path.startsWith("$")) throw new Error(`JSON path must start with '$': ${JSON.stringify(path)}`);
  const out: (string | number)[] = [];
  for (const part of path.slice(1).replace(/\[/g, ".[").split(".")) {
    if (!part) continue;
    if (part.startsWith("[") && part.endsWith("]")) {
      const inner = part.slice(1, -1).replace(/^['"]|['"]$/g, "");
      out.push(/^-?\d+$/.test(inner) ? Number(inner) : inner);
    } else {
      out.push(part);
    }
  }
  return out;
}

const ABSENT: unique symbol = Symbol("absent");

export function getPath(data: unknown, path: string): unknown;
export function getPath<T>(data: unknown, path: string, fallback: T): unknown;
export function getPath(data: unknown, path: string, ...rest: unknown[]): unknown {
  let current: unknown = data;
  for (const tok of pathTokens(path)) {
    if (current !== null && typeof current === "object") {
      const container = current as Record<string | number, unknown>;
      const key = typeof tok === "number" && Array.isArray(current) && tok < 0 ? current.length + tok : tok;
      if (key in container) {
        current = container[key];
        continue;
      }
    }
    if (rest.length) return rest[0];
    throw new Error(`path ${path} not found`);
  }
  return current;
}

/** Return `data` with `value` written at `path` (`$` replaces; `null` discards the value). */
export function setPath(data: unknown, path: string | null | undefined, value: unknown): unknown {
  if (path === null) return data;
  const toks = pathTokens(path ?? "$");
  if (!toks.length) return value;
  const root: Record<string | number, unknown> =
    data !== null && typeof data === "object" ? (structuredClone(data) as Record<string | number, unknown>) : {};
  let current: Record<string | number, unknown> = root;
  for (const tok of toks.slice(0, -1)) {
    const next = current[tok];
    if (next === null || typeof next !== "object") current[tok] = {};
    current = current[tok] as Record<string | number, unknown>;
  }
  current[toks[toks.length - 1]] = value;
  return root;
}

// --------------------------------------------------------------------- choice

function globMatch(text: string, pattern: string): boolean {
  const re = pattern.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`, "s").test(text);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function compare(a: unknown, b: unknown): number | undefined {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return undefined;
}

const OPS: Record<string, (a: unknown, b: unknown) => boolean> = {
  equals: (a, b) => deepEqual(a, b),
  notEquals: (a, b) => !deepEqual(a, b),
  gt: (a, b) => (compare(a, b) ?? NaN) > 0,
  gte: (a, b) => (compare(a, b) ?? NaN) >= 0,
  lt: (a, b) => (compare(a, b) ?? NaN) < 0,
  lte: (a, b) => (compare(a, b) ?? NaN) <= 0,
  in: (a, b) => Array.isArray(b) && b.some((x) => deepEqual(x, a)),
  contains: (a, b) =>
    (typeof a === "string" && typeof b === "string" && a.includes(b)) ||
    (Array.isArray(a) && a.some((x) => deepEqual(x, b))),
  matches: (a, b) => typeof a === "string" && typeof b === "string" && globMatch(a, b),
  isNull: (a, b) => (a === null) === Boolean(b),
  isPresent: (a, b) => (a !== ABSENT) === Boolean(b),
};
export const CHOICE_OPERATORS = Object.keys(OPS);

export function evaluateRule(rule: Record<string, unknown>, data: unknown): boolean {
  if (Array.isArray(rule.and)) return rule.and.every((r) => evaluateRule(r as Record<string, unknown>, data));
  if (Array.isArray(rule.or)) return rule.or.some((r) => evaluateRule(r as Record<string, unknown>, data));
  if (rule.not && typeof rule.not === "object") return !evaluateRule(rule.not as Record<string, unknown>, data);
  const variable = typeof rule.variable === "string" ? rule.variable : "$";
  for (const [op, fn] of Object.entries(OPS)) {
    if (!(op in rule)) continue;
    const value = getPath(data, variable, ABSENT);
    if (op === "isPresent") return fn(value, rule[op]);
    if (value === ABSENT) return false;
    try {
      return fn(value, rule[op]);
    } catch {
      return false;
    }
  }
  throw new Error(`Choice rule has no operator (one of ${CHOICE_OPERATORS.join(", ")}): ${JSON.stringify(rule)}`);
}

// --------------------------------------------------------------------- engine

function matchesErrors(errors: unknown, name: string): boolean {
  const list = Array.isArray(errors) && errors.length ? (errors as string[]) : ["*"];
  return list.some((e) => ALL_ERRORS.has(e) || e === name);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export interface WorkflowEngineOptions {
  sleep?: (seconds: number) => Promise<void>;
  maxSteps?: number;
}

export class WorkflowEngine {
  readonly history: HistoryEntry[] = [];
  private readonly sleep: (seconds: number) => Promise<void>;
  private readonly maxSteps: number;
  private steps = 0;

  constructor(
    private readonly definition: WorkflowDefinitionData,
    private readonly taskRunner: TaskRunner,
    options: WorkflowEngineOptions = {},
  ) {
    this.sleep = options.sleep ?? ((s) => new Promise((r) => setTimeout(r, s * 1000)));
    this.maxSteps = options.maxSteps ?? 10_000;
  }

  run(data: unknown = null): Promise<unknown> {
    return this.runMachine(this.definition, data);
  }

  private record(state: string, type: string, event: string, extra: Record<string, unknown> = {}): void {
    this.history.push({ ts: new Date().toISOString(), state, type, event, ...extra });
  }

  private async runMachine(machine: WorkflowDefinitionData, input: unknown): Promise<unknown> {
    const states = machine.states as Record<string, State>;
    let name: string | undefined = machine.startAt;
    let data = input;
    while (name !== undefined) {
      if (++this.steps > this.maxSteps) {
        throw new WorkflowFailed("States.Runtime", `exceeded ${this.maxSteps} steps`, this.history);
      }
      const state: State | undefined = states[name];
      if (!state) throw new WorkflowFailed("States.Runtime", `unknown state ${name}`, this.history);
      const kind = String(state.type);
      this.record(name, kind, "enter");
      if (kind === "succeed") return data;
      if (kind === "fail") {
        throw new WorkflowFailed(str(state.error) ?? "States.Fail", str(state.cause) ?? "", this.history);
      }
      if (kind === "choice") {
        name = this.choose(state, data);
        continue;
      }
      try {
        data = await this.executeState(state, data);
      } catch (err) {
        if (err instanceof WorkflowFailed) throw err;
        const errName = errorName(err);
        const handler: State | undefined = ((state.catch as State[] | undefined) ?? []).find((c) => matchesErrors(c.errors, errName));
        if (!handler) throw new WorkflowFailed(errName, errorMessage(err), this.history);
        this.record(name, kind, "caught", { error: errName });
        const resultPath = "resultPath" in handler ? (handler.resultPath as string | null) : "$.error";
        data = setPath(data, resultPath, { error: errName, cause: errorMessage(err) });
        name = String(handler.next);
        continue;
      }
      if (state.end || !state.next) return data;
      name = String(state.next);
    }
    return data;
  }

  private choose(state: State, data: unknown): string {
    for (const rule of (state.choices as Record<string, unknown>[] | undefined) ?? []) {
      if (evaluateRule(rule, data)) return String(rule.next);
    }
    if (state.default) return String(state.default);
    throw new WorkflowFailed("States.NoChoiceMatched", "no choice rule matched and no default", this.history);
  }

  private async executeState(state: State, data: unknown): Promise<unknown> {
    const kind = String(state.type);
    const input = state.inputPath ? getPath(data, String(state.inputPath)) : data;
    let result: unknown;
    if (kind === "task") {
      result = await this.withRetry(state, () => this.taskRunner(String(state.function), input));
    } else if (kind === "pass") {
      result = "result" in state ? state.result : input;
    } else if (kind === "wait") {
      const seconds = state.secondsPath ? Number(getPath(data, String(state.secondsPath))) : Number(state.seconds ?? 0);
      await this.sleep(seconds);
      result = input;
    } else if (kind === "parallel") {
      const branches = (state.branches as WorkflowDefinitionData[] | undefined) ?? [];
      result = await this.withRetry(state, () => Promise.all(branches.map((b) => this.runNested(b, structuredClone(input)))));
    } else if (kind === "map") {
      const items = getPath(input, str(state.itemsPath) ?? "$");
      if (!Array.isArray(items)) {
        throw new TypeError(`map itemsPath did not resolve to a list: ${items === null ? "null" : typeof items}`);
      }
      const iterator = state.iterator as WorkflowDefinitionData;
      const limit = Number(state.maxConcurrency) || Math.min(32, Math.max(1, items.length));
      result = await this.withRetry(state, () => mapLimit(items, limit, (item) => this.runNested(iterator, item)));
    } else {
      throw new WorkflowFailed("States.Runtime", `unknown state type ${kind}`, this.history);
    }
    const resultPath = "resultPath" in state ? (state.resultPath as string | null) : "$";
    return setPath(data, resultPath, result);
  }

  /**
   * Run a parallel branch / map iteration. Like Step Functions, a failure
   * inside it becomes an error of the enclosing state, so that state's own
   * `retry` / `catch` rules apply (engine limits still abort the whole run).
   */
  private async runNested(machine: WorkflowDefinitionData, input: unknown): Promise<unknown> {
    try {
      return await this.runMachine(machine, input);
    } catch (err) {
      if (err instanceof WorkflowFailed && err.error !== "States.Runtime") {
        const nested = new Error(err.cause || err.error);
        nested.name = err.error;
        throw nested;
      }
      throw err;
    }
  }

  private async withRetry(state: State, call: () => unknown): Promise<unknown> {
    const attempts = new Map<number, number>();
    for (;;) {
      try {
        return await call();
      } catch (err) {
        const name = errorName(err);
        const rules = (state.retry as State[] | undefined) ?? [];
        // Like ASL, the first retrier whose errors match is the one used.
        const idx = rules.findIndex((r) => matchesErrors(r.errors, name));
        if (idx < 0) throw err;
        const rule = rules[idx];
        const count = attempts.get(idx) ?? 0;
        if (count >= Number(rule.maxAttempts ?? 3)) throw err;
        attempts.set(idx, count + 1);
        const delay = Number(rule.intervalSeconds ?? 1) * Number(rule.backoffRate ?? 2) ** count;
        this.record(String(state.function ?? "?"), "task", "retry", { attempt: count + 1, error: name });
        await this.sleep(Math.min(delay, Number(rule.maxDelaySeconds ?? 300)));
      }
    }
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 0 }, worker));
  return out;
}

/** Task runner that invokes handlers from the current bundle via the dispatcher. */
export function inProcessRunner(provider = "local"): TaskRunner {
  return (fn, input) => {
    const event = new Event({ type: EventType.WORKFLOW, provider, functionName: fn, data: input });
    return execute(event, new Context({ functionName: fn, provider }), fn);
  };
}

/** Handler of the auto-generated `<workflow>-orchestrator` function. */
export async function orchestrate(event: Event, context: Context): Promise<unknown> {
  const manifest = getManifest();
  const me = event.functionName || context.functionName;
  const entry = Object.entries(manifest.workflows).find(([, wf]) => wf.orchestrator === me);
  if (!entry) throw new Error(`No workflow is orchestrated by function ${JSON.stringify(me)}`);
  const [name, wf] = entry;
  let data: unknown;
  if (event.http) data = event.http.body.length ? event.http.json(null) : { ...event.http.query };
  else data = event.data;
  const engine = new WorkflowEngine(wf.definition, inProcessRunner(event.provider));
  const started = Date.now();
  try {
    const output = await engine.run(data);
    return { workflow: name, status: "SUCCEEDED", output, durationMs: Date.now() - started };
  } catch (err) {
    if (!(err instanceof WorkflowFailed)) throw err;
    const failure = { workflow: name, status: "FAILED", error: err.error, cause: err.cause };
    context.logger.error("workflow failed", failure);
    if (event.http) return HttpResponse.json(failure, 500);
    throw err;
  }
}

/** Handler reference used for generated orchestrator functions. */
export const ORCHESTRATOR_HANDLER = "node-serverless-kit/workflow.orchestrate";
