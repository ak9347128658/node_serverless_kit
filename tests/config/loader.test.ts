import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRaw, ConfigError, deepMerge, findConfig, interpolate, loadConfig } from "../../src/config/loader.js";
import { dedent, tempDir, writeFiles } from "../helpers.js";

const BASE = `
service: shop
provider:
  name: aws
  region: \${env:NSKIT_TEST_REGION, eu-west-1}
  stage: dev
  environment:
    TABLE: \${self:service}-\${opt:stage}-orders
    COUNT: \${self:custom.count}
custom:
  count: 3
functions:
  api:
    handler: app/handlers.hello
    memory: 128
    events:
      - http: GET /orders/{id}
providers:
  gcp:
    region: europe-west1
    options: {project: my-proj}
  azure:
    region: westeurope
stages:
  prod:
    provider:
      memory: 1024
    functions:
      api:
        memory: 512
`;

let dir: string;

function write(text: string, name = "nskit.yml"): string {
  writeFiles(dir, { [name]: dedent(text) });
  return path.join(dir, name);
}

function load(file?: string, options: Parameters<typeof loadConfig>[1] = {}) {
  return loadConfig(file, { cwd: dir, ...options });
}

beforeEach(() => {
  dir = tempDir();
  vi.stubEnv("NSKIT_TEST_REGION", undefined as unknown as string);
  delete process.env.NSKIT_TEST_REGION;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("defaults and interpolation", () => {
  it("resolves env defaults, self and opt", () => {
    write(BASE);
    const loaded = load();
    const cfg = loaded.config;
    expect(cfg.provider.region).toBe("eu-west-1");
    expect(cfg.provider.environment).toEqual({ TABLE: "shop-dev-orders", COUNT: "3" });
    expect(cfg.functions.api.memory).toBe(128);
    expect(cfg.functions.api.events[0].config).toMatchObject({ path: "/orders/{id}", method: "GET" });
    expect(loaded.path).toBe(path.join(dir, "nskit.yml"));
    expect(loaded.root).toBe(dir);
    expect(loaded.raw).not.toHaveProperty("providers");
    expect(loaded.raw).not.toHaveProperty("stages");
  });

  it("env var wins over the default", () => {
    vi.stubEnv("NSKIT_TEST_REGION", "ap-south-1");
    write(BASE);
    expect(load().config.provider.region).toBe("ap-south-1");
  });

  it("whole-value substitution keeps the type; embedded substitution stringifies", () => {
    write(`
      service: svc
      provider:
        name: aws
        memory: \${self:custom.mem}
        environment:
          INLINE: "n=\${self:custom.mem} list=\${self:custom.list} obj=\${self:custom.obj}"
      custom:
        mem: 512
        list: [1, 2]
        obj: {a: b}
        copy: \${self:custom.obj}
    `);
    const { config, raw } = load();
    expect(config.provider.memory).toBe(512);
    expect(config.provider.environment.INLINE).toBe('n=512 list=[1,2] obj={"a":"b"}');
    expect((raw.custom as Record<string, unknown>).copy).toEqual({ a: "b" });
  });

  it("resolves chained / nested self references over several passes", () => {
    write(`
      service: svc
      provider:
        name: aws
        environment:
          A: \${self:custom.b}
      custom:
        b: \${self:custom.c}-b
        c: \${self:custom.d}-c
        d: \${opt:stage}
        arr: [x, "\${self:custom.d}"]
        deep: \${self:custom.arr.1}
    `);
    const { config, raw } = load(undefined, { stage: "qa" });
    expect(config.provider.environment.A).toBe("qa-c-b");
    expect((raw.custom as Record<string, unknown>).deep).toBe("qa");
  });

  it("supports defaults for env, opt and self (quoted defaults may contain commas)", () => {
    write(`
      service: svc
      provider:
        name: aws
        environment:
          E: \${env:NSKIT_SURELY_UNSET_1, fallback}
          Q: "\${env:NSKIT_SURELY_UNSET_1, 'a,b'}"
          D: '\${env:NSKIT_SURELY_UNSET_1, "x y"}'
          O: \${opt:unknownopt, optdefault}
          S: \${self:custom.missing, selfdefault}
          R: \${opt:region, none}
          EMPTY: \${env:NSKIT_SURELY_UNSET_1, ''}
    `);
    expect(load().config.provider.environment).toEqual({
      E: "fallback",
      Q: "a,b",
      D: "x y",
      O: "optdefault",
      S: "selfdefault",
      R: "none",
      EMPTY: "",
    });
  });

  it("exposes opt:provider, opt:stage and opt:region", () => {
    write(`
      service: svc
      provider:
        name: aws
        region: us-west-2
        environment:
          P: \${opt:provider}
          S: \${opt:stage}
          R: \${opt:region}
    `);
    expect(load().config.provider.environment).toEqual({ P: "aws", S: "dev", R: "us-west-2" });
    expect(load(undefined, { region: "eu-central-1", stage: "prod" }).config.provider.environment).toEqual({
      P: "aws",
      S: "prod",
      R: "eu-central-1",
    });
  });

  it("tolerates whitespace inside variables", () => {
    write(`
      service: svc
      provider:
        name: aws
        environment:
          A: "\${ self:service }"
          B: "\${ env:NSKIT_SURELY_UNSET_1 , dflt }"
    `);
    expect(load().config.provider.environment).toEqual({ A: "svc", B: "dflt" });
  });

  it("keeps ${tf:...}, IAM policy variables and unknown sources verbatim", () => {
    write(`
      service: svc
      provider:
        name: aws
        environment:
          TABLE_ARN: \${tf:aws_dynamodb_table.orders.arn}
          USER: \${aws:username}
          SSM: \${ssm:/path/param}
          MIXED: "arn:\${aws:username}:\${self:service}"
    `);
    expect(load().config.provider.environment).toEqual({
      TABLE_ARN: "${tf:aws_dynamodb_table.orders.arn}",
      USER: "${aws:username}",
      SSM: "${ssm:/path/param}",
      MIXED: "arn:${aws:username}:svc",
    });
  });

  it("reports every unresolved variable, sorted and de-duplicated", () => {
    write(`
      service: svc
      provider:
        name: aws
        region: \${env:NSKIT_SURELY_UNSET_2}
        environment:
          A: \${opt:nope}
          B: x-\${self:custom.nothing}
          C: \${env:NSKIT_SURELY_UNSET_2}
    `);
    expect(() => load()).toThrow(ConfigError);
    expect(() => load()).toThrow("unresolved variables: env:NSKIT_SURELY_UNSET_2, opt:nope, self:custom.nothing");
  });

  it("detects circular self references", () => {
    write(`
      service: svc
      provider: {name: aws}
      custom:
        a: \${self:custom.b}
        b: \${self:custom.a}
    `);
    expect(() => load()).toThrow(/circular variable reference: \$\{self:custom\.a\}, \$\{self:custom\.b\}/);
    write("service: svc\nprovider: {name: aws}\ncustom: {a: '${self:custom.a}'}\n");
    expect(() => load()).toThrow(/circular variable reference/);
    write("service: svc\nprovider: {name: aws}\ncustom: {a: 'x-${self:custom.a}'}\n");
    expect(() => load()).toThrow(/did not converge/);
  });

  it("interpolate() is usable on its own", () => {
    const out = interpolate({ a: "${opt:stage}", b: ["${self:a}"], c: 1, d: null }, { stage: "x" }, dir);
    expect(out).toEqual({ a: "x", b: ["x"], c: 1, d: null });
  });
});

describe("file() variables", () => {
  it("reads json, yaml and text files relative to the config", () => {
    writeFiles(dir, {
      "vals.json": '{"mem": 777, "tags": {"team": "core"}}',
      "conf/extra.yml": "region: ap-east-1\nlist: [a, b]\n",
      "conf/more.yaml": "flag: true\n",
      "secret.txt": "s3cr3t\n\n",
    });
    write(`
      service: svc
      provider:
        name: aws
        region: \${self:custom.extra.region}
        memory: \${self:custom.vals.mem}
        tags: \${file(vals.json)}
        environment:
          SECRET: \${file(secret.txt)}
          QUOTED: \${file("secret.txt")}
          INLINE: "key=\${file(secret.txt)}"
      custom:
        vals: \${file(vals.json)}
        extra: \${file(conf/extra.yml)}
        more: \${file(./conf/more.yaml)}
    `);
    const { config, raw } = load();
    expect(config.provider.memory).toBe(777);
    expect(config.provider.region).toBe("ap-east-1");
    expect(config.provider.environment).toEqual({ SECRET: "s3cr3t", QUOTED: "s3cr3t", INLINE: "key=s3cr3t" });
    expect((raw.custom as Record<string, unknown>).more).toEqual({ flag: true });
    expect(config.provider.tags).toEqual({ mem: "777", tags: '{"team":"core"}' });
  });

  it("errors on a missing file", () => {
    write(`
      service: svc
      provider: {name: aws}
      custom: {x: "\${file(nope.json)}"}
    `);
    expect(() => load()).toThrow(/\$\{file\(nope\.json\)\}: .*nope\.json does not exist/);
  });

  it("resolves file paths relative to the root config even for extended files", () => {
    writeFiles(dir, { "shared/base.yml": "service: svc\nprovider: {name: aws}\ncustom: {v: '${file(value.txt)}'}\n", "value.txt": "root" });
    writeFiles(dir, { "shared/value.txt": "shared" });
    const file = write("extends: shared/base.yml\n");
    // Interpolation happens after merging, relative to the loaded (child) config.
    expect((loadConfig(file).raw.custom as Record<string, unknown>).v).toBe("root");
  });
});

describe("extends", () => {
  it("merges parent files (child wins) and applies the parent's providers block", () => {
    write(BASE, "base.yml");
    write("extends: base.yml\nprovider:\n  name: azure\n", "nskit.azure.yml");
    const cfg = load("nskit.azure.yml").config;
    expect(cfg.provider.name).toBe("azure");
    expect(cfg.provider.region).toBe("westeurope");
    expect(cfg.functions.api.handler).toBe("app/handlers.hello");
  });

  it("supports chains and lists, parents first", () => {
    write("service: aaa\nprovider: {name: aws, memory: 128, timeout: 5}\ncustom: {a: 1, list: [1]}\n", "a.yml");
    write("extends: a.yml\nprovider: {memory: 256}\ncustom: {b: 2, list: [2]}\n", "b.yml");
    write("service: ccc\ncustom: {c: 3}\n", "c.yml");
    write("extends: [b.yml, c.yml]\nprovider: {timeout: 9}\n", "nskit.yml");
    const { config } = load();
    expect(config.service).toBe("ccc");
    expect(config.provider).toMatchObject({ memory: 256, timeout: 9 });
    expect(config.custom).toEqual({ a: 1, b: 2, c: 3, list: [2] });
  });

  it("resolves extends relative to the extending file", () => {
    writeFiles(dir, { "configs/root.yml": "service: deep\nprovider: aws\n", "configs/mid.yml": "extends: root.yml\n" });
    write("extends: configs/mid.yml\n");
    expect(load().config.service).toBe("deep");
  });

  it("detects cycles", () => {
    write("extends: b.yml\n", "a.yml");
    write("extends: a.yml\n", "b.yml");
    expect(() => load("a.yml")).toThrow(/circular `extends`: .*a\.yml -> .*b\.yml -> .*a\.yml/);
    write("extends: self.yml\n", "self.yml");
    expect(() => load("self.yml")).toThrow(/circular/);
  });

  it("the child's explicit value beats the parent's provider override", () => {
    write(BASE, "base.yml");
    write("extends: base.yml\nprovider:\n  name: gcp\n  region: asia-south1\n", "nskit.gcp.yml");
    const cfg = load("nskit.gcp.yml").config;
    expect(cfg.provider.region).toBe("asia-south1");
    expect(cfg.provider.options).toEqual({ project: "my-proj" });
  });

  it("child providers / stages blocks override the parent's", () => {
    write(BASE, "base.yml");
    write(
      dedent(`
        extends: base.yml
        providers:
          gcp: {region: us-central1}
        stages:
          prod:
            provider: {memory: 2048}
      `),
      "child.yml",
    );
    const cfg = load("child.yml", { provider: "gcp", stage: "prod" }).config;
    expect(cfg.provider.region).toBe("us-central1");
    expect(cfg.provider.options).toEqual({ project: "my-proj" });
    expect(cfg.provider.memory).toBe(2048);
    expect(cfg.functions.api.memory).toBe(512);
  });
});

describe("providers: / stages: / CLI overrides", () => {
  it("--provider switches cloud and applies its overrides", () => {
    write(BASE);
    const cfg = load(undefined, { provider: "gcp" }).config;
    expect(cfg.provider.name).toBe("gcp");
    expect(cfg.provider.region).toBe("europe-west1");
    expect(cfg.provider.options).toEqual({ project: "my-proj" });
    expect(cfg.functions.api.handler).toBe("app/handlers.hello");
  });

  it("providers blocks may override top-level keys besides provider fields", () => {
    write(`
      service: svc
      provider: {name: aws}
      functions:
        a: {handler: m.a, memory: 128}
      providers:
        aws:
          log_retention_days: 30
          functions:
            a: {memory: 1024}
          provider: {timeout: 60}
    `);
    const cfg = load().config;
    expect(cfg.functions.a.memory).toBe(1024);
    expect(cfg.provider.logRetentionDays).toBe(30);
    expect(cfg.provider.timeout).toBe(60);
  });

  it("stage overrides apply after provider overrides", () => {
    write(BASE);
    const cfg = load(undefined, { stage: "prod" }).config;
    expect(cfg.provider.stage).toBe("prod");
    expect(cfg.provider.memory).toBe(1024);
    expect(cfg.functions.api.memory).toBe(512);
    expect(cfg.provider.environment.TABLE).toBe("shop-prod-orders");
  });

  it("selects the stage block from provider.stage when no CLI stage is given", () => {
    write(BASE.replace("stage: dev", "stage: prod"));
    expect(load().config.provider.memory).toBe(1024);
  });

  it("stage blocks beat provider blocks", () => {
    write(`
      service: svc
      provider: {name: aws}
      providers:
        aws: {memory: 300}
      stages:
        dev:
          provider: {memory: 400}
    `);
    expect(load().config.provider.memory).toBe(400);
  });

  it("--region wins over everything", () => {
    write(BASE);
    expect(load(undefined, { region: "us-west-2" }).config.provider.region).toBe("us-west-2");
    expect(load(undefined, { region: "us-west-2", provider: "gcp" }).config.provider.region).toBe("us-west-2");
  });

  it("--stage wins over provider.stage", () => {
    write(BASE);
    expect(load(undefined, { stage: "qa" }).config.provider.stage).toBe("qa");
  });

  it("rejects unknown providers and unknown providers: keys", () => {
    write("service: svc\nprovider: {name: nope}\n");
    expect(() => load()).toThrow(/unknown provider 'nope'; supported: alibaba, aws/);
    write("service: svc\nprovider: {name: aws}\nproviders: {mycloud: {region: x}}\n");
    expect(() => load()).toThrow(/`providers:` has unknown keys mycloud/);
  });

  it("accepts plug-in providers passed as knownProviders", () => {
    write("service: svc\nprovider: {name: mycloud}\nproviders: {mycloud: {region: x1}}\n");
    const cfg = load(undefined, { knownProviders: ["mycloud"] }).config;
    expect(cfg.provider.name).toBe("mycloud");
    expect(cfg.provider.region).toBe("x1");
  });

  it("requires a provider name", () => {
    write("service: svc\nprovider: {region: x}\n");
    expect(() => load()).toThrow(/provider.name is required/);
    expect(load(undefined, { provider: "aws" }).config.provider.name).toBe("aws");
  });

  it("accepts the provider shorthand string", () => {
    write("service: svc\nprovider: aws\n");
    expect(load().config.provider.name).toBe("aws");
  });

  it("buildRaw returns the merged, interpolated document", () => {
    const file = write(BASE);
    const raw = buildRaw(file, { stage: "prod" });
    expect(raw.provider).toMatchObject({ name: "aws", stage: "prod", memory: 1024, region: "eu-west-1" });
  });
});

describe("errors", () => {
  it.each([
    ["service: x\nprovider: {name: aws}\n", /service: service must be/],
    ["service: svc\nprovider: {name: aws, runtime: python2.7}\n", /provider\.runtime: runtime must be one of/],
    ["service: svc\nprovider: {name: aws}\nfunctions: {f: {handler: nodots}}\n", /functions\.f\.handler/],
    ["service: svc\nprovider: {name: aws}\nfunctions: {f: {handler: a.b, events: [{http: {}, queue: x}]}}\n", /single-key/],
    ["service: svc\nprovider: {name: aws}\nfunctions: {f: {handler: a.b, events: [{bogus: {}}]}}\n", /unknown event type/],
    ["service: svc\nprovider: {name: aws}\nfunctions: {f: {handler: a.b, events: [{schedule: {rate: often}}]}}\n", /rate must/],
    ["service: svc\nprovider: {name: aws}\nfunctions: {f: {handler: a.b, unknown_key: 1}}\n", /unknown_key/],
    ["- just\n- a list\n", /must contain a mapping/],
    ["service: svc\nprovider: {name: aws}\nhooks: {whenever: [ls]}\n", /unknown hooks/],
    ["service: svc\nprovider: [unclosed\n", /invalid YAML/],
  ])("%j", (text, pattern) => {
    write(text);
    expect(() => load()).toThrow(ConfigError);
    expect(() => load()).toThrow(pattern);
  });

  it("names the file in validation errors", () => {
    write("service: x\nprovider: {name: aws}\n", "custom.yml");
    expect(() => load("custom.yml")).toThrow(/^custom\.yml is invalid:/);
  });

  it("rejects duplicate routes", () => {
    write(`
      service: svc
      provider: {name: aws}
      functions:
        a: {handler: m.a, events: [{http: GET /x}]}
        b: {handler: m.b, events: [{http: GET /x/}]}
    `);
    expect(() => load()).toThrow(/used by both 'a' and 'b'/);
  });

  it("handles an empty file", () => {
    write("");
    expect(() => load()).toThrow(/provider.name is required/);
  });
});

describe("findConfig", () => {
  it("finds default names in order", () => {
    writeFiles(dir, { "serverless-kit.yml": "x: 1\n" });
    expect(findConfig(undefined, dir)).toBe(path.join(dir, "serverless-kit.yml"));
    writeFiles(dir, { "nskit.yaml": "x: 1\n" });
    expect(findConfig(undefined, dir)).toBe(path.join(dir, "nskit.yaml"));
    writeFiles(dir, { "nskit.yml": "x: 1\n" });
    expect(findConfig(undefined, dir)).toBe(path.join(dir, "nskit.yml"));
  });

  it("errors when nothing is found or the file is missing", () => {
    expect(() => findConfig(undefined, dir)).toThrow(/no config found/);
    expect(() => findConfig("missing.yml", dir)).toThrow(/config file not found/);
    expect(() => findConfig(".", dir)).toThrow(/config file not found/);
  });
});

describe("deepMerge", () => {
  it("merges objects recursively and replaces arrays / scalars", () => {
    expect(deepMerge({ a: { b: 1, c: [1] } }, { a: { c: [2], d: 3 } })).toEqual({ a: { b: 1, c: [2], d: 3 } });
    expect(deepMerge({ a: 1 }, { a: { b: 2 } })).toEqual({ a: { b: 2 } });
    expect(deepMerge({ a: { b: 2 } }, { a: null })).toEqual({ a: null });
    expect(deepMerge(1, 2)).toBe(2);
  });

  it("does not share references with its inputs", () => {
    const override = { list: [{ x: 1 }], nested: { y: 1 } };
    const merged = deepMerge({}, override) as typeof override;
    merged.list[0].x = 99;
    merged.nested.y = 99;
    expect(override).toEqual({ list: [{ x: 1 }], nested: { y: 1 } });
  });
});
