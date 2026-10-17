/**
 * Assemble the folder an operator copies onto a server.
 *
 * The folder is the same shape `push.mjs` uploads: `app/`, `platform/` and
 * `runtime/`. Nothing here needs Python, npm or a Node install on the server.
 */

import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bundledNodeName, launchEnv, resolveNodeBinary, startNote } from "./runtime.mjs";

export const PLATFORM_FILES = [
  "supervisor.mjs",
  "broker.mjs",
  "redis.mjs",
  "s3.mjs",
  "start.sh",
  "start.ps1",
  "stop.sh",
  "stop.ps1",
  "platform.json",
];

function mode(file) {
  try {
    chmodSync(file, 0o755);
  } catch {
    /* Windows copy of a script does not need the bit. The remote chmod sets it. */
  }
}

export function stagePayload({ dest, appDir, platformDir, nodeBinary, targetOs, envVars }) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.join(dest, "platform", "data"), { recursive: true });
  cpSync(appDir, path.join(dest, "app"), { recursive: true });
  for (const file of PLATFORM_FILES) {
    const from = path.join(platformDir, file);
    if (!existsSync(from)) throw new Error(`on-premises platform file is missing: ${file}`);
    const to = path.join(dest, "platform", file);
    cpSync(from, to);
    if (file.endsWith(".sh")) mode(to);
  }
  const text = launchEnv(envVars);
  writeFileSync(path.join(dest, "platform", "launch.env"), text);
  writeFileSync(path.join(dest, "START.txt"), startNote(envVars));
  if (nodeBinary) {
    const resolved = resolveNodeBinary(nodeBinary);
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      throw new Error("options.node_binary must be a Node.js executable, or a directory containing bin/node or node.exe");
    }
    mkdirSync(path.join(dest, "runtime"), { recursive: true });
    const to = path.join(dest, "runtime", bundledNodeName(resolved, targetOs || "linux"));
    cpSync(resolved, to);
    mode(to);
  }
  return dest;
}

export function varsFromEnv(env) {
  return {
    NSKIT_RUNTIME: env.NSKIT_RUNTIME || "auto",
    NSKIT_SERVICE: env.NSKIT_SERVICE || "process",
    NSKIT_TARGET_OS: env.NSKIT_TARGET_OS || "linux",
    NSKIT_HTTP_PORT: env.NSKIT_HTTP_PORT || "8080",
    NSKIT_PUBLISH: env.NSKIT_PUBLISH || "127.0.0.1",
    NSKIT_NODE_IMAGE: env.NSKIT_NODE_IMAGE || "node:22-bookworm-slim",
    NSKIT_REDIS_IMAGE: env.NSKIT_REDIS_IMAGE || "redis:7-alpine",
    NSKIT_MINIO_IMAGE: env.NSKIT_MINIO_IMAGE || "minio/minio:RELEASE.2025-04-22T22-12-26Z",
    NSKIT_DEPLOY_REDIS: env.NSKIT_DEPLOY_REDIS || "0",
    NSKIT_DEPLOY_MINIO: env.NSKIT_DEPLOY_MINIO || "0",
    NSKIT_MINIO_USER: env.NSKIT_MINIO_USER || "",
    NSKIT_MINIO_PASSWORD: env.NSKIT_MINIO_PASSWORD || "",
    NSKIT_CONTAINER: env.NSKIT_CONTAINER || "nskit-platform",
    NSKIT_SERVICE_NAME: env.NSKIT_SERVICE_NAME || "nskit",
    NSKIT_STAGE: env.NSKIT_STAGE || "dev",
    NSKIT_SYSTEMD_SCOPE: env.NSKIT_SYSTEMD_SCOPE || "user",
    NSKIT_STORAGE_DIR: env.NSKIT_STORAGE_DIR || "",
  };
}

function main() {
  const env = process.env;
  const bundle = env.NSKIT_BUNDLE_DIR || "";
  if (!bundle) throw new Error("NSKIT_BUNDLE_DIR is not set");
  if (env.NSKIT_ACTION === "remove") {
    rmSync(bundle, { recursive: true, force: true });
    return;
  }
  if (!env.NSKIT_APP_DIR || !env.NSKIT_PLATFORM_DIR) throw new Error("NSKIT_APP_DIR and NSKIT_PLATFORM_DIR are required");
  stagePayload({
    dest: bundle,
    appDir: env.NSKIT_APP_DIR,
    platformDir: env.NSKIT_PLATFORM_DIR,
    nodeBinary: env.NSKIT_NODE_BINARY || "",
    targetOs: env.NSKIT_TARGET_OS || "linux",
    envVars: varsFromEnv(env),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`nskit: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
