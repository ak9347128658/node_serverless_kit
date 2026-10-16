/** Thin, testable wrapper around the `terraform` / `tofu` binary. */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export class TerraformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerraformError";
  }
}

/** First of `candidates` found on PATH (honours PATHEXT on Windows). */
export function which(command: string): string | undefined {
  if (path.isAbsolute(command)) return existsSync(command) ? command : undefined;
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      if (existsSync(candidate)) return candidate;
      const upper = path.join(dir, command + ext);
      if (existsSync(upper)) return upper;
    }
  }
  return undefined;
}

export function findBinary(preferred?: string | null): string {
  const candidates = [preferred, process.env.NSKIT_TERRAFORM_BIN, "terraform", "tofu"].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const found = which(candidate);
    if (found) return found;
  }
  throw new TerraformError(
    "Neither `terraform` nor `tofu` was found on PATH. Install Terraform >= 1.5 " +
      "(https://developer.hashicorp.com/terraform/install) or OpenTofu, or set NSKIT_TERRAFORM_BIN.",
  );
}

export type Echo = (message: string) => void;

export interface TerraformRunnerOptions {
  binary?: string | null;
  env?: Record<string, string>;
  echo?: Echo;
}

export class TerraformRunner {
  private binary?: string | null;
  private readonly env: Record<string, string>;
  private readonly echo: Echo;

  constructor(
    readonly workDir: string,
    options: TerraformRunnerOptions = {},
  ) {
    this.binary = options.binary;
    this.env = options.env ?? {};
    this.echo = options.echo ?? ((m) => console.log(m));
  }

  private bin(): string {
    if (!this.binary || !existsSync(this.binary)) this.binary = findBinary(this.binary);
    return this.binary;
  }

  run(args: string[], options: { capture?: boolean; check?: boolean } = {}): SpawnSyncReturns<string> {
    const { capture = false, check = true } = options;
    const env = { TF_IN_AUTOMATION: "1", TF_INPUT: "0", ...process.env, ...this.env };
    const proc = spawnSync(this.bin(), args, {
      cwd: this.workDir,
      env,
      encoding: "utf-8",
      stdio: capture ? "pipe" : "inherit",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (proc.error) throw new TerraformError(`could not run ${this.bin()}: ${proc.error.message}`);
    if (check && proc.status !== 0) {
      const detail = capture ? (proc.stderr || proc.stdout || "").slice(-6000) : "";
      throw new TerraformError(`\`terraform ${args.slice(0, 2).join(" ")}\` failed with exit code ${proc.status}\n${detail}`.trimEnd());
    }
    return proc;
  }

  init(options: { upgrade?: boolean; reconfigure?: boolean } = {}): void {
    const args = ["init", "-input=false", "-no-color"];
    if (options.upgrade) args.push("-upgrade");
    if (options.reconfigure) args.push("-reconfigure");
    this.run(args);
  }

  validate(): void {
    this.run(["validate", "-no-color"]);
  }

  /** Returns `true` when the plan has changes. */
  plan(options: { destroy?: boolean; out?: string | null } = {}): boolean {
    const args = ["plan", "-input=false", "-no-color", "-detailed-exitcode"];
    if (options.destroy) args.push("-destroy");
    const out = options.out === undefined ? "tfplan" : options.out;
    if (out) args.push("-out", out);
    const proc = this.run(args, { check: false });
    if (proc.status === 1) throw new TerraformError("terraform plan failed");
    return proc.status === 2;
  }

  apply(options: { planFile?: string; autoApprove?: boolean } = {}): void {
    const args = ["apply", "-input=false", "-no-color"];
    if (options.planFile) args.push(options.planFile);
    else if (options.autoApprove ?? true) args.push("-auto-approve");
    this.run(args);
  }

  destroy(options: { autoApprove?: boolean } = {}): void {
    const args = ["destroy", "-input=false", "-no-color"];
    if (options.autoApprove ?? true) args.push("-auto-approve");
    this.run(args);
  }

  output(): Record<string, unknown> {
    const proc = this.run(["output", "-json", "-no-color"], { capture: true });
    let raw: Record<string, { value: unknown }>;
    try {
      raw = JSON.parse(proc.stdout || "{}");
    } catch (err) {
      throw new TerraformError(`could not parse terraform output: ${(err as Error).message}`);
    }
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v?.value]));
  }

  passthrough(args: string[]): number {
    return this.run(args, { check: false }).status ?? 1;
  }

  log(message: string): void {
    this.echo(message);
  }
}
