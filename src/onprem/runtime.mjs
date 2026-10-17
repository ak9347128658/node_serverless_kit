/**
 * Decide how an on-premises server runs the service.
 *
 * `auto` tries a Node binary shipped in the bundle, then Node.js 18+ on PATH,
 * then Docker. Python, npm and a preinstalled runtime are not required.
 * `start.sh` and `start.ps1` use the same order and the same messages.
 */

import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const MIN_NODE_MAJOR = 18;

export const MESSAGES = {
  bundledMissing:
    "runtime bundled: set options.node_binary to a Node.js 18+ executable built for this server. nskit does not download it. Python is not used.",
  bundledIncompatible:
    "the Node binary in runtime/ does not run on this server. Pass a binary for this operating system and CPU as options.node_binary. Python is not used.",
  bundledOld: "runtime bundled: Node.js 18 or newer is required.",
  systemMissing:
    "runtime system: Node.js 18+ is not on PATH. Install it, or set runtime: bundled or runtime: docker. Python is not required.",
  systemOld: "runtime system: Node.js 18 or newer is required.",
  dockerMissing:
    "runtime docker: Docker is not available. Install Docker, or set runtime: bundled with options.node_binary. Node.js and Python are not required.",
  none:
    "nothing on this server can run the service. Use a Node.js 18+ binary (options.node_binary), Node.js 18+ on PATH, or Docker. Python, npm and a preinstalled runtime are not required.",
  systemdNeedsNode:
    "service systemd needs Node.js on the server (system or bundled). Docker cannot be the process systemd starts.",
  containersNeedDocker: "Redis or MinIO containers need runtime docker on this server.",
  imageMissing:
    "could not pull it. Load the image on this server, or set runtime: bundled and options.node_binary. Python is not required.",
  runtimeValue: "options.runtime must be auto, system, bundled or docker",
  serviceValue: "options.service must be process or systemd",
};

export const LAUNCH_KEYS = [
  "NSKIT_RUNTIME",
  "NSKIT_SERVICE",
  "NSKIT_TARGET_OS",
  "NSKIT_HTTP_PORT",
  "NSKIT_PUBLISH",
  "NSKIT_NODE_IMAGE",
  "NSKIT_REDIS_IMAGE",
  "NSKIT_MINIO_IMAGE",
  "NSKIT_DEPLOY_REDIS",
  "NSKIT_DEPLOY_MINIO",
  "NSKIT_MINIO_USER",
  "NSKIT_MINIO_PASSWORD",
  "NSKIT_CONTAINER",
  "NSKIT_SERVICE_NAME",
  "NSKIT_STAGE",
  "NSKIT_SYSTEMD_SCOPE",
  "NSKIT_STORAGE_DIR",
];

export function nodeMajor(version) {
  const major = Number(String(version ?? "").split(".")[0]);
  return Number.isFinite(major) ? major : 0;
}

function bundledUsable(facts) {
  if (!facts.bundledExecutable) return false;
  if (facts.bundledRuns === false) return false;
  if (facts.bundledVersion !== undefined && facts.bundledVersion !== "" && nodeMajor(facts.bundledVersion) < MIN_NODE_MAJOR) return false;
  return true;
}

function systemUsable(facts) {
  return Boolean(facts.systemNode) && nodeMajor(facts.systemVersion || "0") >= MIN_NODE_MAJOR;
}

/**
 * @param {object} facts
 * @param {string} [facts.runtime]
 * @param {string} [facts.bundledExecutable]
 * @param {boolean} [facts.bundledRuns]
 * @param {string} [facts.bundledVersion]
 * @param {string} [facts.systemNode]
 * @param {string} [facts.systemVersion]
 * @param {boolean} [facts.dockerOk]
 */
export function chooseRuntime(facts) {
  const runtime = facts.runtime || "auto";
  const none = (message) => ({ mode: "none", bin: "", message });
  if (runtime === "bundled") {
    if (!facts.bundledExecutable) return none(MESSAGES.bundledMissing);
    if (facts.bundledRuns === false || nodeMajor(facts.bundledVersion || "0") === 0) return none(MESSAGES.bundledIncompatible);
    if (nodeMajor(facts.bundledVersion || "0") < MIN_NODE_MAJOR) return none(MESSAGES.bundledOld);
    return { mode: "bundled", bin: facts.bundledExecutable, message: "" };
  }
  if (runtime === "system") {
    if (!facts.systemNode) return none(MESSAGES.systemMissing);
    if (!systemUsable(facts)) return none(MESSAGES.systemOld);
    return { mode: "system", bin: facts.systemNode, message: "" };
  }
  if (runtime === "docker") {
    if (!facts.dockerOk) return none(MESSAGES.dockerMissing);
    return { mode: "docker", bin: "", message: "" };
  }
  if (runtime !== "auto") return none(MESSAGES.runtimeValue);
  if (bundledUsable(facts)) return { mode: "bundled", bin: facts.bundledExecutable, message: "" };
  if (systemUsable(facts)) return { mode: "system", bin: facts.systemNode, message: "" };
  if (facts.dockerOk) return { mode: "docker", bin: "", message: "" };
  return none(MESSAGES.none);
}

/** Expand a leading `~`. OpenSSH is not asked to expand it. */
export function expandHome(value) {
  const text = String(value || "");
  if (text === "~") return os.homedir();
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2));
  return text;
}

/**
 * A Node executable, or a directory that contains one (`bin/node` from the
 * official archive, or `node.exe`). nskit does not download or extract Node.
 */
export function resolveNodeBinary(input) {
  const raw = expandHome(String(input || "").trim());
  if (!raw) return "";
  if (!existsSync(raw)) return raw;
  if (statSync(raw).isFile()) return raw;
  for (const rel of ["bin/node", "node", "bin/node.exe", "node.exe"]) {
    const full = path.join(raw, rel);
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  return raw;
}

export function bundledNodeName(binaryPath, targetOs) {
  const base = path.basename(String(binaryPath || "")).toLowerCase();
  if (base === "node.exe" || targetOs === "windows") return "node.exe";
  return "node";
}

/** `KEY=value` lines both start scripts can read. No shell expansion. */
export function launchEnv(vars) {
  const lines = [];
  for (const key of LAUNCH_KEYS) {
    const value = String(vars[key] ?? "");
    if (/[\r\n"\\]/.test(value)) throw new Error(`${key} cannot contain quotes, backslashes or newlines`);
    lines.push(value.includes(" ") ? `${key}="${value}"` : `${key}=${value}`);
  }
  return lines.join("\n") + "\n";
}

export function shellQuote(value) {
  const text = String(value);
  if (/[\r\n\0]/.test(text)) throw new Error("shell value must be a single line");
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function psQuote(value) {
  const text = String(value);
  if (/[\r\n\0]/.test(text)) throw new Error("shell value must be a single line");
  return `'${text.replace(/'/g, "''")}'`;
}

export function sshTarget(env) {
  const host = String(env.NSKIT_SSH_HOST || "");
  if (!host) throw new Error("deploy ssh needs options.host");
  const user = String(env.NSKIT_SSH_USER || "");
  return user ? `${user}@${host}` : host;
}

export function sshArgs(env) {
  const strict = env.NSKIT_SSH_STRICT === "1" ? "yes" : "accept-new";
  const args = ["-o", "BatchMode=yes", "-o", `StrictHostKeyChecking=${strict}`];
  if (env.NSKIT_SSH_KEY) args.push("-i", String(env.NSKIT_SSH_KEY));
  args.push("-p", String(env.NSKIT_SSH_PORT || "22"), sshTarget(env));
  return args;
}

function quotedLinuxDir(env) {
  const dir = String(env.NSKIT_REMOTE_DIR || "");
  if (dir.startsWith("/")) return shellQuote(dir);
  return `"$HOME/${dir}"`;
}

/** Remote command that creates the directory and prints its absolute path. */
export function prepareCommand(env) {
  const osName = env.NSKIT_TARGET_OS === "windows" ? "windows" : "linux";
  const dir = String(env.NSKIT_REMOTE_DIR || "");
  if (osName === "windows") {
    const rel = dir.replace(/\//g, "\\").replace(/'/g, "");
    if (/^[A-Za-z]:[\\/]/.test(dir)) {
      const win = dir.replace(/\//g, "\\").replace(/'/g, "");
      return `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path '${win}\\app','${win}\\platform\\data','${win}\\runtime' | Out-Null; Write-Output '${win}'"`;
    }
    return `powershell -NoProfile -Command "$d = Join-Path $env:USERPROFILE '${rel}'; New-Item -ItemType Directory -Force -Path (Join-Path $d 'app'),(Join-Path $d 'platform\\data'),(Join-Path $d 'runtime') | Out-Null; Write-Output $d"`;
  }
  const quoted = quotedLinuxDir(env);
  return `mkdir -p -- ${quoted}/app ${quoted}/platform/data ${quoted}/runtime && cd ${quoted} && pwd`;
}

export function extractCommand(absPath) {
  return `tar -xf - -C ${shellQuote(String(absPath).replace(/\\/g, "/"))}`;
}

export function startCommand(env, absPath) {
  const abs = String(absPath).replace(/\\/g, "/");
  if (env.NSKIT_TARGET_OS === "windows") {
    return `powershell -NoProfile -ExecutionPolicy Bypass -File ${psQuote(`${abs}/platform/start.ps1`)}`;
  }
  const start = shellQuote(`${abs}/platform/start.sh`);
  const stop = shellQuote(`${abs}/platform/stop.sh`);
  const node = shellQuote(`${abs}/runtime/node`);
  return `chmod 755 ${start} ${stop}; if [ -f ${node} ]; then chmod 755 ${node}; fi; sh ${start}`;
}

export function stopCommand(env, absPath) {
  const abs = String(absPath).replace(/\\/g, "/");
  if (env.NSKIT_TARGET_OS === "windows") {
    return `powershell -NoProfile -ExecutionPolicy Bypass -File ${psQuote(`${abs}/platform/stop.ps1`)}`;
  }
  return `sh ${shellQuote(`${abs}/platform/stop.sh`)}`;
}

export function startNote(vars) {
  const url = `http://${vars.NSKIT_PUBLISH || "127.0.0.1"}:${vars.NSKIT_HTTP_PORT || "8080"}`;
  return [
    "nskit on-premises bundle",
    "",
    "Python, npm and a preinstalled Node.js are not required.",
    "The start script picks the first runtime that works:",
    "  1. runtime/node (or runtime/node.exe) shipped in this folder",
    "  2. Node.js 18+ on PATH",
    "  3. Docker, using the image named in platform/launch.env",
    "",
    "Linux:    sh platform/start.sh",
    "Windows:  powershell -NoProfile -ExecutionPolicy Bypass -File platform/start.ps1",
    "Stop:      sh platform/stop.sh",
    "Windows:  powershell -NoProfile -ExecutionPolicy Bypass -File platform/stop.ps1",
    "Foreground for debugging:  NSKIT_FOREGROUND=1 sh platform/start.sh",
    "",
    `URL after it starts: ${url}`,
    "",
  ].join("\n");
}
