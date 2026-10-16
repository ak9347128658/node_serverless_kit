import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  collectRecords,
  escapeHtml,
  localRecord,
  renderHtml,
  scriptSafeJson,
  serveDashboard,
  writeDashboard,
  type DashboardRecord,
} from "../src/dashboard/generator";
import { DASHBOARD_TEMPLATE } from "../src/dashboard/template";
import { Project } from "../src/core/project";

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "nskit-dash-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const EVIL = "</script><script>alert(1)</script><!-- \u2028 & $& $1";

function record(over: Partial<DashboardRecord> = {}): DashboardRecord {
  return {
    schema: 1,
    status: "deployed",
    service: "orders",
    stage: "dev",
    provider: "aws",
    providerDisplay: "AWS Lambda",
    providerTier: "stable",
    region: "us-east-1",
    endpoint: "https://abc.execute-api.us-east-1.amazonaws.com",
    deployedAt: "2026-01-01T00:00:00Z",
    nskitVersion: "0.1.0",
    configFile: "nskit.yml",
    artifact: { sha256: "0123456789abcdef0123", size: 1000, files: 3 },
    functions: [
      {
        name: "get-order",
        resourceName: "orders-dev-get-order",
        handler: "src/orders.getOrder",
        description: EVIL,
        kind: "http",
        generated: false,
        runtime: "nodejs22",
        memory: 256,
        timeout: 30,
        architecture: "arm64",
        events: [{ type: "http", summary: "GET /orders/{id}" }],
        environmentKeys: ["TABLE_NAME"],
        id: "orders-dev-get-order",
        arn: "arn:aws:lambda:us-east-1:123:function:orders-dev-get-order",
        url: null,
        urls: [{ method: "GET", url: "https://abc.execute-api.us-east-1.amazonaws.com/orders/{id}" }],
        console: "javascript:alert(1)",
      },
    ],
    workflows: [
      {
        name: "pipeline",
        description: "",
        engine: "native",
        startAt: "A",
        states: { A: "task", B: "succeed" },
        functions: ["get-order"],
        id: "arn:aws:states:us-east-1:123:stateMachine:pipeline",
        url: null,
        console: null,
      },
    ],
    outputs: {},
    ...over,
  };
}

function payloadOf(html: string): string {
  const m = /<script type="application\/json" id="nskit-data">([\s\S]*?)<\/script>/.exec(html);
  expect(m).not.toBeNull();
  return m![1];
}

describe("renderHtml", () => {
  it("embeds the records safely (no script break-out)", () => {
    const html = renderHtml([record()], { title: "<b>t</b>", generatedAt: "2026-01-01T00:00:00Z" });
    expect(html).toContain("<title>&lt;b&gt;t&lt;/b&gt;</title>");
    expect(html).toContain('<h1 id="title">&lt;b&gt;t&lt;/b&gt;</h1>');
    const payload = payloadOf(html);
    expect(payload).not.toMatch(/[<>]/);
    expect(payload).not.toContain("\u2028");
    expect(html.match(/<\/script>/g)).toHaveLength(2); // the data block and the app script only
    const data = JSON.parse(payload);
    expect(data.deployments[0].functions[0].description).toBe(EVIL); // `$&` was not interpreted
    expect(data.generatedAt).toBe("2026-01-01T00:00:00Z");
    expect(data.deployments[0].functions[0].environmentKeys).toEqual(["TABLE_NAME"]);
  });

  it("never renders record values as HTML and filters link schemes", () => {
    expect(DASHBOARD_TEMPLATE).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(DASHBOARD_TEMPLATE).toContain("function safeUrl(u) { return /^https?:\\/\\//i.test(str(u))");
    // No external resources: works offline.
    expect(DASHBOARD_TEMPLATE).not.toMatch(/<script[^>]+src=|<link[^>]+href=|@import|https?:\/\/(?!\/)/);
  });

  it("ships a syntactically valid script with light and dark themes", () => {
    const html = renderHtml([record()]);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts).toHaveLength(1);
    expect(() => new Function(scripts[0])).not.toThrow();
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain('[data-theme="dark"]');
    expect(html).toContain("@media (max-width: 720px)");
    expect(html).toContain('id="q" type="search"');
  });

  it("uses the service names as the default title", () => {
    const html = renderHtml([record(), record({ service: "billing" })]);
    expect(html).toContain("<title>billing / orders dashboard</title>");
    expect(renderHtml([])).toContain("<title>Serverless dashboard</title>");
  });

  it("helpers escape correctly", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    const s = scriptSafeJson({ a: "</script>&\u2029" });
    expect(s).toBe('{"a":"\\u003c/script\\u003e\\u0026\\u2029"}');
    expect(JSON.parse(s)).toEqual({ a: "</script>&\u2029" });
  });
});

describe("collect / write / serve", () => {
  it("collects every deployment.json and skips broken ones", () => {
    const root = path.join(tmpRoot, "proj");
    for (const [dir, rec] of [
      ["gcp-prod", record({ provider: "gcp", stage: "prod" })],
      ["aws-dev", record()],
    ] as const) {
      mkdirSync(path.join(root, ".nskit", dir), { recursive: true });
      writeFileSync(path.join(root, ".nskit", dir, "deployment.json"), JSON.stringify(rec));
    }
    mkdirSync(path.join(root, ".nskit", "broken-dev"), { recursive: true });
    writeFileSync(path.join(root, ".nskit", "broken-dev", "deployment.json"), "{not json");
    mkdirSync(path.join(root, ".nskit", "dashboard"), { recursive: true });
    const records = collectRecords(root);
    expect(records.map((r) => `${r.provider}-${r.stage}`)).toEqual(["aws-dev", "gcp-prod"]);
    expect(collectRecords(path.join(tmpRoot, "nothing-here"))).toEqual([]);

    const out = writeDashboard(root);
    expect(out).toBe(path.join(root, ".nskit", "dashboard", "index.html"));
    const html = readFileSync(out, "utf-8");
    expect(html).toContain("<title>orders dashboard</title>");
    expect(JSON.parse(payloadOf(html)).deployments).toHaveLength(2);

    const custom = writeDashboard(root, { output: path.join(tmpRoot, "out", "x.html"), records: [], title: "Mine" });
    expect(readFileSync(custom, "utf-8")).toContain("<title>Mine</title>");
  });

  it("builds a local record from the config without secrets", () => {
    const root = path.join(tmpRoot, "local");
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "h.js"), "export const a = () => 1;\n");
    writeFileSync(
      path.join(root, "nskit.yml"),
      "service: loc\nprovider:\n  name: aws\n  environment: {SECRET_TOKEN: hunter2}\nfunctions:\n  a:\n    handler: src/h.a\n    environment: {API_KEY: s3cr3t}\n",
    );
    const rec = localRecord(Project.load(path.join(root, "nskit.yml")));
    expect(rec.status).toBe("local");
    expect(rec.functions![0].environmentKeys).toEqual(["API_KEY", "SECRET_TOKEN"]);
    const html = renderHtml([rec]);
    expect(html).toContain("SECRET_TOKEN");
    expect(html).not.toContain("hunter2");
    expect(html).not.toContain("s3cr3t");
  });

  it("serves the dashboard over HTTP", async () => {
    const file = writeDashboard(path.join(tmpRoot, "serve"), { records: [record()] });
    const { server, url } = await serveDashboard(file, { port: 0 });
    try {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/index\.html$/);
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("orders dashboard");
      expect((await fetch(new URL("/", url))).status).toBe(200);
      expect((await fetch(new URL("/etc/passwd", url))).status).toBe(404);
      expect((await fetch(url, { method: "POST" })).status).toBe(405);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
