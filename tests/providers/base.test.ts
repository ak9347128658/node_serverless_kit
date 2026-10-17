import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/loader.js";
import { WorkflowConfig, type ServiceConfig } from "../../src/config/schema.js";
import {
  HTTP,
  Issue,
  Provider,
  ProviderError,
  QUEUE,
  RenderContext,
  stableSuffix,
  WORKFLOW_NATIVE,
  type Capability,
  type EntryContext,
} from "../../src/providers/base.js";
import type { TerraformDoc } from "../../src/providers/terraform-doc.js";
import { fakeArtifact } from "../helpers.js";

class DummyProvider extends Provider {
  readonly name: string = "dummy";
  readonly displayName = "Dummy Cloud";
  readonly terraformSource = "example/dummy";
  override readonly terraformVersion = "~> 1.0";
  override readonly defaultRegion = "moon-1";
  override readonly capabilities = new Set<Capability>([HTTP, QUEUE]);
  override readonly maxNameLength = 20;
  override readonly maxTimeout = 60;
  override readonly runtimes: Record<string, string> = { nodejs18: "node18", nodejs20: "node20" };
  renderResources(doc: TerraformDoc, ctx: RenderContext): void {
    doc.resource("dummy_function", "f", { region: ctx.region });
    doc.output("nskit", { functions: {}, workflows: {}, endpoint: null });
  }
  entryCode(_ctx: EntryContext): string {
    return "export {};";
  }
}

class NativeProvider extends DummyProvider {
  override readonly name = "native";
  override readonly runtimes: Record<string, string> = {};
  override readonly capabilities = new Set<Capability>([HTTP, WORKFLOW_NATIVE]);
  override readonly terraformLocalName = "nat";
}

const cfg = (raw: Record<string, unknown> = {}): ServiceConfig =>
  ({ ...parseConfig({ service: "svc", provider: { name: "dummy", runtime: "20" }, ...raw }) }) as ServiceConfig;

describe("naming", () => {
  const p = new DummyProvider();

  it("joins, lower-cases and sanitizes", () => {
    expect(p.physicalName("svc", "dev", "Hello_World")).toBe("svc-dev-hello-world");
    expect(p.physicalName("svc", "dev", "")).toBe("svc-dev");
    expect(p.physicalName("svc", "", "a--b")).toBe("svc-a-b");
    expect(p.physicalName("-svc", "dev", "x-")).toBe("svc-dev-x");
  });

  it("truncates long names with a stable hash", () => {
    const long = p.physicalName("service", "dev", "a-very-long-function-name");
    expect(long.length).toBeLessThanOrEqual(20);
    expect(long).toMatch(/^service-dev-a-[0-9a-f]{6}$/);
    expect(p.physicalName("service", "dev", "a-very-long-function-name")).toBe(long);
    expect(p.physicalName("service", "dev", "a-very-long-function-other")).not.toBe(long);
  });

  it("stableSuffix", () => {
    expect(stableSuffix(["a", "b"])).toHaveLength(6);
    expect(stableSuffix(["a", "b"], 10)).toHaveLength(10);
    expect(stableSuffix(["a", "b"])).toBe(stableSuffix(["a", "b"]));
  });
});

describe("runtimes", () => {
  it("defaultRuntime picks nodejs22 or the newest older supported version", () => {
    expect(new DummyProvider().defaultRuntime).toBe("nodejs20");
    expect(new NativeProvider().defaultRuntime).toBe("nodejs22");
    class Newer extends DummyProvider {
      override readonly runtimes = { nodejs24: "24" };
    }
    expect(new Newer().defaultRuntime).toBe("nodejs24");
    class Includes extends DummyProvider {
      override readonly runtimes = { nodejs20: "20", nodejs22: "22", nodejs24: "24" };
    }
    expect(new Includes().defaultRuntime).toBe("nodejs22");
  });

  it("runtimeId maps or rejects", () => {
    const p = new DummyProvider();
    expect(p.runtimeId("nodejs20")).toBe("node20");
    expect(() => p.runtimeId("nodejs22")).toThrow(ProviderError);
    expect(() => p.runtimeId("nodejs22")).toThrow("Dummy Cloud does not support nodejs22; use one of: nodejs18, nodejs20");
    expect(new NativeProvider().runtimeId("nodejs24")).toBe("nodejs24");
  });

  it("esbuildTarget and region", () => {
    const p = new DummyProvider();
    expect(p.esbuildTarget("nodejs22")).toBe("node22");
    expect(p.esbuildTarget("weird")).toBe("node20");
    expect(p.region(cfg())).toBe("moon-1");
    expect(p.region(cfg({ provider: { name: "dummy", region: "mars-2" } }))).toBe("mars-2");
  });
});

describe("workflow engines", () => {
  const wf = (engine: string) => WorkflowConfig.parse({ engine, startAt: "A", states: { A: { type: "succeed" } } });

  it("auto picks native when available", () => {
    expect(new DummyProvider().workflowEngine(wf("auto"))).toBe("embedded");
    expect(new NativeProvider().workflowEngine(wf("auto"))).toBe("native");
    expect(new NativeProvider().workflowEngine(wf("embedded"))).toBe("embedded");
    expect(new NativeProvider().workflowEngine(wf("native"))).toBe("native");
    expect(() => new DummyProvider().workflowEngine(wf("native"))).toThrow(/has no native workflow service/);
  });
});

describe("validate", () => {
  it("reports runtime, events, timeouts and workflows", () => {
    const config = cfg({
      provider: { name: "dummy", runtime: "22" },
      functions: {
        a: { handler: "m.a", runtime: "24", timeout: 120, events: [{ http: "/x" }, { schedule: "5 minutes" }, { queue: "q" }] },
        b: { handler: "m.b" },
      },
      workflows: {
        native: { engine: "native", startAt: "A", states: { A: { type: "task", function: "b" } } },
        emb: { startAt: "A", states: { A: { type: "task", function: "b" } } },
      },
    });
    const issues = new DummyProvider().validate(config).map(String);
    expect(issues).toEqual([
      "ERROR: [provider.runtime] Dummy Cloud does not support nodejs22; use one of: nodejs18, nodejs20",
      "ERROR: [functions.a.runtime] Dummy Cloud does not support nodejs24; use one of: nodejs18, nodejs20",
      "ERROR: [functions.a] Dummy Cloud does not support `schedule` events in nskit (supported: http, queue)",
      "ERROR: [functions.a] timeout 120s exceeds Dummy Cloud max 60s",
      expect.stringMatching(/^ERROR: \[workflows\.native\] Dummy Cloud has no native workflow service/),
      "WARNING: [workflows.emb] runs on the embedded engine inside one function: total runtime is capped by the function timeout (60s max on Dummy Cloud)",
    ]);
  });

  it("is clean for a supported config and includes extraValidation", () => {
    expect(new DummyProvider().validate(cfg({ functions: { a: { handler: "m.a", events: [{ http: "/x" }] } } }))).toEqual([]);
    class Extra extends DummyProvider {
      override extraValidation(): Issue[] {
        return [new Issue("warning", "be careful")];
      }
    }
    expect(new Extra().validate(cfg()).map(String)).toEqual(["WARNING: be careful"]);
  });

  it("provider timeout applies to functions without their own", () => {
    const issues = new DummyProvider().validate(cfg({ provider: { name: "dummy", runtime: "20", timeout: 300 }, functions: { a: { handler: "m.a" } } }));
    expect(issues.map((i) => i.where)).toEqual(["functions.a"]);
  });
});

describe("render", () => {
  it("initDoc sets versions, backend and provider block; extra is merged", () => {
    const config = cfg({
      provider: {
        name: "dummy",
        runtime: "20",
        region: "r1",
        state: { backend: "gcs", config: { bucket: "b" } },
        terraform: { required_version: ">= 1.7", extra: { resource: { x_thing: { t: { a: 1 } } } } },
      },
    });
    const p = new DummyProvider();
    const ctx = new RenderContext({ config, provider: p, root: "/r", workDir: "/r/w", artifact: fakeArtifact(), region: p.region(config) });
    const doc = p.render(ctx).toObject();
    expect(doc.terraform).toEqual({
      required_providers: { dummy: { source: "example/dummy", version: "~> 1.0" } },
      required_version: ">= 1.7",
      backend: { gcs: { bucket: "b" } },
    });
    expect(doc.provider).toEqual({ dummy: [{ region: "r1" }] });
    expect(doc.resource).toEqual({ dummy_function: { f: { region: "r1" } }, x_thing: { t: { a: 1 } } });
    expect(doc.output.nskit.value).toEqual({ functions: {}, workflows: {}, endpoint: null });
  });

  it("providerVersion overrides; terraformLocalName is used; no region -> empty block", () => {
    const config = cfg({ provider: { name: "dummy", terraform: { provider_version: "= 2.0" } } });
    const p = new NativeProvider();
    const ctx = new RenderContext({ config, provider: p, root: "/r", workDir: "/r/w", artifact: fakeArtifact(), region: "" });
    const doc = p.render(ctx).toObject();
    expect(doc.terraform.required_providers).toEqual({ nat: { source: "example/dummy", version: "= 2.0" } });
    expect(doc.provider).toEqual({ nat: [{}] });
  });
});

describe("RenderContext", () => {
  const config = cfg({
    provider: { name: "dummy", runtime: "20", stage: "prod", memory: 512, environment: { SHARED: "1", OVER: "provider" }, tags: { team: "core" }, options: { flag: true, nothing: null } },
    functions: {
      b: { handler: "m.b", environment: { OVER: "fn" }, tags: { team: "fn", extra: "x" }, memory: 128, architecture: "arm64" },
      a: { handler: "src/a.handler" },
    },
  });
  const p = new DummyProvider();
  const ctx = new RenderContext({ config, provider: p, root: "/r", workDir: "/r/w", artifact: fakeArtifact(), region: "moon-1" });

  it("exposes names, stage and options", () => {
    expect(ctx.service).toBe("svc");
    expect(ctx.stage).toBe("prod");
    expect(ctx.prefix).toBe("svc-prod");
    expect(ctx.physicalName("a")).toBe("svc-prod-a");
    expect(ctx.options).toEqual({ flag: true, nothing: null });
    expect(ctx.opt("flag")).toBe(true);
    expect(ctx.opt("nothing", "dflt")).toBe("dflt");
    expect(ctx.opt("missing", 3)).toBe(3);
    expect(ctx.workflowEngines).toEqual({});
  });

  it("tags and environment are layered", () => {
    expect(ctx.tags()).toEqual({ "nskit-service": "svc", "nskit-stage": "prod", "managed-by": "node_serverless_kit", team: "core" });
    expect(ctx.tags(config.functions.b)).toMatchObject({ team: "fn", extra: "x" });
    expect(ctx.environment("b", config.functions.b)).toEqual({
      NSKIT_PROVIDER: "dummy",
      NSKIT_SERVICE: "svc",
      NSKIT_STAGE: "prod",
      NSKIT_REGION: "moon-1",
      NSKIT_FUNCTION: "b",
      NSKIT_HANDLER: "m.b",
      NODE_OPTIONS: "--enable-source-maps",
      SHARED: "1",
      OVER: "fn",
    });
    const noMaps = cfg({ package: { sourcemap: false }, functions: { a: { handler: "m.a" } } });
    const ctx2 = new RenderContext({ config: noMaps, provider: p, root: "/", workDir: "/", artifact: fakeArtifact(), region: "" });
    expect(ctx2.environment("a", noMaps.functions.a)).not.toHaveProperty("NODE_OPTIONS");
  });

  it("functionItems are sorted; per-function settings fall back to the provider", () => {
    expect(ctx.functionItems().map(([n]) => n)).toEqual(["a", "b"]);
    const { a, b } = config.functions;
    expect([ctx.memoryOf(a), ctx.memoryOf(b)]).toEqual([512, 128]);
    expect([ctx.timeoutOf(a), ctx.runtimeOf(a), ctx.architectureOf(a), ctx.architectureOf(b)]).toEqual([30, "nodejs20", "x86_64", "arm64"]);
    expect(ctx.runtimeIdOf(a)).toBe("node20");
  });
});

describe("misc", () => {
  it("Issue formatting", () => {
    expect(String(new Issue("error", "bad", "functions.a"))).toBe("ERROR: [functions.a] bad");
    expect(String(new Issue("warning", "hmm"))).toBe("WARNING: hmm");
  });

  it("describe()", () => {
    expect(new DummyProvider().describe()).toEqual({
      name: "dummy",
      displayName: "Dummy Cloud",
      tier: "beta",
      defaultRegion: "moon-1",
      capabilities: ["http", "queue"],
      runtimes: ["nodejs18", "nodejs20"],
      maxTimeout: 60,
      terraformProvider: "example/dummy",
      bundle: "cjs/node",
      notes: "",
    });
  });

  it("defaults: bundle target, extra files, dependencies", () => {
    const p = new DummyProvider();
    expect(p.bundleTarget(cfg())).toEqual({ format: "cjs", platform: "node", entryFile: "index.js" });
    expect(p.extraFiles(cfg(), {} as never)).toEqual({});
    expect(p.dependencies).toEqual({});
    expect(p.remoteInstall).toBe(false);
  });
});
