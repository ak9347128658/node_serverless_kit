/**
 * Start the supervisor in the background and exit.
 *
 * Terraform's local-exec provisioner waits until the command exits, so a
 * deploy on `engine: process` runs this instead of the long-lived supervisor.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const pidFile = process.env.NSKIT_PIDFILE || path.join(dir, "supervisor.pid");
const child = spawn(process.execPath, [path.join(dir, "supervisor.mjs")], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
  env: process.env,
});
child.unref();
writeFileSync(pidFile, String(child.pid));
