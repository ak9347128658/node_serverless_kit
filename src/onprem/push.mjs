/**
 * Copy a staged bundle to an on-premises server over OpenSSH and start it.
 *
 * Terraform runs this on the machine that has the nskit CLI (Node.js is
 * already there). The server is started by start.sh / start.ps1, which do
 * not need Python, npm, or a preinstalled Node.js.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stagePayload, varsFromEnv } from "./pack.mjs";
import { extractCommand, prepareCommand, sshArgs, startCommand, stopCommand } from "./runtime.mjs";

function toolMissing(error, tool) {
  return error && error.code === "ENOENT"
    ? `deploy ssh needs ${tool} on the machine that runs nskit. Python is not required.`
    : "";
}

function runSsh(env, remoteCommand, allowMissing = false) {
  const result = spawnSync("ssh", [...sshArgs(env), remoteCommand], { encoding: "utf8" });
  const missing = toolMissing(result.error, "the OpenSSH client (ssh)");
  if (missing) throw new Error(missing);
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    if (allowMissing && /No such file|cannot find|not found|cannot access/i.test(detail)) return "";
    throw new Error(detail || "ssh failed");
  }
  return (result.stdout || "").trim();
}

function upload(env, staging, absPath) {
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", ["-cf", "-", "-C", staging, "."]);
    const ssh = spawn("ssh", [...sshArgs(env), extractCommand(absPath)]);
    let err = "";
    tar.stdout.pipe(ssh.stdin);
    tar.stderr.on("data", (chunk) => {
      err += chunk;
    });
    ssh.stderr.on("data", (chunk) => {
      err += chunk;
    });
    tar.on("error", (error) => reject(new Error(toolMissing(error, "tar") || error.message)));
    ssh.on("error", (error) => reject(new Error(toolMissing(error, "the OpenSSH client (ssh)") || error.message)));
    let tarCode = null;
    let sshCode = null;
    const finish = () => {
      if (tarCode === null || sshCode === null) return;
      if (tarCode !== 0 || sshCode !== 0) reject(new Error(err.trim() || `upload failed (${tarCode}, ${sshCode})`));
      else resolve();
    };
    tar.on("close", (code) => {
      tarCode = code ?? 1;
      ssh.stdin.end();
      finish();
    });
    ssh.on("close", (code) => {
      sshCode = code ?? 1;
      finish();
    });
  });
}

export async function push(env) {
  const action = env.NSKIT_ACTION || "start";
  const abs = runSsh(env, prepareCommand(env), action === "stop").split(/\r?\n/).filter(Boolean).pop() || "";
  if (!abs) {
    if (action === "stop") return;
    throw new Error("the server did not report the deploy directory");
  }
  if (action === "stop") {
    runSsh(env, stopCommand(env, abs), true);
    return;
  }
  const staging = mkdtempSync(path.join(os.tmpdir(), "nskit-push-"));
  try {
    stagePayload({
      dest: staging,
      appDir: env.NSKIT_APP_DIR,
      platformDir: env.NSKIT_PLATFORM_DIR,
      nodeBinary: env.NSKIT_NODE_BINARY || "",
      targetOs: env.NSKIT_TARGET_OS || "linux",
      envVars: varsFromEnv(env),
    });
    await upload(env, staging, abs);
    runSsh(env, startCommand(env, abs));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  push(process.env).catch((err) => {
    console.error(`nskit: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
