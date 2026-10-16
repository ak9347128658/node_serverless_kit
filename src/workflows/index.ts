/**
 * Workflow (state machine) compilers.
 *
 * One portable definition in `nskit.yml` -> AWS Step Functions (ASL), Google
 * Cloud Workflows, or the embedded engine in `runtime/workflow.ts`.
 */

import type { WorkflowDefinition } from "../config/schema.js";
import type { WorkflowDefinitionData } from "../runtime/manifest.js";

const CONFIG_ONLY = new Set(["description", "engine", "timeout", "options"]);

function clean(value: unknown, top: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => clean(v, false));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (top && CONFIG_ONLY.has(k)) continue;
      if (k === "resultPath") {
        out[k] = v === undefined ? "$" : v; // null is meaningful ("discard result")
      } else if (k === "choices" && Array.isArray(v) && v.length) {
        out[k] = structuredClone(v); // rule values are data: `equals: null`, `in: []` must survive
      } else if (k === "result" && v !== undefined) {
        out[k] = structuredClone(v); // a pass state's `result: null` / `[]` / `{}` is a real result
      } else if (v === undefined || v === null || (Array.isArray(v) && !v.length) || (k === "end" && v === false)) {
        continue;
      } else {
        out[k] = clean(v, false);
      }
    }
    return out;
  }
  return value;
}

/** Plain-data form of a workflow consumed by the engine and the compilers. */
export function definitionData(wf: WorkflowDefinition): WorkflowDefinitionData {
  return clean(wf, true) as WorkflowDefinitionData;
}
