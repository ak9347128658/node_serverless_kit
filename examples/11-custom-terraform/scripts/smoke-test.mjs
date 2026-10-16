// After-deploy smoke test, run by the `afterDeploy` hook.
// nskit sets NSKIT_WORK_DIR (e.g. .nskit/aws-dev) and writes deployment.json there.
import { readFileSync } from "node:fs";
import path from "node:path";

const workDir = process.env.NSKIT_WORK_DIR ?? path.join(".nskit", `aws-${process.env.NSKIT_STAGE ?? "dev"}`);
const record = JSON.parse(readFileSync(path.join(workDir, "deployment.json"), "utf-8"));
const endpoint = record.endpoint;
if (!endpoint) throw new Error("no endpoint in deployment.json");

const created = await fetch(`${endpoint}/orders`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ item: "smoke-test" }),
});
if (created.status !== 201) throw new Error(`POST /orders returned ${created.status}: ${await created.text()}`);
const order = await created.json();

const fetched = await fetch(`${endpoint}/orders/${order.id}`);
if (fetched.status !== 200) throw new Error(`GET /orders/${order.id} returned ${fetched.status}`);
console.log(`smoke test passed against ${endpoint}`);
