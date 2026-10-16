import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Deployer, DeployError } from "../../src/core/deployer.js";
import type { DeploymentRecord } from "../../src/core/describe.js";
import { TerraformRunner } from "../../src/terraform/runner.js";
import { dedent, makeProject, type TempProject } from "../helpers.js";

/** Records calls instead of running terraform. */
class FakeRunner extends TerraformRunner {
  readonly calls: string[] = [];
  outputs: Record<string, unknown> = {};
  planHasChanges = true;

  override init(options: { upgrade?: boolean } = {}): void {
    this.calls.push(`init${options.upgrade ? " -upgrade" : ""}`);
  }
  override plan(options: { destroy?: boolean; out?: string | null } = {}): boolean {
    this.calls.push(`plan${options.destroy ? " -destroy" : ""}${options.out ? ` -out ${options.out}` : ""}`);
    return this.planHasChanges;
  }
  override apply(options: { planFile?: string; autoApprove?: boolean } = {}): void {
    this.calls.push(`apply ${options.planFile ?? (options.autoApprove ? "-auto-approve" : "")}`.trim());
  }
  override destroy(options: { autoApprove?: boolean } = {}): void {
    this.calls.push(`destroy${options.autoApprove ? " -auto-approve" : ""}`);
  }
  override output(): Record<string, unknown> {
    this.calls.push("output");
    return this.outputs;
  }
}

/** A hook script that appends `<name> <NSKIT_* env>` as a JSON line to hooks.log. */
const HOOK = dedent(`
  const fs = require("node:fs");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("NSKIT_") && k !== "NSKIT_TEST_HOME"));
  fs.appendFileSync("hooks.log", JSON.stringify({ hook: process.argv[2], cwd: process.cwd(), env }) + "\\n");
  if (process.argv[2] === "fail") process.exit(3);
`);

function hookYaml(hooks: string[]): string {
  return hooks.map((h) => `  ${h}: "node hook.cjs ${h}"`).join("\n");
}

const CONFIG = (hooks: string[] = []) => `
service: deploy
provider: {name: aws, region: eu-west-1}
functions:
  hello: {handler: src/handlers.hello, events: [{http: GET /hello}]}
${hooks.length ? `hooks:\n${hookYaml(hooks)}\n` : ""}`;

function setup(hooks: string[] = []): { tmp: TempProject; deployer: Deployer; runner: FakeRunner; logs: string[] } {
  const tmp = makeProject(CONFIG(hooks), { "hook.cjs": HOOK });
  const project = tmp.load();
  const runner = new FakeRunner(project.workDir, { echo: () => undefined });
  const logs: string[] = [];
  const deployer = new Deployer(project, (m) => logs.push(m), runner);
  return { tmp, deployer, runner, logs };
}

function hookLog(root: string): { hook: string; cwd: string; env: Record<string, string> }[] {
  const file = path.join(root, "hooks.log");
  return existsSync(file)
    ? readFileSync(file, "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];
}

describe("package", () => {
  it("writes main.tf.json, .gitignore and the artifact; runs package hooks with NSKIT_* env", async () => {
    const { tmp, deployer, logs } = setup(["beforePackage", "afterPackage"]);
    const result = await deployer.package({ skipInstall: true });
    const workDir = deployer.project.workDir;
    expect(result.tfFile).toBe(path.join(workDir, "main.tf.json"));
    const tf = JSON.parse(readFileSync(result.tfFile, "utf-8"));
    expect(tf.resource.aws_lambda_function.hello.function_name).toBe("deploy-dev-hello");
    expect(tf.resource.aws_s3_object.artifact.source_hash).toBe(result.artifact.sha256);
    expect(result.resourceCount).toBe(Object.values(tf.resource as Record<string, object>).reduce((n, b) => n + Object.keys(b).length, 0));
    expect(result.warnings).toEqual([]);
    expect(existsSync(result.artifact.path)).toBe(true);
    expect(readFileSync(path.join(tmp.root, ".nskit", ".gitignore"), "utf-8")).toContain("*\n");
    expect(logs.some((l) => l.startsWith("Packaging deploy for AWS Lambda (dev)"))).toBe(true);
    expect(logs.some((l) => /terraform: \d+ resource\(s\) -> \.nskit[\\/]aws-dev[\\/]main\.tf\.json/.test(l))).toBe(true);

    const hooks = hookLog(tmp.root);
    expect(hooks.map((h) => h.hook)).toEqual(["beforePackage", "afterPackage"]);
    expect(hooks[0].env).toMatchObject({ NSKIT_SERVICE: "deploy", NSKIT_STAGE: "dev", NSKIT_PROVIDER: "aws", NSKIT_WORK_DIR: workDir });
    expect(path.resolve(hooks[0].cwd)).toBe(tmp.root);
  });

  it("keeps an existing .gitignore", async () => {
    const { tmp, deployer } = setup();
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.join(tmp.root, ".nskit"), { recursive: true });
    writeFileSync(path.join(tmp.root, ".nskit", ".gitignore"), "custom\n");
    await deployer.package({ skipInstall: true });
    expect(readFileSync(path.join(tmp.root, ".nskit", ".gitignore"), "utf-8")).toBe("custom\n");
  });

  it("refuses to package an invalid project", async () => {
    const tmp = makeProject("service: bad\nprovider: {name: aws}\nfunctions: {a: {handler: src/missing.fn}}\n");
    const logs: string[] = [];
    const deployer = new Deployer(tmp.load(), (m) => logs.push(m), new FakeRunner(tmp.root));
    await expect(deployer.package({ skipInstall: true })).rejects.toThrow(DeployError);
    await expect(deployer.package({ skipInstall: true })).rejects.toThrow("1 configuration error(s); fix them and retry");
    expect(logs.some((l) => l.includes("ERROR: [functions.a.handler]"))).toBe(true);
    expect(existsSync(path.join(tmp.root, ".nskit", "aws-dev", "main.tf.json"))).toBe(false);
  });

  it("check() returns warnings without failing", () => {
    const tmp = makeProject(`
      service: warn
      provider: {name: aws}
      functions: {a: {handler: src/handlers.step}}
      workflows: {w: {engine: embedded, start_at: A, states: {A: {type: task, function: a}}}}
    `);
    const deployer = new Deployer(tmp.load(), () => undefined, new FakeRunner(tmp.root));
    expect(deployer.check().map((i) => i.level)).toEqual(["warning"]);
  });

  it("a failing hook aborts with DeployError", async () => {
    const tmp = makeProject(CONFIG() + 'hooks:\n  beforePackage: ["node hook.cjs ok", "node hook.cjs fail", "node hook.cjs never"]\n', { "hook.cjs": HOOK });
    const deployer = new Deployer(tmp.load(), () => undefined, new FakeRunner(tmp.root));
    await expect(deployer.package({ skipInstall: true })).rejects.toThrow(/hook beforePackage failed \(3\): node hook.cjs fail/);
    expect(hookLog(tmp.root).map((h) => h.hook)).toEqual(["ok", "fail"]);
  });
});

describe("deploy / remove", () => {
  it("deploy applies, reads outputs and writes the deployment record", async () => {
    const { tmp, deployer, runner } = setup(["beforePackage", "afterPackage", "beforeDeploy", "afterDeploy"]);
    runner.outputs = {
      nskit: { functions: { hello: { id: "deploy-dev-hello", base_url: "https://api.example" } }, workflows: {}, endpoint: "https://api.example" },
    };
    const record = await deployer.deploy({ skipInstall: true, upgrade: true });
    expect(runner.calls).toEqual(["init -upgrade", "apply -auto-approve", "output"]);
    expect(record.status).toBe("deployed");
    expect(record.endpoint).toBe("https://api.example");
    expect(record.functions[0].urls).toEqual([{ method: "GET", url: "https://api.example/hello" }]);
    const saved = JSON.parse(readFileSync(path.join(deployer.project.workDir, "deployment.json"), "utf-8")) as DeploymentRecord;
    expect(saved).toEqual(record);
    expect(saved.artifact).toEqual({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/), size: expect.any(Number), files: 4 });
    expect(deployer.loadRecord()).toEqual(record);
    expect(hookLog(tmp.root).map((h) => h.hook)).toEqual(["beforePackage", "afterPackage", "beforeDeploy", "afterDeploy"]);
  });

  it("autoApprove: false plans first and applies the plan file", async () => {
    const { deployer, runner } = setup();
    await deployer.deploy({ skipInstall: true, autoApprove: false });
    expect(runner.calls).toEqual(["init", "plan -out tfplan", "apply tfplan", "output"]);
    runner.calls.length = 0;
    runner.planHasChanges = false;
    await deployer.deploy({ skipInstall: true, autoApprove: false });
    expect(runner.calls).toEqual(["init", "plan -out tfplan", "output"]);
  });

  it("plan packages and runs a plan without saving it", async () => {
    const { deployer, runner } = setup();
    expect(await deployer.plan({ skipInstall: true, destroy: true })).toBe(true);
    expect(runner.calls).toEqual(["init", "plan -destroy"]);
  });

  it("remove destroys and marks the record as removed", async () => {
    const { tmp, deployer, runner } = setup(["beforeRemove", "afterRemove"]);
    await deployer.deploy({ skipInstall: true });
    runner.calls.length = 0;
    await deployer.remove();
    expect(runner.calls).toEqual(["init", "destroy -auto-approve"]);
    expect(deployer.loadRecord()?.status).toBe("removed");
    expect(hookLog(tmp.root).map((h) => h.hook)).toEqual(["beforeRemove", "afterRemove"]);
  });

  it("remove re-renders when main.tf.json is missing and tolerates a missing record", async () => {
    const { deployer, runner } = setup();
    rmSync(deployer.project.workDir, { recursive: true, force: true });
    await deployer.remove({ autoApprove: false });
    expect(existsSync(path.join(deployer.project.workDir, "main.tf.json"))).toBe(true);
    expect(runner.calls).toEqual(["init", "destroy"]);
    expect(deployer.loadRecord()).toBeUndefined();
  });

  it("refreshInfo rebuilds the record from outputs and keeps the artifact info", async () => {
    const { deployer, runner } = setup();
    await deployer.deploy({ skipInstall: true });
    const before = deployer.loadRecord()!;
    runner.outputs = { nskit: { functions: { hello: { id: "new-id" } }, endpoint: "https://new" } };
    const record = deployer.refreshInfo();
    expect(record.endpoint).toBe("https://new");
    expect(record.functions[0].id).toBe("new-id");
    expect(record.artifact).toEqual(before.artifact);
    expect(deployer.loadRecord()).toEqual(record);
  });

  it("creates a real TerraformRunner lazily", () => {
    const tmp = makeProject(CONFIG());
    const deployer = new Deployer(tmp.load(), () => undefined);
    expect(deployer.runner).toBeInstanceOf(TerraformRunner);
    expect(deployer.runner.workDir).toBe(deployer.project.workDir);
    expect(deployer.runner).toBe(deployer.runner);
  });
});
