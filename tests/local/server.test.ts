import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalRunner } from "../../src/local/runner";
import { isWatchedFile, loadDotenv, parseDotenv, routeTable, startDevServer, type DevServer } from "../../src/local/server";

const CONFIG = `
service: dev
provider:
  name: aws
  environment: {GREETING: hi}
functions:
  hello:
    handler: src/handlers.hello
    events:
      - http: GET /hello/{name}
      - http: GET /hello
  create:
    handler: src/handlers.create
    events: [{http: {path: /items, method: POST, cors: true}}]
  me:
    handler: src/handlers.me
    events: [{http: GET /users/me}]
  user:
    handler: src/handlers.user
    events: [{http: "GET /users/{id}"}]
  step:
    handler: src/handlers.step
  jobs:
    handler: src/handlers.jobs
workflows:
  twice:
    startAt: A
    states:
      A: {type: task, function: step, next: B}
      B: {type: task, function: step, end: true}
  broken:
    startAt: Boom
    states:
      Boom: {type: fail, error: Nope, cause: always}
`;

const HANDLERS = `import { BadRequest, BatchResult, HttpResponse } from "node_serverless_kit";

export const hello = async (event) => {
  const name = event.http.pathParams.name ?? event.http.query.name ?? "world";
  return { message: "hello " + name, greeting: process.env.GREETING, secret: process.env.SECRET ?? null };
};

export const create = async (event) => {
  const body = event.http.json();
  if (!body.id) throw new BadRequest("id is required");
  const res = HttpResponse.json(body, 201);
  res.cookies.push("sid=1; Path=/");
  return res;
};

export const me = async () => ({ who: "me" });
export const user = async (event) => ({ who: event.http.pathParams.id });
export const step = async (event) => ({ steps: ((event.data && event.data.steps) || 0) + 1 });
export const jobs = async (event) => {
  const result = new BatchResult();
  for (const r of event.records) if (r.text() === "bad") result.fail(r);
  return result;
};
`;

let root: string;
let dev: DevServer;
const logs: string[] = [];

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "nskit-dev-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "nskit.yml"), CONFIG);
  writeFileSync(path.join(root, "src", "handlers.js"), HANDLERS);
  writeFileSync(path.join(root, ".env"), "export SECRET='abc'\n# comment\nPLAIN=1\n");
  const runner = await LocalRunner.fromConfig(path.join(root, "nskit.yml"), { mode: "bundle", env: loadDotenv(path.join(root, ".env")) });
  dev = await startDevServer(runner, { port: 0, debounceMs: 50, envFile: path.join(root, ".env"), log: (m) => logs.push(m) });
});

afterAll(async () => {
  await dev?.close();
  rmSync(root, { recursive: true, force: true });
});

async function call(urlPath: string, init: RequestInit & { json?: unknown } = {}) {
  const { json, ...rest } = init;
  const res = await fetch(dev.url + urlPath, {
    ...rest,
    body: json === undefined ? rest.body : JSON.stringify(json),
    headers: { ...(json === undefined ? {} : { "content-type": "application/json" }), ...(rest.headers as Record<string, string>) },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, headers: res.headers, body, text };
}

describe("dev server routes", () => {
  it("serves http routes with path params and query", async () => {
    let res = await call("/hello/Grace");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: "hello Grace", greeting: "hi", secret: "abc" });
    res = await call("/hello?name=Q");
    expect(res.body).toMatchObject({ message: "hello Q" });
    expect((await call("/users/me")).body).toEqual({ who: "me" });
    expect((await call("/users/42")).body).toEqual({ who: "42" });
  });

  it("handles JSON bodies, cookies, CORS and errors through the dispatcher", async () => {
    let res = await call("/items", { method: "POST", json: { id: 1 }, headers: { Origin: "https://x.example" } });
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("set-cookie")).toContain("sid=1");
    res = await call("/items", { method: "POST", json: { no: "id" } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "id is required", status: 400 });

    const pre = await call("/items", {
      method: "OPTIONS",
      headers: { Origin: "https://x.example", "Access-Control-Request-Method": "POST" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("returns 405 for a known path and 404 with the route list otherwise", async () => {
    expect((await call("/hello", { method: "DELETE" })).status).toBe(405);
    const res = await call("/nope");
    expect(res.status).toBe(404);
    expect((res.body as { routes: string[] }).routes).toContain("GET /hello/{name}");
  });

  it("prints a route table", () => {
    const lines = routeTable(dev.runner, dev.url).join("\n");
    expect(lines).toContain(`GET     ${dev.url}/users/me  -> me`);
    expect(lines).toContain(`POST    ${dev.url}/items  -> create`);
    expect(lines).toContain("/__nskit/workflows/<workflow>");
    expect(lines.indexOf("/users/me")).toBeLessThan(lines.indexOf("/users/{id}"));
  });
});

describe("internal endpoints", () => {
  it("invokes functions with any event type", async () => {
    let res = await call("/__nskit/invoke/step", { method: "POST", json: { steps: 1 } });
    expect(res).toMatchObject({ status: 200, body: { result: { steps: 2 } } });
    res = await call("/__nskit/invoke/jobs?type=queue", { method: "POST", json: ["ok", "bad"] });
    expect(res.body).toEqual({ result: { batchItemFailures: [{ itemIdentifier: "2" }] } });
    res = await call("/__nskit/invoke/hello", { method: "POST", json: {} });
    expect(res.status).toBe(500); // http handler invoked without an http request
    expect(res.body).toHaveProperty("errorType");
    expect((await call("/__nskit/invoke/missing", { method: "POST", json: {} })).status).toBe(404);
    expect((await call("/__nskit/invoke/step?type=bogus", { method: "POST" })).status).toBe(404);
  });

  it("runs workflows", async () => {
    let res = await call("/__nskit/workflows/twice", { method: "POST", json: {} });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "SUCCEEDED", output: { steps: 2 } });
    res = await call("/__nskit/workflows/broken", { method: "POST" });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ status: "FAILED", error: "Nope", cause: "always" });
    expect((await call("/__nskit/workflows/missing", { method: "POST" })).status).toBe(404);
  });

  it("serves the dashboard and the route list", async () => {
    const res = await call("/__nskit/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.text).toContain("<title>dev (local)</title>");
    const routes = await call("/__nskit/routes");
    expect(routes.body).toEqual(expect.arrayContaining([{ functionName: "me", method: "GET", path: "/users/me" }]));
    expect((await call("/__nskit/nothing")).status).toBe(404);
  });
});

describe("hot reload", () => {
  it("rebuilds when a source file changes", async () => {
    const file = path.join(root, "src", "handlers.js");
    const before = dev.reloads;
    writeFileSync(file, readFileSync(file, "utf-8").replace('"hello " + name', '"howdy " + name'));
    const deadline = Date.now() + 15_000;
    let message = "";
    while (Date.now() < deadline) {
      message = ((await call("/hello/Bo")).body as { message: string }).message;
      if (message === "howdy Bo") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(message).toBe("howdy Bo");
    expect(dev.reloads).toBeGreaterThan(before);
    expect(logs.some((l) => l.includes("reloaded"))).toBe(true);
  });

  it("keeps serving the previous build when the new code does not compile", async () => {
    const file = path.join(root, "src", "handlers.js");
    const good = readFileSync(file, "utf-8");
    writeFileSync(file, good + "\nexport const = ;\n");
    await dev.reload();
    expect(logs.some((l) => l.includes("reload failed"))).toBe(true);
    expect((await call("/hello/Al")).status).toBe(200);
    writeFileSync(file, good);
    await dev.reload();
  });

  it("only watches relevant files", () => {
    expect(isWatchedFile("src/handlers.ts")).toBe(true);
    expect(isWatchedFile(".env")).toBe(true);
    expect(isWatchedFile(path.join(".nskit", "local", "bundle.cjs"))).toBe(false);
    expect(isWatchedFile("node_modules/x/index.js")).toBe(false);
    expect(isWatchedFile(".git/HEAD")).toBe(false);
    expect(isWatchedFile("src/.handlers.ts.swp")).toBe(false);
  });
});

describe("dotenv", () => {
  it("parses dotenv syntax", () => {
    expect(parseDotenv("export SECRET='abc'\n# c\nPLAIN=1\nQ=\"a\\nb\"\nC=x # trailing\nbad line\n=nokey\n")).toEqual({
      SECRET: "abc",
      PLAIN: "1",
      Q: "a\nb",
      C: "x",
    });
    expect(loadDotenv(path.join(os.tmpdir(), "definitely-missing.env"))).toEqual({});
  });
});
