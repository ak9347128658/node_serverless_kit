/** Terminal I/O for the CLI, injectable so tests can run `main()` in-process. */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import pc from "picocolors";
import type { Project } from "../core/project.js";
import type { TerraformRunner } from "../terraform/runner.js";

export type Colors = ReturnType<typeof pc.createColors>;

export interface CliIO {
  /** Write one line (or block) to stdout. */
  out(text: string): void;
  /** Write one line (or block) to stderr. */
  err(text: string): void;
  /** Whether colors are used. */
  color: boolean;
  /** Interactive terminal (enables confirmation prompts). */
  isTTY: boolean;
  /** Ask a yes/no question. */
  confirm(question: string): Promise<boolean>;
  /** Called with the final exit code. The default exits the process on non-zero codes. */
  exit(code: number): void;
  /** Build the Terraform runner for a project (tests inject a fake). */
  terraformRunner?: (project: Project, echo: (m: string) => void) => TerraformRunner;
  /** Open a URL in the browser. */
  openUrl(url: string): void;
  /**
   * Wait until the long-running command (dev server, dashboard --serve) should
   * stop. Default: SIGINT / SIGTERM.
   */
  waitForShutdown(): Promise<void>;
}

export function colorEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
  if ("NO_COLOR" in process.env && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(stream.isTTY) && process.env.TERM !== "dumb";
}

/** Open `url` with the platform's default handler (start / open / xdg-open). Never throws. */
export function openBrowser(url: string): void {
  try {
    const [cmd, args] =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', url.replace(/&/g, "^&")]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: "ignore", windowsVerbatimArguments: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* no browser available */
  }
}

export function defaultIO(): CliIO {
  return {
    out: (text) => process.stdout.write(text + "\n"),
    err: (text) => process.stderr.write(text + "\n"),
    color: colorEnabled(),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    },
    exit: (code) => {
      if (code !== 0) process.exit(code);
    },
    openUrl: openBrowser,
    waitForShutdown: () =>
      new Promise<void>((resolve) => {
        const stop = () => {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          resolve();
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
      }),
  };
}
