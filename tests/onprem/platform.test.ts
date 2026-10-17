import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { Deployer } from "../../src/core/deployer";
import { Project } from "../../src/core/project";
import { startPlatform } from "../../src/onprem/supervisor.mjs";

const HANDLERS = `import { BatchResult, getEnv, HttpResponse, sendMessage } from "node_serverless_kit";

function note(item) {
  const slot = globalThis;
  slot.__nskitSeen = slot.__nskitSeen || [];
  slot.__nskitSeen.push(item);
}

export async function api(event) {
  if (event.http && event.http.method === "POST") {
    const job = event.http.json();
    const id = await sendMessage("jobs", job);
    return HttpResponse.json({ accepted: true, id }, 202);
  }
  return { ok: true, provider: event.provider, label: getEnv("FN_LABEL", "") };
}

export function worker(event) {
  const result = new BatchResult();
  for (const record of event.records) {
    const job = record.json();
    if (!job || !job.kind) result.fail(record);
    else note("job:" + job.kind);
  }
  return result;
}

export function audit(event) {
  note("dead:" + event.records.length);
  return { audited: event.records.length };
}

export function echo(event) {
  note("echo");
  return event.data;
}
`;

const YAML = `
service: demo
provider:
  name: onprem
  region: local
functions:
  api:
    handler: src/handlers.api
    environment: {FN_LABEL: api}
    events:
      - http: GET /health
      - http: POST /jobs
  worker:
    handler: src/handlers.worker
    events:
      - queue: {name: jobs, batchSize: 5, deadLetter: jobs-dlq, maxReceive: 1}
  audit:
    handler: src/handlers.audit
    events:
      - queue: {name: jobs-dlq, batchSize: 5}
  echo:
    handler: src/handlers.echo
workflows:
  ping:
    startAt: Echo
    states:
      Echo: {type: task, function: echo, end: true}
`;

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function seen(): string[] {
  return ((globalThis as { __nskitSeen?: string[] }).__nskitSeen ?? []).slice();
}

async function until(pred: () => boolean, label: string) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(seen())}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("the supervisor serves HTTP, queues, schedules and workflows from the built bundle", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nskit-platform-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "handlers.ts"), HANDLERS);
  writeFileSync(path.join(dir, "nskit.yml"), YAML);
  const project = Project.load(path.join(dir, "nskit.yml"));
  await new Deployer(project, () => undefined).package({ skipInstall: true });
  const platform = JSON.parse(readFileSync(path.join(project.workDir, "onprem", "platform.json"), "utf-8"));
  platform.http = { host: "127.0.0.1", port: 0 };
  platform.pollMs = 20;
  platform.dataDir = "";
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(platform.processEnv)) saved.set(key, process.env[key]);
  (globalThis as { __nskitSeen?: string[] }).__nskitSeen = [];
  const running = await startPlatform({ platform, workers: true });
  try {
    const health = await fetch(`${running.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, provider: "onprem", label: "api" });

    const posted = await fetch(`${running.url}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "email" }),
    });
    expect(posted.status).toBe(202);
    running.broker.enqueue("jobs", {});
    await until(() => seen().includes("job:email") && seen().some((item) => item.startsWith("dead:")), "queue delivery");

    await running.fireSchedule({ function: "echo", input: { kind: "heartbeat" }, name: "tick" });
    expect(seen()).toContain("echo");

    const flow = await fetch(`${running.url}/__nskit/workflows/ping`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ n: 1 }),
    });
    expect(flow.status).toBe(200);
    const body = await flow.json();
    expect(body.status).toBe("SUCCEEDED");
    expect(body.output).toEqual({ n: 1 });
  } finally {
    await running.close();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete (globalThis as { __nskitSeen?: string[] }).__nskitSeen;
  }
});
