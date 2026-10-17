/**
 * The bundle manifest describes every function in a deployment artifact.
 *
 * The CLI generates an entry module per deployment that calls
 * {@link installBundle} with the manifest and a lazy handler table, so a single
 * shared artifact can serve many functions (Azure Function Apps, the embedded
 * workflow engine, ...) without depending on per-function files.
 */

import { HandlerNotFound } from "./errors.js";
import { getEnv } from "./util.js";

export const MANIFEST_FILE = "nskit_manifest.json";

export interface CorsSpec {
  origins?: string[];
  methods?: string[] | null;
  headers?: string[] | null;
  exposeHeaders?: string[];
  allowCredentials?: boolean;
  maxAge?: number;
}

export interface RouteSpec {
  method: string;
  path: string;
  cors?: CorsSpec | null;
}

export interface FunctionSpec {
  name: string;
  handler: string;
  routes: RouteSpec[];
  timeout?: number;
  memory?: number;
  resourceName?: string;
}

export interface WorkflowSpec {
  orchestrator: string;
  definition: WorkflowDefinitionData;
}

/** Plain-data workflow definition, as consumed by the engine and the compilers. */
export interface WorkflowDefinitionData {
  startAt: string;
  states: Record<string, Record<string, unknown>>;
}

export interface BundleManifest {
  service: string;
  stage: string;
  provider: string;
  region: string;
  version?: string;
  functions: Record<string, Omit<FunctionSpec, "name"> & { name?: string }>;
  workflows: Record<string, WorkflowSpec>;
}

/** A handler function as exported by user code. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyHandler = (event: any, context: any) => unknown;

/** `handler reference -> lazy loader`, generated into the entry module. */
export type HandlerTable = Record<string, () => unknown>;

export interface Bundle {
  manifest: BundleManifest;
  handlers: HandlerTable;
}

// State lives on globalThis so every loaded copy of the runtime (ESM and CJS
// builds, the main and `testing` entry points) sees the same installed bundle.
interface RuntimeState {
  bundle?: Bundle;
  resolved: Map<string, AnyHandler>;
}
const STATE_KEY = Symbol.for("node_serverless_kit.runtime-state");
function state(): RuntimeState {
  const g = globalThis as unknown as Record<symbol, RuntimeState | undefined>;
  return (g[STATE_KEY] ??= { resolved: new Map() });
}

function emptyManifest(): BundleManifest {
  return {
    service: getEnv("NSKIT_SERVICE", "")!,
    stage: getEnv("NSKIT_STAGE", "")!,
    provider: getEnv("NSKIT_PROVIDER", "local")!,
    region: getEnv("NSKIT_REGION", "")!,
    functions: {},
    workflows: {},
  };
}

/** What {@link installBundle} accepts: every manifest field is optional (missing ones come from NSKIT_* env). */
export interface BundleInput {
  manifest?: Partial<Omit<BundleManifest, "functions" | "workflows">> & {
    functions?: Record<string, Partial<Omit<FunctionSpec, "name" | "handler">> & { handler: string; name?: string }>;
    workflows?: Record<string, WorkflowSpec>;
  };
  handlers?: HandlerTable;
}

/** Install the manifest and handler table (called by the generated entry and by local tools). */
export function installBundle(bundle: BundleInput): void {
  const st = state();
  const functions: BundleManifest["functions"] = {};
  for (const [name, spec] of Object.entries(bundle.manifest?.functions ?? {})) functions[name] = { ...spec, routes: spec.routes ?? [] };
  st.bundle = {
    manifest: { ...emptyManifest(), ...(bundle.manifest ?? {}), functions, workflows: { ...(bundle.manifest?.workflows ?? {}) } },
    handlers: { ...(bundle.handlers ?? {}) },
  };
  st.resolved.clear();
}

function current(): Bundle {
  return (state().bundle ??= { manifest: emptyManifest(), handlers: {} });
}

export function getManifest(): BundleManifest {
  return current().manifest;
}

export function getBundle(): Bundle {
  return current();
}

/** Find the spec for `name` (default: `$NSKIT_FUNCTION`). */
export function resolveFunction(name?: string): FunctionSpec {
  const manifest = current().manifest;
  const wanted = name || getEnv("NSKIT_FUNCTION", "")!;
  if (wanted && manifest.functions[wanted]) {
    const spec = manifest.functions[wanted];
    return { ...spec, routes: spec.routes ?? [], name: wanted };
  }
  const handler = getEnv("NSKIT_HANDLER");
  if (handler) return { name: wanted || handler, handler, routes: [] };
  const names = Object.keys(manifest.functions);
  if (names.length === 1 && !wanted) {
    const spec = manifest.functions[names[0]];
    return { ...spec, routes: spec.routes ?? [], name: names[0] };
  }
  throw new HandlerNotFound(
    `Cannot resolve function ${JSON.stringify(wanted)}. Set NSKIT_FUNCTION or check the bundle manifest. ` +
      `Known functions: ${names.sort().join(", ") || "<none>"}`,
  );
}

/** Look up a handler by reference (`src/orders.getOrder`), loading its module on first use. */
export async function resolveHandler(ref: string): Promise<AnyHandler> {
  const { resolved } = state();
  const cached = resolved.get(ref);
  if (cached) return cached;
  const loader = current().handlers[ref];
  if (!loader) {
    throw new HandlerNotFound(
      `Handler ${JSON.stringify(ref)} is not in this bundle. Known: ${Object.keys(current().handlers).sort().join(", ") || "<none>"}`,
    );
  }
  let fn = await loader();
  // Support `module.exports = fn` / `export default fn` resolved through an interop wrapper.
  if (fn && typeof fn === "object" && typeof (fn as { default?: unknown }).default === "function") {
    fn = (fn as { default: unknown }).default;
  }
  if (typeof fn !== "function") {
    throw new HandlerNotFound(`Handler ${JSON.stringify(ref)} is not a function (got ${typeof fn})`);
  }
  resolved.set(ref, fn as AnyHandler);
  return fn as AnyHandler;
}
