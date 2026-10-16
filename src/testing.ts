/**
 * Testing helpers: `import { LocalRunner } from "node-serverless-kit/testing"`.
 *
 * ```ts
 * const runner = await LocalRunner.fromConfig("nskit.yml");
 * const res = await runner.http("GET", "/hello?name=Ada");
 * expect(res.json()).toEqual({ message: "Hello, Ada!" });
 * ```
 */

export {
  LocalRunner,
  type HttpCallOptions,
  type LocalHttpResponse,
  type LocalRunnerOptions,
  type RouteMatch,
  type WorkflowRunResult,
} from "./local/runner.js";
export { Context } from "./runtime/context.js";
export { Event, EventRecord, EventType, HttpRequest } from "./runtime/event.js";
export { installBundle } from "./runtime/manifest.js";
export { execute } from "./runtime/dispatch.js";
export { WorkflowEngine, WorkflowFailed } from "./runtime/workflow.js";
export { setLogSink } from "./runtime/log.js";
export { setEnv } from "./runtime/util.js";
