/**
 * Local adapter: re-exports the runtime pieces the CLI's local tools need.
 *
 * `nskit dev` / `nskit invoke` / `LocalRunner` (bundle mode) build the project
 * with this glue and drive everything through the copy of the runtime that
 * lives *inside* the bundle, so `instanceof` checks and module state behave
 * exactly as in the cloud.
 */

export { BatchResult, isBatchResult } from "../batch.js";
export { Context } from "../context.js";
export { execute } from "../dispatch.js";
export { envelope } from "../envelope.js";
export { Event, EventRecord, EventType, HttpRequest } from "../event.js";
export { getBundle, getManifest, installBundle } from "../manifest.js";
export { HttpResponse, isHttpResponse } from "../response.js";
export { matchPath, methodMatches } from "../routing.js";
export { setEnv } from "../util.js";
export { inProcessRunner, WorkflowEngine, WorkflowFailed } from "../workflow.js";
