/**
 * Every example must validate, package and run locally.
 *
 * - discovers every directory under examples/ that contains an `nskit.yml`
 *   (recursively, e.g. 13-migrate-from-aws-lambda/after);
 * - validates it for its configured provider and for aws/gcp/azure/onprem;
 * - builds the artifact (and renders Terraform) for its configured provider;
 * - runs HTTP / invoke / queue / topic / storage / schedule / workflow cases with
 *   `LocalRunner` in bundle mode, i.e. through the same esbuild bundle as a deployment.
 *
 * Providers that are still placeholders (`... is not implemented yet`) are skipped.
 * The examples are copied to a temporary directory first, so `.nskit/` output never
 * lands in the repository and parallel test files cannot race on it.
 */

import { createHmac } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PROVIDERS } from "../src/config/schema.js";
import { Project } from "../src/core/project.js";
import { LocalRunner, type HttpCallOptions, type LocalHttpResponse } from "../src/local/runner.js";
import { buildArtifact } from "../src/packaging/builder.js";
import { RenderContext, type Artifact } from "../src/providers/base.js";
import { getProvider } from "../src/providers/registry.js";

const EXAMPLES = fileURLToPath(new URL("../examples/", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".nskit", ".git", "dist", "coverage"]);

function discover(dir: string, rel = ""): string[] {
  const found: string[] = [];
  if (rel && existsSync(path.join(dir, "nskit.yml"))) found.push(rel);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
      found.push(...discover(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name));
    }
  }
  return found.sort();
}

const PROJECTS = discover(EXAMPLES);

/** False for providers that are still placeholders (other ports are in progress). */
function implemented(name: string): boolean {
  try {
    getProvider(name).entryCode({ config: {} as never, manifest: {} as never, runtime: (m) => m });
    return true;
  } catch (err) {
    return !/not implemented/i.test(String((err as Error).message));
  }
}

function errors(project: Project): string[] {
  return project.validate().filter((i) => i.level === "error").map(String);
}

// ------------------------------------------------------------------ temp copy + env isolation

let work = "";
const workFile = (rel: string, file = "nskit.yml") => path.join(work, ...rel.split("/"), file);

beforeAll(() => {
  work = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "nskit-examples-")));
  cpSync(EXAMPLES, work, {
    recursive: true,
    filter: (src) => !path.relative(EXAMPLES, src).split(path.sep).some((part) => SKIP_DIRS.has(part)),
  });
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

// LocalRunner writes the service environment into process.env; keep examples independent.
let envSnapshot: NodeJS.ProcessEnv = {};
beforeEach(() => {
  envSnapshot = { ...process.env };
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in envSnapshot)) delete process.env[key];
  Object.assign(process.env, envSnapshot);
});

const RUNNER_ENV = { NSKIT_LOG_LEVEL: "error" };

// ------------------------------------------------------------------ helpers for cases

function hs256(claims: Record<string, unknown>, secret: string): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
  return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
}

function jsonFile(rel: string, file: string): unknown {
  return JSON.parse(readFileSync(workFile(rel, file), "utf-8"));
}

interface WorkflowFailure {
  name: string;
  error: string;
}

async function workflowFailure(promise: Promise<unknown>): Promise<WorkflowFailure> {
  try {
    await promise;
  } catch (err) {
    return err as WorkflowFailure;
  }
  throw new Error("expected the workflow to fail");
}

// ------------------------------------------------------------------ HTTP cases

interface HttpCase {
  method: string;
  url: string;
  options?: HttpCallOptions | ((runner: LocalRunner) => HttpCallOptions);
  status: number;
  /** Partial JSON body match. */
  body?: unknown;
  check?: (res: LocalHttpResponse) => void;
}

const BOOK = { title: "Snow Crash", author: "Neal Stephenson", year: 1992, isbn: "9780553380958" };
const jwtSecret = (r: LocalRunner) => r.config.provider.environment.JWT_SECRET;
const jwtClaims = (extra: Record<string, unknown> = {}) => ({
  sub: "ada",
  role: "admin",
  iss: "https://auth.example.com/",
  aud: "books-api",
  exp: Math.floor(Date.now() / 1000) + 600,
  ...extra,
});
const bearer = (claims: Record<string, unknown>, secret?: string) => (r: LocalRunner) => ({
  headers: { authorization: `Bearer ${hs256(claims, secret ?? jwtSecret(r))}` },
});

const HTTP_CASES: Record<string, HttpCase[]> = {
  "01-hello-http": [
    { method: "GET", url: "/hello?name=Ada", status: 200, body: { message: "Hello, Ada!", provider: "local", stage: "dev" } },
    { method: "GET", url: "/hello/Bob", status: 200, body: { message: "Hello, Bob!" } },
    { method: "GET", url: `/hello/${"x".repeat(70)}`, status: 400, body: { error: "name is too long", status: 400 } },
    { method: "POST", url: "/hello", status: 405 },
    { method: "GET", url: "/nope", status: 404 },
  ],
  "02-rest-api": [
    { method: "GET", url: "/books?author=gibson", status: 200, body: { count: 1, items: [{ id: "b2" }] } },
    { method: "GET", url: "/books?limit=many", status: 400 },
    { method: "GET", url: "/books/b1", status: 200, body: { title: "Dune" } },
    { method: "GET", url: "/books/nope", status: 404, body: { error: "book nope not found", status: 404 } },
    { method: "POST", url: "/books", options: { body: "{oops", headers: { "content-type": "application/json" } }, status: 400 },
    { method: "POST", url: "/books", options: { json: [1, 2] }, status: 400, body: { error: "body must be a JSON object" } },
    {
      method: "POST",
      url: "/books",
      options: { json: { title: 1 } },
      status: 422,
      body: { error: "validation failed", details: { title: "must be a string", author: "required", year: "required" } },
    },
    { method: "POST", url: "/books", options: { json: { ...BOOK, isbn: "9780441013593" } }, status: 409 },
    {
      method: "POST",
      url: "/books",
      options: { json: BOOK },
      status: 201,
      body: BOOK,
      check: (res) => expect(res.headers.location).toMatch(/^\/books\/\w+$/),
    },
    { method: "PUT", url: "/books/b2", options: { json: { ...BOOK, isbn: "0441569595" } }, status: 200, body: { id: "b2" } },
    { method: "PUT", url: "/books/zzz", options: { json: BOOK }, status: 404 },
    { method: "DELETE", url: "/books/b2", status: 204 },
    { method: "DELETE", url: "/books/b2", status: 404 },
    {
      method: "GET",
      url: "/books/b1/cover",
      status: 200,
      check: (res) => {
        expect(res.headers["content-type"]).toBe("image/png");
        expect([...res.body.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]); // "PNG"
      },
    },
    { method: "GET", url: "/docs", status: 302, check: (res) => expect(res.headers.location).toMatch(/^https:\/\//) },
    {
      method: "POST",
      url: "/session",
      options: { json: { user: "ada" } },
      status: 200,
      body: { user: "ada" },
      check: (res) => expect(res.cookies[0]).toMatch(/^session=demo-ada; .*HttpOnly/),
    },
    { method: "POST", url: "/session", options: { json: {} }, status: 400 },
    {
      method: "OPTIONS",
      url: "/books",
      options: { headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" } },
      status: 204,
      check: (res) => {
        expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
        expect(res.headers["access-control-allow-credentials"]).toBe("true");
      },
    },
    {
      method: "GET",
      url: "/books",
      options: { headers: { origin: "https://evil.example.com" } },
      status: 200,
      check: (res) => expect(res.headers["access-control-allow-origin"]).toBeUndefined(),
    },
    {
      method: "GET",
      url: "/stats/admin",
      status: 401,
      body: { error: "missing bearer token" },
      check: (res) => expect(res.headers["www-authenticate"]).toContain("Bearer"),
    },
    {
      method: "GET",
      url: "/stats/admin",
      options: (r) => ({ ...bearer(jwtClaims())(r), headers: { ...bearer(jwtClaims())(r).headers, cookie: "session=demo-ada" } }),
      status: 200,
      body: { user: "ada", sessionCookie: "demo-ada" },
    },
    { method: "GET", url: "/stats/admin", options: bearer(jwtClaims(), "wrong-secret"), status: 401, body: { error: "invalid token signature" } },
    { method: "GET", url: "/stats/admin", options: bearer(jwtClaims({ exp: 1000 })), status: 401, body: { error: "token expired" } },
    { method: "GET", url: "/stats/admin", options: bearer(jwtClaims({ aud: "other" })), status: 401 },
    { method: "GET", url: "/stats/admin", options: bearer(jwtClaims({ role: "reader" })), status: 403 },
  ],
  "04-queue-worker": [
    { method: "POST", url: "/jobs", options: { json: { kind: "email" } }, status: 202, body: { accepted: true, queue: "jobs" } },
    { method: "POST", url: "/jobs", options: { json: {} }, status: 400 },
  ],
  "08-multi-cloud": [
    {
      method: "GET",
      url: "/whoami",
      status: 200,
      body: { provider: "local", service: "multi-cloud", stage: "dev", function: "whoami", app: "multi-cloud-demo", path: "/whoami" },
    },
    {
      method: "POST",
      url: "/echo?debug=1",
      options: { json: { a: 1 } },
      status: 200,
      body: { youSent: { a: 1 }, contentType: "application/json", query: { debug: "1" } },
      check: (res) => expect(res.headers["x-served-by"]).toBe("local"),
    },
    { method: "POST", url: "/echo", options: { json: [1] }, status: 400 },
  ],
  "09-function-invoke": [
    {
      method: "POST",
      url: "/quote",
      options: { json: { country: "DE", items: [{ sku: "a", qty: 2, unitPrice: 10 }] } },
      status: 200,
      body: { quote: { subtotal: 20, tax: 3.8, total: 23.8, taxRate: 0.19 } },
    },
    { method: "POST", url: "/quote", options: { json: {} }, status: 400 },
  ],
  "10-stages-and-config": [
    {
      method: "GET",
      url: "/config",
      status: 200,
      body: { stage: "dev", table: "shop-config-dev-orders", logLevel: "debug", newCheckout: true, apiBaseUrl: "https://api-dev.example.com" },
    },
  ],
  "11-custom-terraform": [
    { method: "POST", url: "/orders", options: { json: { item: "book" } }, status: 201, body: { item: "book", status: "new" } },
    { method: "POST", url: "/orders", options: { json: {} }, status: 400 },
    { method: "GET", url: "/orders/unknown", status: 404 },
  ],
  "12-async-and-context": [
    {
      method: "GET",
      url: "/aggregate",
      status: 200,
      check: (res) => expect(res.json<{ results: unknown[] }>().results.map((r) => (r as { source: string }).source)).toEqual(["inventory", "pricing", "reviews"]),
    },
    {
      method: "POST",
      url: "/inspect",
      options: { json: {}, headers: { "x-trace-id": "abc", authorization: "secret" } },
      status: 200,
      body: { event: { type: "http", provider: "local" }, context: { functionName: "inspect", provider: "local", remainingTimeMs: expect.any(Number) }, headers: { "x-trace-id": "abc" } },
      check: (res) => expect(res.json<{ headers: object }>().headers).not.toHaveProperty("authorization"),
    },
  ],
  "13-migrate-from-aws-lambda/after": [
    {
      method: "POST",
      url: "/orders",
      options: { json: { items: [{ qty: 1, price: 5 }] } },
      status: 202,
      body: { accepted: true, order: { total: 5 } },
    },
    { method: "POST", url: "/orders", options: { json: { items: [] } }, status: 400 },
    { method: "GET", url: "/orders/42", status: 200, body: { id: "42", status: "unknown" } },
  ],
  "14-testing": [
    { method: "POST", url: "/price", options: { json: { amount: 100, code: "VIP25" } }, status: 200, body: { total: 75, discount: 25 } },
    { method: "POST", url: "/price", options: { json: { amount: -1 } }, status: 400 },
  ],
  "15-ci-cd-deploy": [{ method: "GET", url: "/health", status: 200, body: { status: "ok", stage: "dev" } }],
  "16-javascript-commonjs": [
    { method: "GET", url: "/hello?name=Ada", status: 200, body: { message: "Hello, Ada!", moduleSystem: "commonjs" } },
    { method: "POST", url: "/todos", options: { json: { title: "write docs" } }, status: 201, body: { id: "1", done: false } },
    { method: "POST", url: "/todos", options: { json: {} }, status: 400 },
    { method: "GET", url: "/todos", status: 200, body: { items: [{ id: "1", title: "write docs" }] } },
    { method: "PATCH", url: "/todos/1", status: 200, body: { id: "1", done: true } },
    { method: "GET", url: "/todos/1", status: 200, body: { done: true } },
    { method: "GET", url: "/todos/99", status: 404 },
  ],
  "17-typescript-paths": [
    {
      method: "GET",
      url: "/page",
      status: 200,
      check: (res) => {
        expect(res.headers["content-type"]).toContain("text/html");
        expect(res.text).toContain("<p>Hello, world!</p>");
        expect(res.text).toContain("Served by local");
      },
    },
    {
      method: "GET",
      url: "/greet/%3Cb%3E",
      status: 200,
      check: (res) => expect(res.text).toContain("Hello, &lt;b&gt;!"),
    },
    { method: "GET", url: "/api/greeting?name=Ada", status: 200, body: { greeting: "Hello, Ada!", maxNameLength: 40 } },
  ],
  "18-on-premises": [
    { method: "GET", url: "/health", status: 200, body: { ok: true, provider: "local", label: "api", service: "on-prem" } },
    { method: "POST", url: "/jobs", options: { json: { kind: "email" } }, status: 202, body: { accepted: true } },
    { method: "POST", url: "/jobs", options: { json: {} }, status: 400 },
  ],
  "19-on-premises-deploy": [
    { method: "GET", url: "/health", status: 200, body: { ok: true, provider: "local" } },
  ],
};

// ------------------------------------------------------------------ other local scenarios

type Scenario = (runner: LocalRunner, rel: string) => Promise<void>;

const SCENARIOS: Record<string, Record<string, Scenario>> = {
  "03-scheduled-jobs": {
    "heartbeat": async (r) => expect(await r.schedule("heartbeat")).toMatchObject({ ok: true }),
    "daily report with the configured input": async (r) => {
      const ev = r.config.functions["daily-report"].events[0];
      const input = ev.type === "schedule" ? ev.config.input : undefined;
      expect(input).toEqual({ report: "sales", days: 1, recipients: ["finance@example.com"] });
      const report = await r.schedule<{ report: string; recipients: string[]; period: string[] }>("daily-report", input);
      expect(report).toMatchObject({ report: "sales", recipients: ["finance@example.com"] });
      expect(Date.parse(report.period[1]) - Date.parse(report.period[0])).toBe(24 * 3600 * 1000);
    },
    "cleanup": async (r) => expect(await r.schedule("cleanup", { retentionDays: 90 })).toEqual({ retentionDays: 90, deleted: 1000 }),
  },
  "04-queue-worker": {
    "partial batch failures": async (r) => {
      const result = await r.queue<{ failed: string[] }>("process-jobs", [
        { kind: "email" },
        { kind: "email", simulateFailure: true },
        { kind: "nope" }, // poison message: dropped, not retried
      ]);
      expect(result.failed).toEqual(["2"]);
    },
    "dead letters": async (r) => expect(await r.queue("audit-dead-letters", ["broken"])).toEqual({ audited: 1 }),
  },
  "05-storage-events": {
    "import csv": async (r) => {
      const out = await r.storage("import-csv", [
        { bucket: "data", key: "incoming/sales.csv", size: 1024 },
        { bucket: "data", key: "incoming/huge.csv", size: 60 * 1024 * 1024 },
      ]);
      expect(out).toEqual({
        accepted: [{ bucket: "data", key: "incoming/sales.csv", dataset: "sales" }],
        skipped: [{ key: "incoming/huge.csv", reason: "too large" }],
      });
    },
    "purge index": async (r) =>
      expect(await r.storage("purge-index", [{ key: "incoming/sales.csv", action: "deleted" }])).toEqual({ removed: ["incoming/sales.csv"] }),
    "audit existing bucket": async (r) => expect(await r.storage("audit-existing", [{ key: "a.txt" }])).toEqual({ seen: 1 }),
    "bucket name from custom + stage": async (r) => {
      const ev = r.config.functions["import-csv"].events[0];
      expect(ev.type === "storage" && ev.config.bucket).toMatch(/-dev$/);
    },
  },
  "06-pubsub-topic": {
    "notify only shipped orders": async (r) => {
      const out = await r.topic("notify-customer", [
        { body: { orderId: "o-7", email: "ada@example.com" }, attributes: { event_type: "order.shipped" } },
        { body: { orderId: "o-8" }, attributes: { event_type: "order.created" } },
      ]);
      expect(out).toEqual({ notified: ["o-7"] });
    },
    "analytics counts every event": async (r) => {
      const out = await r.topic("update-analytics", [
        { body: {}, attributes: { event_type: "order.created" } },
        { body: {}, attributes: { event_type: "order.created" } },
        { body: {} },
      ]);
      expect(out).toEqual({ counts: { "order.created": 2, unknown: 1 } });
    },
  },
  "07-workflow-orders": {
    "happy path with a retried payment": async (r, rel) => {
      const { output, history } = await r.workflow("order-pipeline", jsonFile(rel, "events/happy.json"));
      expect(output).toMatchObject({
        total: 34,
        payment: { status: "charged", amount: 34, currency: "EUR" },
        reservations: [{ sku: "sku-book", reserved: true }, { sku: "sku-mug", reserved: true }],
        fulfilment: [{ emailSentTo: "ada@example.com" }, { carrier: "DHL", tracking: "TRK-o-1001" }],
      });
      expect(history.some((h) => h.event === "retry" && h.error === "PaymentGatewayTimeout")).toBe(true);
    },
    "b2b orders are invoiced": async (r, rel) => {
      const { output, history } = await r.workflow("order-pipeline", jsonFile(rel, "events/b2b.json"));
      expect(output).toMatchObject({ payment: { status: "invoiced" } });
      expect(history.map((h) => h.state)).not.toContain("Reserve");
    },
    "large orders wait for review": async (r, rel) => {
      const { output, history } = await r.workflow("order-pipeline", jsonFile(rel, "events/large.json"));
      expect(history.map((h) => h.state)).toContain("ManualReview");
      expect(output).toMatchObject({ payment: { status: "charged", amount: 1250 } });
    },
    "declined cards fail the workflow": async (r, rel) => {
      const err = await workflowFailure(r.workflow("order-pipeline", jsonFile(rel, "events/declined.json")));
      expect(err).toMatchObject({ name: "WorkflowFailed", error: "PaymentDeclined" });
    },
    "invalid orders are rejected": async (r, rel) => {
      const err = await workflowFailure(r.workflow("order-pipeline", jsonFile(rel, "events/invalid.json")));
      expect(err.error).toBe("OrderRejected");
    },
    "out of stock items are rejected (map catch)": async (r, rel) => {
      const err = await workflowFailure(r.workflow("order-pipeline", jsonFile(rel, "events/out-of-stock.json")));
      expect(err.error).toBe("OrderRejected");
    },
  },
  "08-multi-cloud": {
    "ticker": async (r) => expect(await r.schedule("ticker", { source: "multi-cloud" })).toMatchObject({ input: { source: "multi-cloud" } }),
  },
  "09-function-invoke": {
    "invoke-only target": async (r) =>
      expect(await r.invoke("price-calculator", { country: "FR", items: [{ sku: "a", qty: 3, unitPrice: 1.1 }] })).toEqual({
        subtotal: 3.3,
        tax: 0.66,
        total: 3.96,
        taxRate: 0.2,
      }),
    "audit log": async (r) => expect(await r.invoke("audit-log", { action: "test" })).toEqual({ logged: true }),
  },
  "11-custom-terraform": {
    "create then fetch": async (r) => {
      const created = await r.http("POST", "/orders", { json: { item: "lamp" } });
      const { id } = created.json<{ id: string }>();
      expect(created.headers.location).toBe(`/orders/${id}`);
      const fetched = await r.http("GET", `/orders/${id}`);
      expect(fetched.status).toBe(200);
      expect(fetched.json()).toEqual({ id, item: "lamp", status: "new" });
    },
  },
  "12-async-and-context": {
    "waitUntil work finishes before the invocation ends": async (r) => {
      const before = await r.invoke<{ recorded: number }>("metrics");
      await r.http("GET", "/aggregate");
      const after = await r.invoke<{ recorded: number }>("metrics");
      expect(after.recorded).toBe(before.recorded + 1);
    },
    "batch job": async (r) => expect(await r.schedule("batch-job")).toEqual({ processed: 100 }),
  },
  "13-migrate-from-aws-lambda/after": {
    "workflow: large order is reviewed and charged": async (r) => {
      const { output, history } = await r.workflow("order-processing", { items: [{ qty: 2, price: 300 }] });
      expect(output).toMatchObject({ valid: true, charged: true, total: 600 });
      expect(history.map((h) => h.state)).toContain("Review");
    },
    "workflow: empty order is rejected": async (r) => {
      const err = await workflowFailure(r.workflow("order-processing", { items: [{ qty: 0, price: 1 }] }));
      expect(err.error).toBe("OrderRejected");
    },
    "email worker reports failed records": async (r) => {
      const result = await r.queue<{ failed: string[] }>("email-worker", [{ to: "a@b.c" }, "broken", { cc: "x" }]);
      expect(result.failed).toEqual(["2", "3"]);
    },
  },
  "14-testing": {
    "scoring workflow approves VIPs": async (r) => {
      expect((await r.workflow("scoring", { vip: true })).output).toMatchObject({ enriched: true, score: 90 });
    },
    "scoring workflow declines others": async (r) => {
      expect((await workflowFailure(r.workflow("scoring", {}))).error).toBe("LowScore");
    },
    "ingest partial failures": async (r) =>
      expect((await r.queue<{ failed: string[] }>("ingest", [{ id: 1 }, "garbage"])).failed).toEqual(["2"]),
  },
  "18-on-premises": {
    "partial queue failure": async (r) =>
      expect((await r.queue<{ failed: string[] }>("worker", [{ kind: "email" }, {}])).failed).toEqual(["2"]),
    "dead letters": async (r) => expect(await r.queue("audit", [{ kind: "bad" }])).toEqual({ audited: 1 }),
    "topic filter keeps created events": async (r) => {
      const out = await r.topic<{ sent: string[] }>("notify", [
        { body: { id: "a" }, attributes: { type: "created" } },
        { body: { id: "b" }, attributes: { type: "deleted" } },
      ]);
      expect(out.sent).toEqual(["a"]);
    },
    "storage created and deleted": async (r) =>
      expect(
        await r.storage("files", [
          { bucket: "uploads", key: "in/note.txt", action: "created" },
          { bucket: "uploads", key: "in/note.txt", action: "deleted" },
        ]),
      ).toEqual({ seen: [{ key: "in/note.txt", action: "created" }, { key: "in/note.txt", action: "deleted" }] }),
    "schedule input": async (r) => expect(await r.schedule("tick", { kind: "heartbeat" })).toEqual({ ran: true, input: { kind: "heartbeat" } }),
    "invoke and workflow": async (r) => {
      expect(await r.invoke("echo", { n: 1 })).toEqual({ n: 1 });
      expect((await r.workflow("ping", { n: 2 })).output).toEqual({ n: 2 });
    },
  },
};

/**
 * Scenarios that currently fail because of a bug in src/ (not in the example).
 *
 * - Embedded workflow engine: an error escaping a map iteration (or a parallel branch) is
 *   wrapped in WorkflowFailed, and runMachine re-throws WorkflowFailed without consulting the
 *   map/parallel state's own `catch` rules, so `Reserve.catch: [{errors: [OutOfStock]}]` never
 *   fires (Step Functions would route to Rejected).
 */
const KNOWN_RUNTIME_BUGS = new Set<string>();

// ------------------------------------------------------------------ packaging checks

type PackageCheck = (doc: Record<string, any>, artifact: Artifact) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

const PACKAGE_CHECKS: Record<string, PackageCheck> = {
  "11-custom-terraform": (doc) => {
    expect(doc.resource.aws_dynamodb_table.orders).toMatchObject({ name: "orders-ddb-dev-orders", hash_key: "id" });
    expect(doc.output.orders_table_arn.value).toBe("${aws_dynamodb_table.orders.arn}");
    const lambdas = Object.values(doc.resource.aws_lambda_function) as { environment: { variables: Record<string, string> } }[];
    expect(lambdas.length).toBe(2);
    for (const fn of lambdas) expect(fn.environment.variables.ORDERS_TABLE).toBe("${aws_dynamodb_table.orders.name}");
    expect(JSON.stringify(doc.resource.aws_iam_role_policy ?? doc.resource)).toContain("${aws_dynamodb_table.orders.arn}/index/*");
    expect(doc.terraform.backend).toBeUndefined(); // remote state is commented out in the example
  },
  "15-ci-cd-deploy": (doc) => expect(doc.terraform.backend.s3).toMatchObject({ key: "cicd-demo/dev/terraform.tfstate", encrypt: true }),
  "17-typescript-paths": (_doc, artifact) => {
    expect(existsSync(path.join(artifact.buildDir, "templates", "page.html"))).toBe(true);
    expect(readFileSync(path.join(artifact.buildDir, artifact.entryFile), "utf-8")).toContain("Served by {{provider}}");
  },
  "19-on-premises-deploy": (doc) => {
    expect(doc.terraform.required_providers).toEqual({});
    expect(doc.resource.terraform_data.onprem.provisioner[0]["local-exec"].command).toBe("node onprem/pack.mjs");
  },
};

// ------------------------------------------------------------------ the tests

it("discovers every example", () => {
  expect(PROJECTS).toEqual([
    "01-hello-http",
    "02-rest-api",
    "03-scheduled-jobs",
    "04-queue-worker",
    "05-storage-events",
    "06-pubsub-topic",
    "07-workflow-orders",
    "08-multi-cloud",
    "09-function-invoke",
    "10-stages-and-config",
    "11-custom-terraform",
    "12-async-and-context",
    "13-migrate-from-aws-lambda/after",
    "14-testing",
    "15-ci-cd-deploy",
    "16-javascript-commonjs",
    "17-typescript-paths",
    "18-on-premises",
    "19-on-premises-deploy",
  ]);
  for (const rel of PROJECTS) {
    expect(existsSync(path.join(EXAMPLES, rel.split("/")[0], "README.md")), `${rel} README`).toBe(true);
    expect(HTTP_CASES[rel] || SCENARIOS[rel], `${rel} has local cases`).toBeTruthy();
  }
});

describe.each(PROJECTS)("%s", (rel) => {
  // Read from the source tree at collection time (no writes) to decide what to skip.
  const configured = Project.load(path.join(EXAMPLES, ...rel.split("/"), "nskit.yml")).config.provider.name;

  it(`validates for its provider (${configured})`, () => {
    expect(errors(Project.load(workFile(rel)))).toEqual([]);
  });

  it.skipIf(!implemented(configured))(`packages for ${configured} (artifact + terraform)`, async () => {
    const project = Project.load(workFile(rel));
    const artifact = await buildArtifact(project, { skipInstall: true });
    expect(artifact.size).toBeGreaterThan(0);
    expect(existsSync(path.join(artifact.buildDir, artifact.entryFile))).toBe(true);
    const doc = project.provider
      .render(
        new RenderContext({
          config: project.config,
          provider: project.provider,
          root: project.root,
          workDir: project.workDir,
          artifact,
          region: project.region,
          workflowEngines: { ...project.engines },
        }),
      )
      .toObject();
    expect(doc.output.nskit).toBeDefined();
    PACKAGE_CHECKS[rel]?.(doc, artifact);
  });

  for (const provider of ["aws", "gcp", "azure", "onprem"]) {
    const awsOnly = rel === "11-custom-terraform" && provider !== "aws" && provider !== "onprem"; // terraform.extra is AWS-specific by design
    if (provider === configured) continue; // covered by the first test
    it.skipIf(awsOnly || !implemented(provider))(`is portable to ${provider}`, () => {
      expect(errors(Project.load(workFile(rel), { provider }))).toEqual([]);
    });
  }

  describe("locally (bundle mode)", () => {
    let runner: LocalRunner;

    beforeAll(async () => {
      runner = await LocalRunner.fromConfig(workFile(rel), { mode: "bundle", env: RUNNER_ENV });
    });

    for (const c of HTTP_CASES[rel] ?? []) {
      it(`${c.method} ${c.url.length > 40 ? c.url.slice(0, 40) + "..." : c.url} -> ${c.status}`, async () => {
        const options = typeof c.options === "function" ? c.options(runner) : c.options;
        const res = await runner.http(c.method, c.url, options);
        expect(res.status, res.text).toBe(c.status);
        if (c.body !== undefined) expect(res.json()).toMatchObject(c.body as object);
        c.check?.(res);
      });
    }

    for (const [name, scenario] of Object.entries(SCENARIOS[rel] ?? {})) {
      // `it.fails` documents a known runtime bug: it turns red once the bug is fixed - then use `it` again.
      (KNOWN_RUNTIME_BUGS.has(`${rel}: ${name}`) ? it.fails : it)(name, () => scenario(runner, rel));
    }
  });
});

// ------------------------------------------------------------------ config-level checks

describe("08-multi-cloud variants", () => {
  for (const provider of PROVIDERS) {
    it.skipIf(!implemented(provider))(`nskit.yml --provider ${provider} validates`, () => {
      const project = Project.load(workFile("08-multi-cloud"), { provider });
      expect(project.config.provider.name).toBe(provider);
      expect(errors(project)).toEqual([]);
    });
  }

  it("applies per-cloud overrides", () => {
    const oracle = Project.load(workFile("08-multi-cloud"), { provider: "oracle" }).config;
    expect(oracle.provider.region).toBe("us-ashburn-1");
    expect(oracle.functions.ticker.events).toEqual([]);
    expect(oracle.functions.whoami.events.length).toBe(1);
    const gcp = Project.load(workFile("08-multi-cloud"), { provider: "gcp" }).config;
    expect(gcp.provider.options.project).toBeTruthy();
  });

  const variants: [string, string, string][] = [
    ["aws", "nskit.aws.yml", "eu-west-1"],
    ["gcp", "nskit.gcp.yml", "europe-west1"],
    ["azure", "nskit.azure.yml", "northeurope"],
    ["cloudflare", "nskit.cloudflare.yml", ""],
    ["onprem", "nskit.onprem.yml", "local"],
  ];
  for (const [provider, file, region] of variants) {
    it(`${file} extends nskit.yml`, () => {
      const project = Project.load(workFile("08-multi-cloud", file));
      expect(project.config.service).toBe("multi-cloud");
      expect(project.config.provider.name).toBe(provider);
      if (region) expect(project.config.provider.region).toBe(region);
      expect(Object.keys(project.config.functions).sort()).toEqual(["echo", "ticker", "whoami"]);
      if (provider === "aws") {
        expect(project.config.provider.architecture).toBe("arm64");
        expect(project.config.provider.tags["cost-center"]).toBe("platform");
      }
      if (implemented(provider)) expect(errors(project)).toEqual([]);
    });
  }
});

describe("10-stages-and-config stages", () => {
  it.each([
    ["dev", 256, "eu-west-1"],
    ["staging", 512, "eu-west-1"],
    ["prod", 1024, "eu-central-1"],
  ])("%s", (stage, memory, region) => {
    const saved = process.env.AWS_REGION;
    delete process.env.AWS_REGION;
    try {
      const cfg = Project.load(workFile("10-stages-and-config"), { stage }).config;
      expect(cfg.provider.stage).toBe(stage);
      expect(cfg.provider.memory).toBe(memory);
      expect(cfg.provider.region).toBe(region);
      expect(cfg.provider.environment.TABLE_NAME).toBe(`shop-config-${stage}-orders`);
      expect(cfg.provider.environment.API_BASE_URL).toBe(stage === "prod" ? "https://api.example.com" : `https://api-${stage}.example.com`);
      expect(cfg.functions.config.concurrency ?? null).toBe(stage === "prod" ? 100 : null);
      expect(cfg.provider.state.backend ?? null).toBe(stage === "prod" ? "s3" : null);
    } finally {
      if (saved !== undefined) process.env.AWS_REGION = saved;
    }
  });
});
