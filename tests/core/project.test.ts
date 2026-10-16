import path from "node:path";
import { describe, expect, it } from "vitest";
import { importSpecifier, packageRoot, publicApiSource, runtimeSource } from "../../src/core/paths.js";
import { expand, locateHandler, orchestratorName, parseHandlerRef, resolveHandlerFile, WORK_DIR } from "../../src/core/project.js";
import { getProvider } from "../../src/providers/registry.js";
import { ORCHESTRATOR_HANDLER } from "../../src/runtime/workflow.js";
import { VERSION } from "../../src/version.js";
import { makeProject, tempDir, writeFiles } from "../helpers.js";

describe("handler references", () => {
  it.each([
    ["src/orders.getOrder", "src/orders", ["getOrder"]],
    ["src/index.default", "src/index", ["default"]],
    ["lib/api.handlers.list", "lib/api", ["handlers", "list"]],
    ["app.handler", "app", ["handler"]],
    ["v1.0/api.run", "v1.0/api", ["run"]],
  ])("parseHandlerRef(%j)", (ref, module, exportPath) => {
    expect(parseHandlerRef(ref)).toEqual({ module, exportPath });
  });

  it("parseHandlerRef rejects refs without an export", () => {
    expect(() => parseHandlerRef("nodots")).toThrow(/must be '<module path>.<export>'/);
    expect(() => parseHandlerRef("src/nodots")).toThrow();
  });

  it("resolves files by extension and index files", () => {
    const root = tempDir();
    writeFiles(root, {
      "a.ts": "",
      "b.mjs": "",
      "c.cjs": "",
      "d.jsx": "",
      "e/index.js": "",
      "f/index.mts": "",
      "both.ts": "",
      "both.js": "",
      "exact.txt.js": "",
      "dir.ts": "",
      "dir/index.ts": "",
    });
    const rel = (m: string) => {
      const f = resolveHandlerFile(root, m);
      return f && path.relative(root, f).split(path.sep).join("/");
    };
    expect(rel("a")).toBe("a.ts");
    expect(rel("b")).toBe("b.mjs");
    expect(rel("c")).toBe("c.cjs");
    expect(rel("d")).toBe("d.jsx");
    expect(rel("e")).toBe("e/index.js");
    expect(rel("f")).toBe("f/index.mts");
    expect(rel("both")).toBe("both.ts");
    expect(rel("a.ts")).toBe("a.ts");
    expect(rel("dir")).toBe("dir.ts");
    expect(rel("missing")).toBeUndefined();
  });

  it("locateHandler tries the longest module path first", () => {
    const root = tempDir();
    writeFiles(root, { "src/orders.service.ts": "", "src/orders.ts": "", "src/api/index.ts": "", "lib/x.ts": "" });
    const loc = (ref: string) => {
      const l = locateHandler(root, ref);
      return l && { file: path.relative(root, l.file).split(path.sep).join("/"), module: l.module, exportPath: l.exportPath };
    };
    expect(loc("src/orders.service.list")).toEqual({ file: "src/orders.service.ts", module: "src/orders.service", exportPath: ["list"] });
    expect(loc("src/orders.get")).toEqual({ file: "src/orders.ts", module: "src/orders", exportPath: ["get"] });
    expect(loc("src/orders.handlers.get")).toEqual({ file: "src/orders.ts", module: "src/orders", exportPath: ["handlers", "get"] });
    expect(loc("src/api.handler")).toEqual({ file: "src/api/index.ts", module: "src/api", exportPath: ["handler"] });
    expect(loc("lib/x.ts.fn")).toEqual({ file: "lib/x.ts", module: "lib/x.ts", exportPath: ["fn"] });
    expect(loc("src/missing.fn")).toBeUndefined();
  });
});

describe("Project", () => {
  it("loads config, provider, paths and the default runtime", () => {
    const tmp = makeProject("service: proj\nprovider: {name: aws, stage: qa}\nfunctions: {a: {handler: src/handlers.hello}}\n");
    const project = tmp.load();
    expect(project.provider.name).toBe("aws");
    expect(project.config.provider.runtime).toBe("nodejs22");
    expect(project.root).toBe(tmp.root);
    expect(project.workDir).toBe(path.join(tmp.root, WORK_DIR, "aws-qa"));
    expect(project.sourceDir).toBe(tmp.root);
    expect(project.region).toBe("us-east-1");
    expect(project.validate()).toEqual([]);
    expect(project.loaded.path).toBe(tmp.configPath);
  });

  it("honours load options and package.source", () => {
    const tmp = makeProject(
      "service: proj\nprovider: {name: aws, runtime: '20'}\npackage: {source: app}\nfunctions: {a: {handler: main.run}}\n",
      { "app/main.ts": "export const run = () => 1;" },
    );
    const project = tmp.load({ stage: "prod", region: "eu-west-1" });
    expect(project.workDir).toBe(path.join(tmp.root, ".nskit", "aws-prod"));
    expect(project.sourceDir).toBe(path.join(tmp.root, "app"));
    expect(project.region).toBe("eu-west-1");
    expect(project.config.provider.runtime).toBe("nodejs20");
    expect(project.validate()).toEqual([]);
  });

  it("validate reports a missing source directory and handler modules", () => {
    const missingDir = makeProject("service: proj\nprovider: {name: aws}\npackage: {source: nope}\nfunctions: {a: {handler: m.a}}\n").load();
    expect(missingDir.validate().map(String)).toEqual([expect.stringMatching(/^ERROR: \[package.source\] package.source .*nope is not a directory$/)]);
    const missingFn = makeProject("service: proj\nprovider: {name: aws}\nfunctions: {a: {handler: src/gone.handler}}\n").load();
    const issues = missingFn.validate();
    expect(issues).toHaveLength(1);
    expect(issues[0].where).toBe("functions.a.handler");
    expect(issues[0].message).toMatch(/handler module 'src\/gone' not found under .* \(tried \.ts, \.mts/);
  });

  it("builds the bundle manifest", () => {
    const project = makeProject(`
      service: proj
      provider: {name: aws, memory: 512}
      functions:
        b: {handler: src/handlers.hello, timeout: 5, events: [{http: {path: /b, method: post, cors: {origins: ["https://x"]}}}, {queue: q}]}
        a: {handler: src/handlers.step, memory: 128}
      workflows:
        native: {start_at: A, states: {A: {type: task, function: a}}}
        emb: {engine: embedded, start_at: A, states: {A: {type: task, function: a}}}
    `).load();
    const manifest = project.bundleManifest();
    expect(manifest).toMatchObject({ service: "proj", stage: "dev", provider: "aws", region: "us-east-1", version: VERSION });
    expect(Object.keys(manifest.functions)).toEqual(["a", "b", "emb-orchestrator"]);
    expect(manifest.functions.a).toEqual({ handler: "src/handlers.step", routes: [], timeout: 30, memory: 128, resourceName: "proj-dev-a" });
    expect(manifest.functions.b.routes).toEqual([
      { method: "POST", path: "/b", cors: { origins: ["https://x"], exposeHeaders: [], allowCredentials: false, maxAge: 600 } },
    ]);
    expect(manifest.functions.b).toMatchObject({ timeout: 5, memory: 512 });
    expect(manifest.functions["emb-orchestrator"]).toMatchObject({
      handler: ORCHESTRATOR_HANDLER,
      routes: [{ method: "POST", path: "/workflows/emb", cors: null }],
      timeout: 900,
    });
    expect(Object.keys(manifest.workflows)).toEqual(["emb"]);
    expect(manifest.workflows.emb).toEqual({
      orchestrator: "emb-orchestrator",
      definition: { startAt: "A", states: { A: { type: "task", function: "a", end: true, resultPath: "$" } } },
    });
    expect(project.engines).toEqual({ native: "native", emb: "embedded" });
  });
});

describe("expand", () => {
  const cfg = (yaml: string) => makeProject(yaml).load().loaded.config;

  it("adds orchestrators only for embedded workflows, capped by the provider timeout", () => {
    const config = cfg(`
      service: proj
      provider: {name: aws}
      functions: {a: {handler: src/handlers.step}}
      workflows:
        long: {engine: embedded, timeout: 5000, start_at: A, states: {A: {type: task, function: a}}}
        short: {engine: embedded, start_at: A, states: {A: {type: task, function: a}}}
        nat: {start_at: A, states: {A: {type: task, function: a}}}
    `);
    const [expanded, engines] = expand(config, getProvider("aws"));
    expect(engines).toEqual({ long: "embedded", short: "embedded", nat: "native" });
    expect(Object.keys(expanded.functions).sort()).toEqual(["a", "long-orchestrator", "short-orchestrator"]);
    expect(expanded.functions["long-orchestrator"].timeout).toBe(900);
    expect(expanded.functions["short-orchestrator"]).toMatchObject({
      handler: ORCHESTRATOR_HANDLER,
      timeout: 900,
      environment: {},
      tags: { "nskit-workflow": "short" },
      iam: { statements: [] },
      options: {},
    });
    expect(config.functions).not.toHaveProperty("long-orchestrator"); // input untouched
  });

  it("returns the same config when nothing is added and keeps user-defined orchestrators", () => {
    const plain = cfg("service: proj\nprovider: {name: aws}\nfunctions: {a: {handler: src/handlers.step}}\n");
    expect(expand(plain, getProvider("aws"))[0]).toBe(plain);
    const custom = cfg(`
      service: proj
      provider: {name: aws}
      functions:
        a: {handler: src/handlers.step}
        w-orchestrator: {handler: src/handlers.tick, memory: 1024}
      workflows:
        w: {engine: embedded, start_at: A, states: {A: {type: task, function: a}}}
    `);
    const [expanded] = expand(custom, getProvider("aws"));
    expect(expanded.functions["w-orchestrator"].handler).toBe("src/handlers.tick");
  });

  it("orchestratorName", () => {
    expect(orchestratorName("order-flow")).toBe("order-flow-orchestrator");
  });
});

describe("paths", () => {
  it("locates the package and runtime sources", () => {
    const root = packageRoot();
    expect(path.basename(path.join(root, "package.json"))).toBe("package.json");
    expect(runtimeSource("adapters/aws")).toBe(path.join(root, "src", "runtime", "adapters/aws.ts"));
    expect(publicApiSource()).toBe(path.join(root, "src", "index.ts"));
  });

  it("importSpecifier is POSIX and always relative", () => {
    const base = path.resolve("/project/.nskit/entry");
    expect(importSpecifier(base, path.resolve("/project/src/a.ts"))).toBe("../../src/a.ts");
    expect(importSpecifier(base, path.join(base, "x.ts"))).toBe("./x.ts");
    expect(importSpecifier(base, path.join(base, "sub", "y.ts"))).toBe("./sub/y.ts");
  });
});
