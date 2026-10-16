/** Compile a portable workflow definition to Amazon States Language (AWS Step Functions). */

import { ENVELOPE_KEY } from "../runtime/envelope.js";
import type { WorkflowDefinitionData } from "../runtime/manifest.js";

export type ArnResolver = (fn: string) => string;
type Obj = Record<string, unknown>;

function errors(list: unknown): string[] {
  const values = Array.isArray(list) && list.length ? (list as string[]) : ["*"];
  return values.map((e) => (e === "*" || e === "States.ALL" ? "States.ALL" : e));
}

function typed(op: string, value: unknown): string {
  if (typeof value === "boolean") return "Boolean" + op;
  if (typeof value === "number") return "Numeric" + op;
  return "String" + op;
}

const CMP: Record<string, string> = { gt: "GreaterThan", gte: "GreaterThanEquals", lt: "LessThan", lte: "LessThanEquals" };

export function compileRule(rule: Obj): Obj {
  if (Array.isArray(rule.and)) return { And: rule.and.map((r) => compileRule(r as Obj)) };
  if (Array.isArray(rule.or)) return { Or: rule.or.map((r) => compileRule(r as Obj)) };
  if (rule.not && typeof rule.not === "object") return { Not: compileRule(rule.not as Obj) };
  const variable = typeof rule.variable === "string" ? rule.variable : "$";
  if ("equals" in rule) {
    const value = rule.equals;
    if (value === null) return { Variable: variable, IsNull: true };
    if (typeof value === "object") throw new Error(`ASL cannot compare objects/arrays with equals: ${JSON.stringify(rule)}`);
    return { Variable: variable, [typed("Equals", value)]: value };
  }
  if ("notEquals" in rule) return { Not: compileRule({ variable, equals: rule.notEquals }) };
  for (const [op, name] of Object.entries(CMP)) {
    if (op in rule) {
      const value = rule[op];
      if (typeof value === "boolean") throw new Error(`operator ${op} cannot compare booleans`);
      return { Variable: variable, [typed(name, value)]: value };
    }
  }
  if (Array.isArray(rule.in)) return { Or: rule.in.map((v) => compileRule({ variable, equals: v })) };
  if ("contains" in rule) {
    const needle = String(rule.contains).replace(/\*/g, "\\*");
    return { Variable: variable, StringMatches: `*${needle}*` };
  }
  if ("matches" in rule) return { Variable: variable, StringMatches: rule.matches };
  if ("isNull" in rule) return { Variable: variable, IsNull: Boolean(rule.isNull) };
  if ("isPresent" in rule) return { Variable: variable, IsPresent: Boolean(rule.isPresent) };
  throw new Error(`unsupported choice rule: ${JSON.stringify(rule)}`);
}

function flow(state: Obj, out: Obj): void {
  if (state.next) out.Next = state.next;
  else out.End = true;
}

function io(state: Obj, out: Obj): void {
  if (state.inputPath) out.InputPath = state.inputPath;
  if ("resultPath" in state && state.resultPath !== "$") out.ResultPath = state.resultPath;
}

export function compileMachine(machine: WorkflowDefinitionData, arnOf: ArnResolver): Obj {
  const states: Obj = {};
  for (const [name, st] of Object.entries(machine.states)) {
    const kind = st.type;
    const out: Obj = {};
    if (st.comment) out.Comment = st.comment;
    switch (kind) {
      case "task":
        out.Type = "Task";
        out.Resource = arnOf(String(st.function));
        out.Parameters = { [ENVELOPE_KEY]: "workflow", "data.$": "$" };
        io(st, out);
        if (st.timeoutSeconds) out.TimeoutSeconds = Math.trunc(Number(st.timeoutSeconds));
        flow(st, out);
        break;
      case "pass":
        out.Type = "Pass";
        if ("result" in st) out.Result = st.result;
        io(st, out);
        flow(st, out);
        break;
      case "wait":
        out.Type = "Wait";
        if (st.secondsPath) out.SecondsPath = st.secondsPath;
        else out.Seconds = Math.trunc(Number(st.seconds ?? 0));
        if (st.inputPath) out.InputPath = st.inputPath;
        flow(st, out);
        break;
      case "choice":
        out.Type = "Choice";
        out.Choices = (st.choices as Obj[]).map((r) => ({ ...compileRule(r), Next: r.next }));
        if (st.default) out.Default = st.default;
        break;
      case "parallel":
        out.Type = "Parallel";
        out.Branches = (st.branches as WorkflowDefinitionData[]).map((b) => compileMachine(b, arnOf));
        io(st, out);
        flow(st, out);
        break;
      case "map":
        out.Type = "Map";
        if (st.itemsPath) out.ItemsPath = st.itemsPath;
        out.ItemProcessor = { ProcessorConfig: { Mode: "INLINE" }, ...compileMachine(st.iterator as WorkflowDefinitionData, arnOf) };
        if (st.maxConcurrency) out.MaxConcurrency = Math.trunc(Number(st.maxConcurrency));
        io(st, out);
        flow(st, out);
        break;
      case "succeed":
        out.Type = "Succeed";
        break;
      case "fail":
        out.Type = "Fail";
        if (st.error) out.Error = st.error;
        if (st.cause) out.Cause = st.cause;
        break;
      default:
        throw new Error(`unknown state type ${String(kind)}`);
    }
    if (kind === "task" || kind === "parallel" || kind === "map") {
      const retry = (st.retry as Obj[] | undefined) ?? [];
      if (retry.length) {
        out.Retry = retry.map((r) => {
          const rr: Obj = {
            ErrorEquals: errors(r.errors),
            IntervalSeconds: Math.max(1, Math.round(Number(r.intervalSeconds ?? 1))),
            MaxAttempts: Math.trunc(Number(r.maxAttempts ?? 3)),
            BackoffRate: Number(r.backoffRate ?? 2),
          };
          if (r.maxDelaySeconds) rr.MaxDelaySeconds = Math.trunc(Number(r.maxDelaySeconds));
          return rr;
        });
      }
      const catches = (st.catch as Obj[] | undefined) ?? [];
      if (catches.length) {
        out.Catch = catches.map((c) => ({
          ErrorEquals: errors(c.errors),
          Next: c.next,
          ResultPath: "resultPath" in c ? c.resultPath : "$.error",
        }));
      }
    }
    states[name] = out;
  }
  return { StartAt: machine.startAt, States: states };
}

export function compileAsl(definition: WorkflowDefinitionData, arnOf: ArnResolver, comment = "", timeout = 0): Obj {
  const asl: Obj = {};
  if (comment) asl.Comment = comment;
  Object.assign(asl, compileMachine(definition, arnOf));
  if (timeout) asl.TimeoutSeconds = Math.trunc(timeout);
  return asl;
}
