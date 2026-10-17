/** Stop a supervisor started by launch.mjs. Terraform runs this on destroy. */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";

const pidFile = process.env.NSKIT_PIDFILE || "";
if (!pidFile || !existsSync(pidFile)) process.exit(0);
const pid = Number(readFileSync(pidFile, "utf8"));
if (Number.isFinite(pid) && pid > 0) {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}
rmSync(pidFile, { force: true });
