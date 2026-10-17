import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { PLATFORM_FILES, stagePayload } from "../../src/onprem/pack.mjs";
import {
  MESSAGES,
  chooseRuntime,
  prepareCommand,
  shellQuote,
  sshArgs,
  startCommand,
  stopCommand,
} from "../../src/onprem/runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/onprem");
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function temp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nskit-deploy-"));
  dirs.push(dir);
  return dir;
}

describe("runtime choice", () => {
  test("auto prefers a shipped binary, then system Node, then Docker", () => {
    expect(chooseRuntime({ runtime: "auto", bundledExecutable: "/opt/node", bundledVersion: "22.1.0", systemNode: "/usr/bin/node", systemVersion: "20.0.0", dockerOk: true })).toEqual({
      mode: "bundled",
      bin: "/opt/node",
      message: "",
    });
    expect(chooseRuntime({ runtime: "auto", bundledExecutable: "/opt/node", bundledRuns: false, systemNode: "/usr/bin/node", systemVersion: "20.0.0" }).mode).toBe("system");
    expect(chooseRuntime({ runtime: "auto", bundledVersion: "16.0.0", bundledExecutable: "/opt/node", dockerOk: true }).mode).toBe("docker");
    expect(chooseRuntime({ runtime: "auto" }).message).toBe(MESSAGES.none);
  });

  test("an explicit runtime fails with the same sentence the start scripts print", () => {
    expect(chooseRuntime({ runtime: "bundled" }).message).toBe(MESSAGES.bundledMissing);
    expect(chooseRuntime({ runtime: "bundled", bundledExecutable: "/opt/node", bundledRuns: false }).message).toBe(MESSAGES.bundledIncompatible);
    expect(chooseRuntime({ runtime: "bundled", bundledExecutable: "/opt/node", bundledVersion: "16.0.0" }).message).toBe(MESSAGES.bundledOld);
    expect(chooseRuntime({ runtime: "system" }).message).toBe(MESSAGES.systemMissing);
    expect(chooseRuntime({ runtime: "system", systemNode: "/usr/bin/node", systemVersion: "12.0.0" }).message).toBe(MESSAGES.systemOld);
    expect(chooseRuntime({ runtime: "docker", dockerOk: false }).message).toBe(MESSAGES.dockerMissing);
    expect(chooseRuntime({ runtime: "docker", dockerOk: true }).mode).toBe("docker");
  });
});

describe("ssh command lines", () => {
  const env = {
    NSKIT_SSH_HOST: "10.0.0.8",
    NSKIT_SSH_USER: "ops",
    NSKIT_SSH_PORT: "2222",
    NSKIT_SSH_KEY: "C:/keys/id",
    NSKIT_SSH_STRICT: "1",
    NSKIT_REMOTE_DIR: "nskit/demo-dev",
    NSKIT_TARGET_OS: "linux",
  };

  test("quotes, key path and host checking stay out of a remote shell", () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
    expect(sshArgs(env)).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-i",
      "C:/keys/id",
      "-p",
      "2222",
      "ops@10.0.0.8",
    ]);
    expect(prepareCommand(env)).toContain('"$HOME/nskit/demo-dev"');
    expect(prepareCommand(env)).toContain("mkdir -p");
    expect(prepareCommand({ ...env, NSKIT_TARGET_OS: "windows", NSKIT_REMOTE_DIR: "nskit/demo-dev" })).toContain("USERPROFILE");
    expect(prepareCommand({ ...env, NSKIT_TARGET_OS: "windows", NSKIT_REMOTE_DIR: "C:/nskit/demo" })).toContain("C:\\nskit\\demo");
    const abs = "/opt/nskit/demo-dev";
    expect(startCommand(env, abs)).toContain(`sh ${shellQuote(`${abs}/platform/start.sh`)}`);
    expect(startCommand({ ...env, NSKIT_TARGET_OS: "windows" }, "C:/nskit/demo")).toContain("start.ps1");
    expect(stopCommand(env, abs)).toContain("stop.sh");
    for (const command of [prepareCommand(env), startCommand(env, abs), stopCommand(env, abs)]) {
      expect(command).not.toMatch(/\bpython3?\b/);
    }
  });
});

describe("bundle folder", () => {
  test("copies the app, the start scripts and an optional Node binary", () => {
    const dir = temp();
    const app = path.join(dir, "app");
    const platform = path.join(dir, "platform");
    mkdirSync(app);
    mkdirSync(platform);
    writeFileSync(path.join(app, "index.js"), "exports.handler = () => ({});\n");
    for (const file of PLATFORM_FILES) {
      if (file === "platform.json") writeFileSync(path.join(platform, file), "{}\n");
      else copyFileSync(path.join(root, file), path.join(platform, file));
    }
    const binary = path.join(dir, "node-bin");
    writeFileSync(binary, "binary");
    const dest = path.join(dir, "bundle");
    stagePayload({
      dest,
      appDir: app,
      platformDir: platform,
      nodeBinary: binary,
      targetOs: "linux",
      envVars: {
        NSKIT_RUNTIME: "bundled",
        NSKIT_SERVICE: "process",
        NSKIT_TARGET_OS: "linux",
        NSKIT_HTTP_PORT: "8080",
        NSKIT_PUBLISH: "10.1.0.4",
        NSKIT_NODE_IMAGE: "node:22-bookworm-slim",
        NSKIT_REDIS_IMAGE: "redis:7-alpine",
        NSKIT_MINIO_IMAGE: "minio/minio:RELEASE.2025-04-22T22-12-26Z",
        NSKIT_DEPLOY_REDIS: "0",
        NSKIT_DEPLOY_MINIO: "0",
        NSKIT_MINIO_USER: "",
        NSKIT_MINIO_PASSWORD: "",
        NSKIT_CONTAINER: "demo-dev-platform",
        NSKIT_SERVICE_NAME: "demo",
        NSKIT_STAGE: "dev",
        NSKIT_SYSTEMD_SCOPE: "user",
        NSKIT_STORAGE_DIR: "",
      },
    });
    expect(readFileSync(path.join(dest, "app", "index.js"), "utf-8")).toContain("handler");
    expect(readFileSync(path.join(dest, "runtime", "node"), "utf-8")).toBe("binary");
    expect(readFileSync(path.join(dest, "platform", "launch.env"), "utf-8")).toContain("NSKIT_PUBLISH=10.1.0.4");
    expect(readFileSync(path.join(dest, "START.txt"), "utf-8")).toContain("http://10.1.0.4:8080");
    const start = readFileSync(path.join(dest, "platform", "start.sh"), "utf-8");
    const ps1 = readFileSync(path.join(dest, "platform", "start.ps1"), "utf-8");
    for (const message of [
      MESSAGES.bundledMissing,
      MESSAGES.bundledIncompatible,
      MESSAGES.bundledOld,
      MESSAGES.systemMissing,
      MESSAGES.systemOld,
      MESSAGES.dockerMissing,
      MESSAGES.none,
      MESSAGES.systemdNeedsNode,
      MESSAGES.containersNeedDocker,
      MESSAGES.imageMissing,
    ]) {
      expect(start, message).toContain(message);
      if (message !== MESSAGES.systemdNeedsNode) expect(ps1, message).toContain(message);
    }
  });
});

function hasSh(): boolean {
  return spawnSync("sh", ["-c", "exit 0"], { stdio: "ignore" }).status === 0;
}

function locateSh(): string | null {
  if (process.platform === "win32") {
    const result = spawnSync("where.exe", ["sh"], { encoding: "utf8" });
    if (result.status !== 0) return null;
    const lines = (result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.find((line) => !line.toLowerCase().endsWith(".cmd")) || lines[0] || null;
  }
  const result = spawnSync("sh", ["-c", "command -v sh"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return (result.stdout || "").trim() || null;
}

/**
 * A PATH that contains sh and nothing else. Replacing PATH with the platform
 * directory makes Node unable to spawn sh (status null, empty stderr). Dropping
 * every directory that contains docker also drops dirname on Ubuntu, where
 * /usr/bin holds both. The start script resolves its own directory with builtins.
 */
function pathWithOnlySh(): string {
  const sh = locateSh();
  if (!sh) return "";
  const bin = path.join(temp(), "bin");
  mkdirSync(bin);
  const dest = path.join(bin, process.platform === "win32" ? "sh.exe" : "sh");
  try {
    symlinkSync(sh, dest);
  } catch {
    if (process.platform === "win32") writeFileSync(path.join(bin, "sh.cmd"), `@echo off\r\n"${sh}" %*\r\n`);
    else {
      writeFileSync(dest, `#!${sh}\nexec "${sh}" "$@"\n`);
      chmodSync(dest, 0o755);
    }
  }
  return bin;
}

function plant(runtime: string, node: "none" | "ok" | "old" | "bad"): { platform: string } {
  const dir = temp();
  const platform = path.join(dir, "platform");
  mkdirSync(platform);
  copyFileSync(path.join(root, "start.sh"), path.join(platform, "start.sh"));
  writeFileSync(path.join(platform, "launch.env"), `NSKIT_RUNTIME=${runtime}\n`);
  if (node !== "none") {
    mkdirSync(path.join(dir, "runtime"));
    const bin = path.join(dir, "runtime", "node");
    if (node === "bad") writeFileSync(bin, "not a binary\n");
    else {
      const version = node === "old" ? "16.20.0" : "22.14.0";
      writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "-p" ]; then printf '%s\\n' '${version}'; exit 0; fi\nexit 1\n`);
    }
    chmodSync(bin, 0o755);
  }
  return { platform };
}

function planSh(platform: string, pathEnv = process.env.PATH): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("sh", [path.join(platform, "start.sh"), "--plan"], {
    encoding: "utf8",
    env: { ...process.env, PATH: pathEnv },
  });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

describe.skipIf(!hasSh())("start.sh", () => {
  test("uses a shipped binary before the system node", () => {
    const { platform } = plant("auto", "ok");
    const result = planSh(platform);
    expect(result.status).toBe(0);
    expect(result.stdout.split(/\r?\n/)[0]).toBe("bundled");
  });

  test("ignores a shipped binary that is too old or cannot run", () => {
    const old = planSh(plant("auto", "old").platform);
    expect(old.status).toBe(0);
    expect(old.stdout.split(/\r?\n/)[0]).toBe("system");
    const bad = planSh(plant("bundled", "bad").platform);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain(MESSAGES.bundledIncompatible);
  });

  test("says what is missing when the server has no Node and no Docker", () => {
    const hidden = pathWithOnlySh();
    expect(hidden).not.toBe("");
    const result = planSh(plant("auto", "none").platform, hidden);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(MESSAGES.none);
    const system = planSh(plant("system", "none").platform, hidden);
    expect(system.status).toBe(1);
    expect(system.stderr).toContain(MESSAGES.systemMissing);
  });
});

function powershellBin(): string | null {
  for (const bin of ["powershell", "pwsh"]) {
    if (spawnSync(bin, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status === 0) return bin;
  }
  return null;
}

const psBin = powershellBin();

function planPs(platform: string, env: NodeJS.ProcessEnv = process.env): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    psBin || "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(platform, "start.ps1"), "-PlanOnly"],
    { encoding: "utf8", env },
  );
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

describe.skipIf(psBin === null)("start.ps1", () => {
  test("reports the system Node, a shipped node.exe, or a clear miss", () => {
    const dir = temp();
    const platform = path.join(dir, "platform");
    mkdirSync(platform);
    copyFileSync(path.join(root, "start.ps1"), path.join(platform, "start.ps1"));
    writeFileSync(path.join(platform, "launch.env"), "NSKIT_RUNTIME=system\n");
    const system = planPs(platform);
    expect(system.status).toBe(0);
    expect(system.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0]).toBe("system");

    mkdirSync(path.join(dir, "runtime"));
    const exe = path.join(dir, "runtime", "node.exe");
    try {
      // Same file as this process. A copy would be tens of megabytes.
      linkSync(process.execPath, exe);
    } catch {
      copyFileSync(process.execPath, exe);
    }
    writeFileSync(path.join(platform, "launch.env"), "NSKIT_RUNTIME=auto\n");
    const bundled = planPs(platform);
    expect(bundled.status).toBe(0);
    expect(bundled.stdout).toContain("bundled");

    rmSync(exe);
    writeFileSync(exe, "not a binary");
    writeFileSync(path.join(platform, "launch.env"), "NSKIT_RUNTIME=bundled\n");
    const bad = planPs(platform);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("does not run");
    expect(existsSync(exe)).toBe(true);
  });
});
