import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Project } from "../../src/core/project.js";
import { BuildError, buildArtifact, entrySource } from "../../src/packaging/builder.js";
import { AwsProvider } from "../../src/providers/aws.js";
import type { Artifact, BundleTarget, EntryContext } from "../../src/providers/base.js";
import type { BundleManifest } from "../../src/runtime/manifest.js";
import { dedent, makeProject, readZip } from "../helpers.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const req = createRequire(import.meta.url);
type Mod = { handler: (event: unknown, ctx?: unknown) => Promise<any> };

const savedEnv = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

function build(project: Project): Promise<Artifact> {
  return buildArtifact(project, { skipInstall: true });
}

function load(artifact: Artifact): Mod {
  return req(path.join(artifact.buildDir, artifact.entryFile)) as Mod;
}

const lambdaCtx = { awsRequestId: "req-1", getRemainingTimeInMillis: () => 3000 };

async function invoke(mod: Mod, fn: string, data: unknown = null): Promise<any> {
  process.env.NSKIT_FUNCTION = fn;
  process.env.NSKIT_LOG_LEVEL = "error";
  return mod.handler({ __nskit: "invoke", data }, lambdaCtx);
}

async function http(mod: Mod, fn: string, method: string, rawPath: string, body?: string): Promise<{ statusCode: number; body: any; headers: any }> {
  process.env.NSKIT_FUNCTION = fn;
  process.env.NSKIT_LOG_LEVEL = "error";
  const out = await mod.handler(
    { version: "2.0", rawPath, headers: { "content-type": "application/json" }, requestContext: { http: { method, path: rawPath } }, body },
    lambdaCtx,
  );
  return { ...out, body: out.body ? JSON.parse(out.body) : out.body };
}

function zipNames(artifact: Artifact): string[] {
  return readZip(readFileSync(artifact.path)).map((e) => e.name);
}

const BASIC = `
  service: pkg
  provider: {name: aws}
  package:
    include: ["templates/**", "data/*.json"]
    exclude: ["data/secret_*"]
  functions:
    hello: {handler: src/handlers.hello, events: [{http: "GET /hello/{name}"}, {http: {path: /hello, cors: true}}]}
    create: {handler: src/handlers.create, events: [{http: POST /items}]}
    worker: {handler: src/handlers.worker, events: [{queue: jobs}]}
    tick: {handler: src/handlers.tick, events: [{schedule: 5 minutes}]}
    step: {handler: src/handlers.step}
    env: {handler: src/handlers.env, environment: {GREETING: hi}}
    asset: {handler: src/assets.read}
  workflows:
    pipeline:
      engine: embedded
      start_at: A
      states:
        A: {type: task, function: step, next: B}
        B: {type: task, function: step}
`;

const ASSETS_TS = dedent(`
  import { readFileSync } from "node:fs";
  import path from "node:path";
  export function read() {
    return readFileSync(path.join(__dirname, "templates", "hello.txt"), "utf-8").trim();
  }
`);

describe("TypeScript project", () => {
  let project: Project;
  let artifact: Artifact;
  let mod: Mod;

  beforeAll(async () => {
    const tmp = makeProject(BASIC, {
      "src/assets.ts": ASSETS_TS,
      "templates/hello.txt": "hello from a template\n",
      "templates/sub/deep.html": "<p>deep</p>",
      "data/public.json": "{}",
      "data/secret_keys.json": "{}",
      ".env": "SECRET=1",
    });
    project = tmp.load();
    artifact = await build(project);
    mod = load(artifact);
  });

  it("writes the artifact layout", () => {
    expect(artifact.entryFile).toBe("index.js");
    expect(artifact.buildDir).toBe(path.join(project.workDir, "build"));
    expect(artifact.path).toBe(path.join(project.workDir, "artifact.zip"));
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(artifact.sha256Base64, "base64").toString("hex")).toBe(artifact.sha256);
    expect(artifact.size).toBe(readFileSync(artifact.path).length);
    const names = zipNames(artifact);
    expect(names).toEqual([
      "data/public.json",
      "index.js",
      "index.js.map",
      "nskit_manifest.json",
      "package.json",
      "templates/hello.txt",
      "templates/sub/deep.html",
    ]);
    expect(artifact.fileCount).toBe(names.length);
    expect(existsSync(path.join(project.workDir, "entry", "nskit-entry.ts"))).toBe(true);
  });

  it("zip entries match the build directory", () => {
    for (const entry of readZip(readFileSync(artifact.path))) {
      expect(entry.data.equals(readFileSync(path.join(artifact.buildDir, entry.name))), entry.name).toBe(true);
    }
  });

  it("pins package.json to commonjs and writes the manifest", () => {
    expect(JSON.parse(readFileSync(path.join(artifact.buildDir, "package.json"), "utf-8"))).toEqual({
      name: "pkg-dev",
      version: "1.0.0",
      private: true,
      type: "commonjs",
    });
    const manifest = JSON.parse(readFileSync(path.join(artifact.buildDir, "nskit_manifest.json"), "utf-8")) as BundleManifest;
    expect(manifest).toMatchObject({ service: "pkg", stage: "dev", provider: "aws", region: "us-east-1" });
    expect(manifest.functions.hello).toEqual({
      handler: "src/handlers.hello",
      routes: [
        { method: "GET", path: "/hello/{name}", cors: null },
        { method: "GET", path: "/hello", cors: { origins: ["*"], exposeHeaders: [], allowCredentials: false, maxAge: 600 } },
      ],
      timeout: 30,
      memory: 256,
      resourceName: "pkg-dev-hello",
    });
    expect(Object.keys(manifest.functions)).toEqual(["asset", "create", "env", "hello", "pipeline-orchestrator", "step", "tick", "worker"]);
    expect(manifest.workflows.pipeline.orchestrator).toBe("pipeline-orchestrator");
    expect(manifest.workflows.pipeline.definition.startAt).toBe("A");
  });

  it("contains no absolute paths, timestamps or CRLF", () => {
    for (const file of ["index.js", "index.js.map", "nskit_manifest.json", "package.json"]) {
      const text = readFileSync(path.join(artifact.buildDir, file), "utf-8");
      expect(text, file).not.toContain(project.root);
      expect(text, file).not.toContain(project.root.split(path.sep).join("/"));
      expect(text, file).not.toContain("\r\n");
    }
    const map = JSON.parse(readFileSync(path.join(artifact.buildDir, "index.js.map"), "utf-8"));
    expect(map.sourcesContent).toBeUndefined();
    expect(readFileSync(path.join(artifact.buildDir, "index.js"), "utf-8")).toContain("//# sourceMappingURL=index.js.map");
  });

  it("is byte-reproducible", async () => {
    const again = await build(project);
    expect(again.sha256).toBe(artifact.sha256);
    expect(again.size).toBe(artifact.size);
  });

  it("the bundle serves HTTP", async () => {
    const ok = await http(mod, "hello", "GET", "/hello/Ada");
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toEqual({ message: "hello Ada", provider: "aws", fn: "hello" });
    expect((await http(mod, "hello", "DELETE", "/hello/Ada")).statusCode).toBe(405);
    const created = await http(mod, "create", "POST", "/items", '{"id": 7}');
    expect(created).toMatchObject({ statusCode: 201, body: { id: 7 } });
    const missing = await http(mod, "create", "POST", "/items", "{}");
    expect(missing).toMatchObject({ statusCode: 404, body: { error: "missing id", status: 404 } });
    const bad = await http(mod, "create", "POST", "/items", "{oops");
    expect(bad).toMatchObject({ statusCode: 400, body: { error: "Request body is not valid JSON" } });
  });

  it("the bundle handles queue, schedule and invoke events", async () => {
    process.env.NSKIT_FUNCTION = "worker";
    const sqs = {
      Records: [
        { messageId: "m1", body: "ok", eventSource: "aws:sqs" },
        { messageId: "m2", body: "fail", eventSource: "aws:sqs" },
      ],
    };
    expect(await mod.handler(sqs, lambdaCtx)).toEqual({ batchItemFailures: [{ itemIdentifier: "m2" }] });
    process.env.NSKIT_FUNCTION = "tick";
    expect(await mod.handler({ __nskit: "schedule", data: { r: 1 }, source: "aws.scheduler" }, lambdaCtx)).toEqual({
      type: "schedule",
      data: { r: 1 },
      source: "aws.scheduler",
    });
    expect(await invoke(mod, "step", { steps: 1 })).toEqual({ steps: 2 });
    expect(await invoke(mod, "asset")).toBe("hello from a template");
  });

  it("runs the embedded orchestrator inside the bundle", async () => {
    expect(await invoke(mod, "pipeline-orchestrator", { steps: 0 })).toMatchObject({
      workflow: "pipeline",
      status: "SUCCEEDED",
      output: { steps: 2 },
    });
  });
});

describe("entrySource", () => {
  it("maps every handler to a lazy import", () => {
    const project = makeProject(BASIC, { "src/assets.ts": ASSETS_TS }).load();
    const entryDir = path.join(project.workDir, "entry");
    const src = entrySource(project, { entryDir, manifest: project.bundleManifest(), glue: "export const glue = 1;\n\n" });
    expect(src.startsWith("// Generated by node-serverless-kit.")).toBe(true);
    expect(src).toContain('import manifest from "./nskit_manifest.json";');
    expect(src).toMatch(/import \{ installBundle \} from "(\.\.\/)+.*src\/runtime\/manifest\.ts";/);
    expect(src).toContain('"src/handlers.hello": () => import("../../../src/handlers.ts").then((m) => pick(m, ["hello"])),');
    expect(src).toMatch(/"node-serverless-kit\/workflow\.orchestrate": \(\) => import\(".*src\/runtime\/workflow\.ts"\)\.then\(\(m\) => pick\(m, \["orchestrate"\]\)\),/);
    expect(src).toContain("installBundle({ manifest, handlers });");
    expect(src.trimEnd().endsWith("export const glue = 1;")).toBe(true);
    const refs = [...src.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]);
    expect(refs).toEqual([...refs].sort());
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("rejects missing modules and unknown built-ins", () => {
    const project = makeProject("service: pkg\nprovider: {name: aws}\nfunctions: {a: {handler: src/nope.handler}}\n").load();
    const manifest = project.bundleManifest();
    expect(() => entrySource(project, { entryDir: project.workDir, manifest, glue: "" })).toThrow(BuildError);
    expect(() => entrySource(project, { entryDir: project.workDir, manifest, glue: "" })).toThrow(/handler 'src\/nope.handler': module not found/);
    manifest.functions.a.handler = "node-serverless-kit/magic.fn";
    expect(() => entrySource(project, { entryDir: project.workDir, manifest, glue: "" })).toThrow(/unknown built-in handler/);
  });
});

describe("handler resolution", () => {
  it("dotted names, index files, every extension, default and nested exports, CommonJS", async () => {
    const files: Record<string, string> = {
      "src/orders.service.ts": "export const list = () => 'dotted';\n",
      "src/api/index.ts": "export const handler = () => 'index';\n",
      "src/plain.js": "export function run() { return 'js'; }\n",
      "src/modern.mjs": "export const run = async () => 'mjs';\n",
      "src/legacy.cjs": "exports.run = function () { return 'cjs'; };\nexports.other = () => 'cjs-other';\n",
      "src/commonfn.js": "module.exports = function () { return 'module.exports fn'; };\n",
      "src/commonobj.js": "module.exports = { handlers: { list: () => 'cjs nested' } };\n",
      "src/def.ts": "export default async function () { return 'default'; }\n",
      "src/nested.ts": "export const handlers = { orders: { list: () => 'nested' } };\n",
      "src/explicit.ts": "export const fn = () => 'explicit';\n",
      "src/component.tsx": "export const render = () => 'tsx';\n",
      "src/typed.mts": "export const run = (): string => 'mts';\n",
    };
    const tmp = makeProject(
      `
      service: resolve
      provider: {name: aws}
      functions:
        dotted: {handler: src/orders.service.list}
        index: {handler: src/api.handler}
        js: {handler: src/plain.run}
        mjs: {handler: src/modern.run}
        cjs: {handler: src/legacy.run}
        cjsother: {handler: src/legacy.other}
        cjsfn: {handler: src/commonfn.default}
        cjsnested: {handler: src/commonobj.handlers.list}
        def: {handler: src/def.default}
        nested: {handler: src/nested.handlers.orders.list}
        explicit: {handler: src/explicit.ts.fn}
        tsx: {handler: src/component.render}
        mts: {handler: src/typed.run}
      `,
      files,
    );
    const project = tmp.load();
    expect(project.validate().filter((i) => i.level === "error")).toEqual([]);
    const mod = load(await build(project));
    const expected: Record<string, string> = {
      dotted: "dotted",
      index: "index",
      js: "js",
      mjs: "mjs",
      cjs: "cjs",
      cjsother: "cjs-other",
      cjsfn: "module.exports fn",
      cjsnested: "cjs nested",
      def: "default",
      nested: "nested",
      explicit: "explicit",
      tsx: "tsx",
      mts: "mts",
    };
    for (const [fn, value] of Object.entries(expected)) expect(await invoke(mod, fn), fn).toBe(value);
  });

  it("a missing export fails at call time with a clear error", async () => {
    const project = makeProject("service: resolve\nprovider: {name: aws}\nfunctions: {a: {handler: src/handlers.nothere}}\n").load();
    const mod = load(await build(project));
    await expect(invoke(mod, "a")).rejects.toThrow(/Handler "src\/handlers.nothere" is not a function \(got undefined\)/);
  });
});

describe("module systems", () => {
  it('bundles a "type": "module" JavaScript project', async () => {
    const tmp = makeProject(
      `
      service: esm
      provider: {name: aws}
      functions:
        hello: {handler: lib/hello.hello}
        helper: {handler: lib/hello.viaHelper}
      `,
      {
        "package.json": JSON.stringify({ name: "esm-app", type: "module" }),
        "lib/hello.js": dedent(`
          import { HttpResponse } from "node-serverless-kit";
          import { shout } from "./util.js";
          export const hello = async (event) => HttpResponse.json({ msg: shout(String(event.data)), meta: typeof import.meta.url });
          export const viaHelper = () => shout("x");
        `),
        "lib/util.js": "export const shout = (s) => s.toUpperCase() + '!';\n",
      },
    );
    const artifact = await build(tmp.load());
    expect(JSON.parse(readFileSync(path.join(artifact.buildDir, "package.json"), "utf-8")).type).toBe("commonjs");
    const mod = load(artifact);
    expect(await invoke(mod, "helper")).toBe("X!");
    const resp = await invoke(mod, "hello", "hey");
    expect(resp).toMatchObject({ status: 200 });
  });

  it("bundles a CommonJS JavaScript project that requires the package", async () => {
    const tmp = makeProject(
      `
      service: cjs
      provider: {name: aws}
      functions:
        a: {handler: handlers.main}
      `,
      {
        "handlers.js": dedent(`
          const { NotFound, isHttpError } = require("node-serverless-kit");
          const lib = require("./lib");
          exports.main = async (event) => {
            try { throw new NotFound("x"); } catch (e) { return { lib: lib.value, http: isHttpError(e), data: event.data }; }
          };
        `),
        "lib.js": "module.exports = { value: 42 };\n",
      },
    );
    const mod = load(await build(tmp.load()));
    expect(await invoke(mod, "a", 1)).toEqual({ lib: 42, http: true, data: 1 });
  });
});

describe("build options", () => {
  it("honours tsconfig path aliases", async () => {
    const tmp = makeProject(
      `
      service: alias
      provider: {name: aws}
      functions: {a: {handler: src/app.run}}
      `,
      {
        "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } } }),
        "src/app.ts": 'import { greet } from "@lib/greet";\nexport const run = () => greet("alias");\n',
        "src/lib/greet.ts": "export const greet = (n: string) => `hi ${n}`;\n",
      },
    );
    expect(await invoke(load(await build(tmp.load())), "a")).toBe("hi alias");
  });

  it("package.tsconfig selects another file; a missing one is an error", async () => {
    const files = {
      "tsconfig.build.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "~/*": ["src/*"] } } }),
      "src/app.ts": 'import { v } from "~/v";\nexport const run = () => v;\n',
      "src/v.ts": "export const v = 'custom tsconfig';\n",
    };
    const ok = makeProject("service: alias\nprovider: {name: aws}\npackage: {tsconfig: tsconfig.build.json}\nfunctions: {a: {handler: src/app.run}}\n", files);
    expect(await invoke(load(await build(ok.load())), "a")).toBe("custom tsconfig");
    const bad = makeProject("service: alias\nprovider: {name: aws}\npackage: {tsconfig: nope.json}\nfunctions: {a: {handler: src/app.run}}\n", files);
    await expect(build(bad.load())).rejects.toThrow(/package.tsconfig .*nope.json does not exist/);
  });

  it("keeps externals out of the bundle and pins their versions", async () => {
    const tmp = makeProject(
      `
      service: ext
      provider: {name: aws}
      package: {external: [left-pad, not-installed]}
      functions: {a: {handler: src/app.run}, b: {handler: src/app.other}}
      `,
      {
        "package.json": JSON.stringify({ name: "ext", dependencies: { "left-pad": "^1.3.0", "not-installed": "~2.0.0" } }),
        "node_modules/left-pad/package.json": JSON.stringify({ name: "left-pad", version: "1.3.0", main: "index.js" }),
        "node_modules/left-pad/index.js": "module.exports = (s, n) => String(s).padStart(n, '0');\n",
        "src/app.ts": dedent(`
          import leftPad from "left-pad";
          import "not-installed";
          export const run = () => leftPad(5, 3);
          export const other = async () => {
            const { S3Client } = await import("@aws-sdk/client-s3");
            return typeof S3Client;
          };
        `),
      },
    );
    const artifact = await build(tmp.load());
    const code = readFileSync(path.join(artifact.buildDir, "index.js"), "utf-8");
    expect(code).toContain('require("left-pad")');
    expect(code).toContain('require("not-installed")');
    expect(code).toMatch(/import\("@aws-sdk\/client-s3"\)|require\("@aws-sdk\/client-s3"\)/);
    expect(code).not.toContain("padStart(n");
    expect(JSON.parse(readFileSync(path.join(artifact.buildDir, "package.json"), "utf-8")).dependencies).toEqual({
      "left-pad": "1.3.0",
      "not-installed": "~2.0.0",
    });
    expect(zipNames(artifact).some((n) => n.startsWith("node_modules/"))).toBe(false);
  });

  it("minify, no sourcemap and raw esbuild options", async () => {
    const tmp = makeProject(
      `
      service: opts
      provider: {name: aws}
      package:
        minify: true
        sourcemap: false
        esbuild: {define: {__BUILD__: '"v1.2.3"'}}
      functions: {a: {handler: src/app.run}}
      `,
      { "src/app.ts": "declare const __BUILD__: string;\nexport const run = () => __BUILD__;\n" },
    );
    const project = tmp.load();
    const artifact = await build(project);
    expect(zipNames(artifact)).toEqual(["index.js", "nskit_manifest.json", "package.json"]);
    const code = readFileSync(path.join(artifact.buildDir, "index.js"), "utf-8");
    expect(code).not.toContain("sourceMappingURL");
    expect(code.split("\n").length).toBeLessThan(20);
    expect(await invoke(load(artifact), "a")).toBe("v1.2.3");
  });

  it("reports bundling failures with a hint", async () => {
    const tmp = makeProject("service: broken\nprovider: {name: aws}\nfunctions: {a: {handler: src/app.run}}\n", {
      "src/app.ts": "export const run = ( => 1;\n",
    });
    const err = await build(tmp.load()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuildError);
    expect((err as Error).message).toMatch(/^bundling failed:\n {2}.*app\.ts:1:\d+: /);
    expect((err as Error).message).toContain("package.external");
  });

  it("reports unresolvable imports", async () => {
    const tmp = makeProject("service: broken\nprovider: {name: aws}\nfunctions: {a: {handler: src/app.run}}\n", {
      "src/app.ts": 'import x from "definitely-not-a-real-package-xyz";\nexport const run = () => x;\n',
    });
    await expect(build(tmp.load())).rejects.toThrow(/Could not resolve "definitely-not-a-real-package-xyz"/);
  });

  it("a removed asset disappears from the next build", async () => {
    const tmp = makeProject("service: assets\nprovider: {name: aws}\npackage: {include: ['static/**']}\nfunctions: {a: {handler: src/handlers.step}}\n", {
      "static/a.txt": "a",
      "static/b.txt": "b",
    });
    const project = tmp.load();
    const first = await build(project);
    expect(zipNames(first)).toContain("static/b.txt");
    const { rmSync } = await import("node:fs");
    rmSync(path.join(tmp.root, "static", "b.txt"));
    const second = await build(project);
    expect(zipNames(second)).not.toContain("static/b.txt");
    expect(readdirSync(path.join(second.buildDir, "static"))).toEqual(["a.txt"]);
    expect(second.sha256).not.toBe(first.sha256);
  });
});

describe("provider bundle targets", () => {
  class EsmProvider extends AwsProvider {
    override readonly bundle: BundleTarget = { format: "esm", platform: "node", entryFile: "index.mjs" };
    override readonly dependencies = { "fake-runtime-dep": "1.0.0" };
    override readonly remoteInstall = true;
    override bundleTarget(): BundleTarget {
      return this.bundle;
    }
    override entryCode(ctx: EntryContext): string {
      return `export { handler } from ${JSON.stringify(ctx.runtime("adapters/aws"))};`;
    }
    override extraFiles(_c: unknown, manifest: BundleManifest): Record<string, string> {
      return { "host.json": JSON.stringify({ functions: Object.keys(manifest.functions) }) + "\n", "package.json": '{"main": "index.mjs"}' };
    }
  }

  it("builds ESM entries with provider files and dependencies", async () => {
    const tmp = makeProject(
      `
      service: esmout
      provider: {name: aws}
      functions:
        a: {handler: src/app.run}
      `,
      { "src/app.ts": 'import { createRequire } from "node:module";\nexport const run = () => typeof createRequire + ":" + typeof require;\n' },
    );
    const base = tmp.load();
    const project = new Project(base.loaded, new EsmProvider(), base.config, base.engines);
    const artifact = await build(project);
    expect(artifact.entryFile).toBe("index.mjs");
    expect(zipNames(artifact)).toEqual(["host.json", "index.mjs", "index.mjs.map", "nskit_manifest.json", "package.json"]);
    const pkg = JSON.parse(readFileSync(path.join(artifact.buildDir, "package.json"), "utf-8"));
    expect(pkg).toEqual({
      name: "esmout-dev",
      version: "1.0.0",
      private: true,
      type: "module",
      main: "index.mjs",
      dependencies: { "fake-runtime-dep": "1.0.0" },
    });
    expect(JSON.parse(readFileSync(path.join(artifact.buildDir, "host.json"), "utf-8"))).toEqual({ functions: ["a"] });
    const code = readFileSync(path.join(artifact.buildDir, "index.mjs"), "utf-8");
    expect(code.startsWith("import { createRequire as __nskitCreateRequire }")).toBe(true);
    const mod = (await import(pathToFileURL(path.join(artifact.buildDir, "index.mjs")).href)) as Mod;
    expect(await invoke(mod, "a")).toBe("function:function");
  });
});
