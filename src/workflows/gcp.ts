/**
 * Compile a portable workflow definition to Google Cloud Workflows (JSON syntax).
 *
 * Each task state becomes an authenticated `http.post` to the Cloud Function's
 * URL with the `{"__nskit": "workflow", "data": ...}` envelope; the GCP adapter
 * answers with the handler's JSON result or a 500 `{"errorType", "cause"}`.
 *
 * Limitations compared to Step Functions (reported as warnings):
 *
 * - only the *first* retry rule of a task is used (Cloud Workflows allows one policy);
 * - retry / catch are honoured on `task` states only.
 */

import { ENVELOPE_KEY } from "../runtime/envelope.js";
import type { WorkflowDefinitionData } from "../runtime/manifest.js";
import { pathTokens } from "../runtime/workflow.js";

export type UrlResolver = (fn: string) => string;
type Obj = Record<string, unknown>;
type Step = Record<string, unknown>;

const MAX_HTTP_TIMEOUT = 1800;

export interface GcpWorkflowResult {
  /** Cloud Workflows source (`main` + subworkflows), ready for `JSON.stringify`. */
  source: Obj;
  warnings: string[];
}

function sid(...parts: string[]): string {
  return parts.filter(Boolean).join("_").replace(/[^A-Za-z0-9_]/g, "_");
}

/** Same JSON-path dialect as the embedded engine. */
const keys = pathTokens;

/** JSON literal in Python `json.dumps` style (`["a", "b"]`), used inside workflow expressions. */
function lit(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(lit).join(", ") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${lit(v)}`).join(", ") + "}";
  }
  return JSON.stringify(value ?? null);
}

/** Expression reading a JSON path from `variable`, e.g. `map.get(data, ["a", "b"])`. */
export function readExpr(path: string | null | undefined, variable = "data"): string {
  const ks = keys(path);
  if (!ks.length) return variable;
  if (ks.every((k) => typeof k === "string")) return `map.get(${variable}, ${lit(ks)})`;
  return variable + ks.map((k) => `[${JSON.stringify(k)}]`).join("");
}

/** Assignment target for a result path; `null` means "discard". */
export function assignTarget(path: string | null | undefined, variable = "data"): string | null {
  if (path === null) return null;
  let target = variable;
  for (const k of keys(path)) target += typeof k === "number" ? `[${k}]` : `.${k}`;
  return target;
}

const SIMPLE_OPS: [string, string][] = [
  ["equals", "=="],
  ["notEquals", "!="],
  ["gt", ">"],
  ["gte", ">="],
  ["lt", "<"],
  ["lte", "<="],
];

function globToRegex(glob: string): string {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  return "^" + escaped.replace(/\\\*/g, ".*").replace(/\\\?/g, ".") + "$";
}

/** Compile a choice rule to a Cloud Workflows boolean expression (without `${}`). */
export function ruleExpr(rule: Obj): string {
  if (Array.isArray(rule.and)) return "(" + rule.and.map((r) => ruleExpr(r as Obj)).join(" and ") + ")";
  if (Array.isArray(rule.or)) return "(" + rule.or.map((r) => ruleExpr(r as Obj)).join(" or ") + ")";
  if (rule.not && typeof rule.not === "object") return `(not ${ruleExpr(rule.not as Obj)})`;
  const v = readExpr(typeof rule.variable === "string" ? rule.variable : "$");
  for (const [op, sym] of SIMPLE_OPS) if (op in rule) return `(${v} ${sym} ${lit(rule[op])})`;
  if ("in" in rule) return `(${v} in ${lit(rule.in)})`;
  if ("contains" in rule) return `(len(text.find_all(${v}, ${lit(String(rule.contains))})) > 0)`;
  if ("matches" in rule) return `text.match_regex(${v}, ${lit(globToRegex(String(rule.matches)))})`;
  if ("isNull" in rule) return rule.isNull ? `(${v} == null)` : `(${v} != null)`;
  if ("isPresent" in rule) return rule.isPresent ? `(${v} != null)` : `(${v} == null)`;
  throw new Error(`unsupported choice rule: ${JSON.stringify(rule)}`);
}

function errorsCondition(errors: unknown): string {
  const list = Array.isArray(errors) && errors.length ? (errors as string[]) : ["*"];
  if (list.some((e) => e === "*" || e === "States.ALL")) return "${true}";
  return '${map.get(e, ["body", "errorType"]) in ' + lit(list) + "}";
}

const num = (v: unknown, fallback: number): number => (v === undefined || v === null || v === "" ? fallback : Number(v));

class Compiler {
  readonly subworkflows: Obj = {};
  readonly warnings: string[] = [];

  constructor(
    private readonly urlOf: UrlResolver,
    private readonly workflow: string,
  ) {}

  machine(machine: WorkflowDefinitionData, prefix: string): Step[] {
    const states = machine.states;
    const entry: Record<string, string> = {};
    for (const [name, st] of Object.entries(states)) entry[name] = this.entryStep(prefix, name, st);
    const steps: Step[] = [{ [sid(prefix, "init")]: { assign: [{ data: "${input}" }, { _caught: "" }], next: entry[machine.startAt] } }];
    for (const [name, st] of Object.entries(states)) steps.push(...this.state(prefix, name, st, entry));
    return steps;
  }

  private entryStep(prefix: string, name: string, st: Obj): string {
    if (st.type === "task" && Array.isArray(st.catch) && st.catch.length) return sid(prefix, name, "pre");
    if (st.type === "parallel" || st.type === "map") return sid(prefix, name, "init");
    return sid(prefix, name);
  }

  private after(st: Obj, entry: Record<string, string>): Obj {
    return st.next ? { next: entry[String(st.next)] } : { return: "${data}" };
  }

  private store(prefix: string, name: string, st: Obj, valueExpr: string, entry: Record<string, string>): Step {
    const target = assignTarget("resultPath" in st ? (st.resultPath as string | null) : "$");
    const body: Obj = { assign: [target !== null ? { [target]: valueExpr } : { _discard: valueExpr }] };
    Object.assign(body, this.after(st, entry));
    return { [sid(prefix, name, "out")]: body };
  }

  private sub(machine: WorkflowDefinitionData, name: string): string {
    const subName = sid(this.workflow, name);
    this.subworkflows[subName] = { params: ["input"], steps: this.machine(machine, subName) };
    return subName;
  }

  private state(prefix: string, name: string, st: Obj, entry: Record<string, string>): Step[] {
    const kind = st.type;
    const id = sid(prefix, name);
    const inputExpr = "${" + readExpr(st.inputPath as string | undefined) + "}";
    switch (kind) {
      case "task":
        return this.task(prefix, name, st, entry, inputExpr);
      case "pass": {
        const value = "result" in st ? lit(st.result) : readExpr(st.inputPath as string | undefined);
        return [
          { [id]: { assign: [{ _pass: "${" + value + "}" }], next: sid(prefix, name, "out") } },
          this.store(prefix, name, st, "${_pass}", entry),
        ];
      }
      case "wait": {
        const seconds: unknown = st.secondsPath ? "${" + readExpr(String(st.secondsPath)) + "}" : Math.trunc(num(st.seconds, 0));
        return [{ [id]: { call: "sys.sleep", args: { seconds }, ...this.after(st, entry) } }];
      }
      case "choice": {
        const conds: Obj[] = (st.choices as Obj[]).map((r) => ({
          condition: "${" + ruleExpr(r) + "}",
          next: entry[String(r.next)],
        }));
        const body: Obj = { switch: conds };
        if (st.default) body.next = entry[String(st.default)];
        else conds.push({ condition: true, raise: { error: "States.NoChoiceMatched", cause: name } });
        return [{ [id]: body }];
      }
      case "succeed":
        return [{ [id]: { return: "${data}" } }];
      case "fail":
        return [{ [id]: { raise: { error: st.error ?? "States.Fail", cause: st.cause ?? "" } } }];
      case "parallel": {
        this.warnRetryCatch(st, name, "parallel");
        const variable = sid("par", prefix, name);
        const branches = (st.branches as WorkflowDefinitionData[]).map((branch, i) => {
          const sub = this.sub(branch, `${prefix}_${name}_b${i}`);
          return {
            [`b${i}`]: {
              steps: [
                { [sid(id, `b${i}`, "call")]: { call: sub, args: { input: inputExpr }, result: `r${i}` } },
                { [sid(id, `b${i}`, "save")]: { assign: [{ [`${variable}.b${i}`]: `\${r${i}}` }] } },
              ],
            },
          };
        });
        const collect = "${[" + branches.map((_, i) => `${variable}.b${i}`).join(", ") + "]}";
        return [
          { [sid(prefix, name, "init")]: { assign: [{ [variable]: {} }] } },
          { [id]: { parallel: { shared: [variable], branches } } },
          this.store(prefix, name, st, collect, entry),
        ];
      }
      case "map": {
        this.warnRetryCatch(st, name, "map");
        const sub = this.sub(st.iterator as WorkflowDefinitionData, `${prefix}_${name}_it`);
        const items = sid("items", prefix, name);
        const res = sid("res", prefix, name);
        const out = sid("out", prefix, name);
        const itemsSrc = readExpr(st.itemsPath as string | undefined, readExpr(st.inputPath as string | undefined));
        const parallel: Obj = {
          shared: [res],
          for: {
            value: "item",
            index: "i",
            in: "${" + items + "}",
            steps: [
              { [sid(id, "call")]: { call: sub, args: { input: "${item}" }, result: "r" } },
              { [sid(id, "save")]: { assign: [{ [`${res}[string(i)]`]: "${r}" }] } },
            ],
          },
        };
        if (st.maxConcurrency) parallel.concurrency_limit = Math.trunc(Number(st.maxConcurrency));
        return [
          { [sid(prefix, name, "init")]: { assign: [{ [items]: "${" + itemsSrc + "}" }, { [res]: {} }, { [out]: [] }] } },
          { [id]: { parallel } },
          {
            [sid(prefix, name, "collect")]: {
              for: {
                value: "j",
                range: "${[0, len(" + items + ") - 1]}",
                steps: [{ [sid(id, "append")]: { assign: [{ [out]: `\${list.concat(${out}, ${res}[string(j)])}` }] } }],
              },
            },
          },
          this.store(prefix, name, st, "${" + out + "}", entry),
        ];
      }
      default:
        throw new Error(`unknown state type ${String(kind)}`);
    }
  }

  private warnRetryCatch(st: Obj, name: string, kind: string): void {
    const has = (v: unknown) => Array.isArray(v) && v.length > 0;
    if (has(st.retry) || has(st.catch)) this.warnings.push(`${this.workflow}.${name}: retry/catch on ${kind} states is ignored on GCP`);
  }

  private task(prefix: string, name: string, st: Obj, entry: Record<string, string>, inputExpr: string): Step[] {
    const id = sid(prefix, name);
    const resultVar = sid("res", prefix, name);
    const timeout = Math.min(Math.trunc(num(st.timeoutSeconds, MAX_HTTP_TIMEOUT)) || MAX_HTTP_TIMEOUT, MAX_HTTP_TIMEOUT);
    const call: Obj = {
      call: "http.post",
      args: {
        url: this.urlOf(String(st.function)),
        auth: { type: "OIDC" },
        timeout,
        body: { [ENVELOPE_KEY]: "workflow", data: inputExpr },
      },
      result: resultVar,
    };
    const steps: Step[] = [];
    const retry = (st.retry as Obj[] | undefined) ?? [];
    const catches = (st.catch as Obj[] | undefined) ?? [];
    if (retry.length > 1) this.warnings.push(`${this.workflow}.${name}: only the first retry rule is used on GCP`);
    if (!retry.length && !catches.length) {
      steps.push({ [id]: call });
    } else {
      const body: Obj = { try: call };
      if (retry.length) {
        const rule = retry[0];
        const pred = sid(this.workflow, prefix, name, "retry_pred");
        this.subworkflows[pred] = {
          params: ["e"],
          steps: [{ check: { switch: [{ condition: errorsCondition(rule.errors), return: true }] } }, { no: { return: false } }],
        };
        body.retry = {
          predicate: "${" + pred + "}",
          max_retries: Math.trunc(num(rule.maxAttempts, 3)),
          backoff: {
            initial_delay: Math.max(1, num(rule.intervalSeconds, 1)),
            max_delay: num(rule.maxDelaySeconds, 0) || 300,
            multiplier: num(rule.backoffRate, 2),
          },
        };
      }
      if (catches.length) {
        const info = {
          error: '${default(map.get(e, ["body", "errorType"]), "Error")}',
          cause: '${default(map.get(e, ["body", "cause"]), "")}',
        };
        const conds: Obj[] = catches.map((c, i) => {
          const assigns: Obj[] = [{ _caught: c.next }];
          const target = assignTarget("resultPath" in c ? (c.resultPath as string | null) : "$.error");
          if (target !== null) assigns.push({ [target]: info });
          return { condition: errorsCondition(c.errors), steps: [{ [sid(id, `catch${i}`)]: { assign: assigns } }] };
        });
        conds.push({ condition: true, raise: "${e}" });
        body.except = { as: "e", steps: [{ [sid(id, "except")]: { switch: conds } }] };
        steps.push({ [sid(prefix, name, "pre")]: { assign: [{ _caught: "" }] } });
      }
      steps.push({ [id]: body });
      if (catches.length) {
        const route = catches.map((c) => ({ condition: "${_caught == " + lit(c.next) + "}", next: entry[String(c.next)] }));
        steps.push({ [sid(prefix, name, "route")]: { switch: route } });
      }
    }
    steps.push(this.store(prefix, name, st, "${" + resultVar + ".body}", entry));
    return steps;
  }
}

/** Compile `definition` (see `workflows/index.ts::definitionData`) to a Cloud Workflows source object. */
export function compileGcpWorkflow(definition: WorkflowDefinitionData, urlOf: UrlResolver, workflow: string): GcpWorkflowResult {
  const comp = new Compiler(urlOf, sid(workflow));
  const source: Obj = { main: { params: ["input"], steps: comp.machine(definition, "s") } };
  Object.assign(source, comp.subworkflows);
  return { source, warnings: comp.warnings };
}
