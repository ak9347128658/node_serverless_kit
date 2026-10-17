/**
 * Programmatic API: everything the `nskit` CLI does, as functions.
 *
 * ```ts
 * import { Project, Deployer } from "node_serverless_kit/api";
 * const project = Project.load("nskit.yml", { stage: "prod" });
 * const record = await new Deployer(project).deploy();
 * ```
 */

export { ConfigError, buildRaw, deepMerge, findConfig, loadConfig, parseConfig, type LoadOptions, type LoadedConfig } from "./config/loader.js";
export * from "./config/schema.js";
export { Project, expand, locateHandler, orchestratorName, WORK_DIR } from "./core/project.js";
export { Deployer, DeployError, type DeployOptions, type PackageResult } from "./core/deployer.js";
export { buildRecord, RECORD_FILE, type DeploymentRecord, type FunctionRecord, type WorkflowRecord } from "./core/describe.js";
export { buildArtifact, BuildError } from "./packaging/builder.js";
export {
  Provider,
  ProviderError,
  RenderContext,
  Issue,
  HTTP,
  SCHEDULE,
  QUEUE,
  STORAGE,
  TOPIC,
  WORKFLOW_NATIVE,
  type Artifact,
  type BundleTarget,
  type Capability,
  type EntryContext,
  type Tier,
} from "./providers/base.js";
export { allProviders, available, getProvider, loadProviderPlugins, registerProvider } from "./providers/registry.js";
export { TerraformDoc, escape, ref, tfId } from "./providers/terraform-doc.js";
export { ScheduleError } from "./providers/schedule.js";
export { TerraformRunner, TerraformError, findBinary } from "./terraform/runner.js";
export { compileAsl } from "./workflows/asl.js";
export { definitionData } from "./workflows/index.js";
export { LocalRunner } from "./local/runner.js";
export { VERSION } from "./version.js";
export { collectRecords, renderHtml, writeDashboard, serveDashboard, dashboardPath, type DashboardRecord } from "./dashboard/generator.js";
