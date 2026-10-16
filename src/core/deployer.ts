/** High level package / deploy / remove orchestration used by the CLI and the programmatic API. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildArtifact, type Log } from "../packaging/builder.js";
import { RenderContext, type Artifact, type Issue } from "../providers/base.js";
import { TerraformRunner } from "../terraform/runner.js";
import { buildRecord, RECORD_FILE, type DeploymentRecord } from "./describe.js";
import { WORK_DIR, type Project } from "./project.js";

export class DeployError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployError";
  }
}

export interface PackageResult {
  artifact: Artifact;
  tfFile: string;
  resourceCount: number;
  warnings: string[];
}

export interface DeployOptions {
  skipInstall?: boolean;
  /** `false` shows a plan and applies it (still non-interactive; use `nskit plan` to review first). */
  autoApprove?: boolean;
  upgrade?: boolean;
}

export class Deployer {
  private runnerInstance?: TerraformRunner;

  constructor(
    readonly project: Project,
    readonly echo: Log = (m) => console.log(m),
    runner?: TerraformRunner,
  ) {
    this.runnerInstance = runner;
  }

  get runner(): TerraformRunner {
    if (!this.runnerInstance) {
      const tf = this.project.config.provider.terraform;
      this.runnerInstance = new TerraformRunner(this.project.workDir, { binary: tf.binary, echo: this.echo });
    }
    return this.runnerInstance;
  }

  check(): Issue[] {
    const issues = this.project.validate();
    for (const issue of issues) this.echo(`  ${issue}`);
    const errors = issues.filter((i) => i.level === "error");
    if (errors.length) throw new DeployError(`${errors.length} configuration error(s); fix them and retry`);
    return issues;
  }

  runHook(name: string): void {
    const commands = this.project.config.hooks[name] ?? [];
    for (const cmd of commands) {
      this.echo(`  hook ${name}: ${cmd}`);
      const proc = spawnSync(cmd, {
        shell: true,
        cwd: this.project.root,
        stdio: "inherit",
        env: {
          ...process.env,
          NSKIT_SERVICE: this.project.config.service,
          NSKIT_STAGE: this.project.config.provider.stage,
          NSKIT_PROVIDER: this.project.config.provider.name,
          NSKIT_WORK_DIR: this.project.workDir,
        },
      });
      if (proc.status !== 0) throw new DeployError(`hook ${name} failed (${proc.status}): ${cmd}`);
    }
  }

  // ---------------------------------------------------------------- steps
  async package(options: { skipInstall?: boolean } = {}): Promise<PackageResult> {
    const { project } = this;
    this.check();
    mkdirSync(project.workDir, { recursive: true });
    writeGitignore(path.join(project.root, WORK_DIR));
    this.runHook("beforePackage");
    this.echo(`Packaging ${project.config.service} for ${project.provider.displayName} (${project.config.provider.stage})`);
    const artifact = await buildArtifact(project, { skipInstall: options.skipInstall, log: this.echo });
    const ctx = new RenderContext({
      config: project.config,
      provider: project.provider,
      root: project.root,
      workDir: project.workDir,
      artifact,
      region: project.region,
      workflowEngines: { ...project.engines },
    });
    const doc = project.provider.render(ctx);
    const tfFile = path.join(project.workDir, "main.tf.json");
    writeFileSync(tfFile, doc.toJSON(), "utf-8");
    for (const w of doc.warnings) this.echo(`  WARNING: ${w}`);
    this.echo(`  terraform: ${doc.count()} resource(s) -> ${path.relative(project.root, tfFile)}`);
    this.runHook("afterPackage");
    return { artifact, tfFile, resourceCount: doc.count(), warnings: [...doc.warnings] };
  }

  async plan(options: { skipInstall?: boolean; destroy?: boolean } = {}): Promise<boolean> {
    await this.package({ skipInstall: options.skipInstall });
    this.runner.init();
    return this.runner.plan({ destroy: options.destroy, out: null });
  }

  async deploy(options: DeployOptions = {}): Promise<DeploymentRecord> {
    const result = await this.package({ skipInstall: options.skipInstall });
    this.runHook("beforeDeploy");
    this.echo("Running terraform init");
    this.runner.init({ upgrade: options.upgrade });
    if (options.autoApprove ?? true) {
      this.echo("Running terraform apply");
      this.runner.apply({ autoApprove: true });
    } else if (!this.runner.plan({ out: "tfplan" })) {
      this.echo("No changes.");
    } else {
      this.runner.apply({ planFile: "tfplan" });
    }
    const outputs = this.runner.output();
    const record = buildRecord(this.project, outputs, {
      sha256: result.artifact.sha256,
      size: result.artifact.size,
      files: result.artifact.fileCount,
    });
    this.saveRecord(record);
    this.runHook("afterDeploy");
    return record;
  }

  async remove(options: { autoApprove?: boolean } = {}): Promise<void> {
    const { project } = this;
    if (!existsSync(path.join(project.workDir, "main.tf.json"))) {
      // Re-render so terraform knows the provider configuration.
      await this.package({ skipInstall: true });
    }
    this.runHook("beforeRemove");
    this.runner.init();
    this.runner.destroy({ autoApprove: options.autoApprove ?? true });
    const record = this.loadRecord();
    if (record) this.saveRecord({ ...record, status: "removed" });
    this.runHook("afterRemove");
  }

  refreshInfo(): DeploymentRecord {
    const outputs = this.runner.output();
    const previous = this.loadRecord();
    const record = buildRecord(this.project, outputs, previous?.artifact ?? {});
    this.saveRecord(record);
    return record;
  }

  // ---------------------------------------------------------------- record
  saveRecord(record: DeploymentRecord): string {
    const file = path.join(this.project.workDir, RECORD_FILE);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf-8");
    return file;
  }

  loadRecord(): DeploymentRecord | undefined {
    const file = path.join(this.project.workDir, RECORD_FILE);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as DeploymentRecord) : undefined;
  }
}

function writeGitignore(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, ".gitignore");
  if (!existsSync(file)) {
    writeFileSync(
      file,
      "# Generated by node-serverless-kit. Keep terraform state out of git -\n" +
        "# configure a remote backend (provider.state) for team use.\n*\n",
      "utf-8",
    );
  }
}
