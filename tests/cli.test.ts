import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, parseData, type CliIO } from "../src/cli/main";
import { DEFAULT_REGIONS, LANGUAGES, render, TEMPLATES } from "../src/cli/templates";
import { Project } from "../src/core/project";
import { LocalRunner } from "../src/local/runner";
import { TerraformRunner } from "../src/terraform/runner";

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "nskit-cli-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[], extra: Partial<CliIO> = {}): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  let code = -1;
  await main(args, {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    color: false,
    isTTY: false,
    exit: (c) => {
      code = c;
    },
    confirm: async () => false,
    openUrl: () => undefined,
    waitForShutdown: async () => undefined,
    ...extra,
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

class FakeRunner extends TerraformRunner {
  calls: string[] = [];
  override init(): void {
    this.calls.push("init");
  }
  override apply(): void {
    this.calls.push("apply");
  }
  override plan(): boolean {
    this.calls.push("plan");
    return true;
  }
  override destroy(): void {
    this.calls.push("destroy");
  }
  override output(): Record<string, unknown> {
    this.calls.push("output");
    return {
      nskit: {
        endpoint: "https://api.example.com",
        functions: { hello: { id: "svc-dev-hello", arn: "arn:aws:lambda:us-east-1:1:function:svc-dev-hello", base_url: "https://api.example.com" } },
        workflows: { "order-pipeline": { id: "arn:aws:states:us-east-1:1:stateMachine:svc" } },
      },
    };
  }
  override passthrough(args: string[]): number {
    this.calls.push(`tf ${args.join(" ")}`);
    return args.includes("fail") ? 3 : 0;
  }
}

// ------------------------------------------------------------------ init x template x lang

describe("init", () => {
  for (const template of TEMPLATES) {
    for (const lang of LANGUAGES) {
      it(`scaffolds ${template}/${lang} that validates and runs locally`, async () => {
        const dir = path.join(tmpRoot, `init-${template}-${lang}`);
        const res = await cli(["init", dir, "-t", template, "--lang", lang, "--name", "svc"]);
        expect(res.code, res.stderr).toBe(0);
        for (const rel of ["nskit.yml", `src/handlers.${lang}`, `tests/handlers.test.${lang}`, "package.json", ".gitignore", "README.md"]) {
          expect(existsSync(path.join(dir, rel)), rel).toBe(true);
        }
        expect(existsSync(path.join(dir, "tsconfig.json"))).toBe(lang === "ts");
        const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8"));
        expect(pkg.type).toBe("module");
        expect(pkg.devDependencies["node-serverless-kit"]).toBeTruthy();
        expect(Object.keys(pkg.scripts)).toEqual(expect.arrayContaining(["dev", "deploy", "test"]));
        expect(readFileSync(path.join(dir, `src/handlers.${lang}`), "utf-8")).toContain('from "node-serverless-kit"');
        expect(readFileSync(path.join(dir, `tests/handlers.test.${lang}`), "utf-8")).toContain('from "node-serverless-kit/testing"');

        const val = await cli(["validate", "-c", path.join(dir, "nskit.yml")]);
        expect(val.code, val.stdout + val.stderr).toBe(0);
        expect(val.stdout).toContain("Configuration is valid.");

        const runner = await LocalRunner.fromConfig(path.join(dir, "nskit.yml"), { mode: "bundle" });
        const hello = await runner.http("GET", "/hello?name=Ada");
        expect(hello.status).toBe(200);
        expect(hello.json()).toMatchObject({ message: "Hello, Ada!", provider: "local" });
        expect((await runner.http("GET", "/items/1")).json()).toMatchObject({ id: "1" });
        expect((await runner.http("GET", "/items/999")).status).toBe(404);
        expect((await runner.http("POST", "/items", { json: { name: "lamp" } })).status).toBe(201);
        if (template === "events" || template === "full") {
          const batch = (await runner.queue("process-jobs", [{ job: 1 }, "not json"])) as { failed: string[] };
          expect(batch.failed).toEqual(["2"]);
          expect(await runner.schedule("nightly-report", { report: "daily" })).toMatchObject({ ok: true });
          await runner.storage("on-upload", [{ key: "in/a.csv" }]);
        }
        if (template === "workflow" || template === "full") {
          const run = await runner.workflow("order-pipeline", { amount: 10 });
          expect(run.output).toMatchObject({ valid: true, charged: true });
          await expect(runner.workflow("order-pipeline", { amount: 0 })).rejects.toMatchObject({ error: "OrderRejected" });
        }
      });
    }
  }

  it("validates the scaffold on other providers", async () => {
    for (const provider of ["gcp", "azure", "cloudflare"]) {
      const files = render({ template: "http", service: "svc", provider, lang: "ts" });
      expect(files["nskit.yml"]).toContain(`name: ${provider}`);
      expect(files["nskit.yml"]).toContain(`region: ${DEFAULT_REGIONS[provider]}`);
      // Every other cloud is listed (commented) under providers:
      expect(files["nskit.yml"]).toContain("# providers:");
      expect(files["nskit.yml"]).toContain(`#   aws:\n#     region: us-east-1`);
    }
    const yml = render({ template: "http", service: "svc", provider: "aws", lang: "ts" })["nskit.yml"];
    expect(yml).toContain("#   gcp:\n#     region: us-central1\n#     options:\n#       project:");
  });

  it("scaffolds a valid project for every provider (unsupported triggers commented out)", async () => {
    for (const provider of Object.keys(DEFAULT_REGIONS)) {
      for (const template of ["http", "full"]) {
        const dir = path.join(tmpRoot, `prov-${provider}-${template}`);
        expect((await cli(["init", dir, "-p", provider, "-t", template, "--name", "app"])).code).toBe(0);
        const res = await cli(["validate", "-c", path.join(dir, "nskit.yml")]);
        expect(res.code, `${provider}/${template}: ${res.stdout}\n${res.stderr}`).toBe(0);
      }
    }
    const ibm = readFileSync(path.join(tmpRoot, "prov-ibm-full", "nskit.yml"), "utf-8");
    expect(ibm).toContain("# queue events are not supported on ibm");
  });

  it("skips existing files unless --force and rejects bad names", async () => {
    const dir = path.join(tmpRoot, "init-skip");
    expect((await cli(["init", dir, "--name", "svc"])).code).toBe(0);
    writeFileSync(path.join(dir, "README.md"), "mine");
    const again = await cli(["init", dir, "--name", "svc"]);
    expect(again.stdout).toContain("skip   README.md");
    expect(readFileSync(path.join(dir, "README.md"), "utf-8")).toBe("mine");
    await cli(["init", dir, "--name", "svc", "--force"]);
    expect(readFileSync(path.join(dir, "README.md"), "utf-8")).toContain("# svc");
    const bad = await cli(["init", path.join(tmpRoot, "bad"), "--name", "Bad_Name"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Error: invalid service name");
    const badTemplate = await cli(["init", path.join(tmpRoot, "bad2"), "-t", "nope"]);
    expect(badTemplate.code).toBe(1);
    expect(badTemplate.stderr).toContain("Allowed choices are http, events, workflow, full");
  });

  it("derives the service name from the directory", async () => {
    const dir = path.join(tmpRoot, "My Orders_API");
    expect((await cli(["init", dir])).code).toBe(0);
    expect(readFileSync(path.join(dir, "nskit.yml"), "utf-8")).toContain("service: my-orders-api");
  });
});

// ------------------------------------------------------------------ commands on a full project

describe("project commands", () => {
  const dir = path.join(tmpRoot, "svc");
  const cfg = path.join(dir, "nskit.yml");
  let fake: FakeRunner | undefined;
  const withFake: Partial<CliIO> = {
    terraformRunner: (project, echo) => (fake = new FakeRunner(project.workDir, { echo })),
  };

  beforeAll(async () => {
    const res = await cli(["init", dir, "-t", "full", "--name", "svc"]);
    expect(res.code).toBe(0);
  });

  it("validate prints a summary table", async () => {
    const res = await cli(["validate", "-c", cfg]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("svc -> AWS Lambda");
    expect(res.stdout).toMatch(/hello\s+http\s+GET \/hello/);
    expect(res.stdout).toMatch(/process-jobs\s+event-driven\s+queue svc-jobs/);
    expect(res.stdout).toContain("workflow order-pipeline: native engine");
  });

  it("validate exits 1 on provider errors and config errors", async () => {
    const bad = path.join(tmpRoot, "bad-handler");
    mkdirSync(bad, { recursive: true });
    writeFileSync(path.join(bad, "nskit.yml"), "service: bad\nprovider: aws\nfunctions:\n  x:\n    handler: src/missing.run\n");
    const res = await cli(["validate", "-c", path.join(bad, "nskit.yml")]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("handler module 'src/missing' not found");
    const missing = await cli(["validate", "-c", path.join(tmpRoot, "nope.yml")]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/^Error: config file not found/);
    writeFileSync(path.join(bad, "broken.yml"), "service: Bad\nprovider: aws\n");
    const invalid = await cli(["validate", "-c", path.join(bad, "broken.yml")]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("service must be 2-32 chars");
  });

  it("providers lists the capability matrix", async () => {
    const res = await cli(["providers", "--json"]);
    expect(res.code).toBe(0);
    const names = (JSON.parse(res.stdout) as { name: string }[]).map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["aws", "gcp", "azure", "cloudflare"]));
    const table = await cli(["providers"]);
    expect(table.stdout).toMatch(/provider\s+tier\s+region\s+http/);
    expect(table.stdout).toMatch(/aws\s+\w+\s+us-east-1\s+yes/);
  });

  it("print shows the resolved config", async () => {
    const res = await cli(["print", "-c", cfg, "--json", "-s", "prod"]);
    const config = JSON.parse(res.stdout);
    expect(config.provider).toMatchObject({ name: "aws", stage: "prod", runtime: "nodejs22", region: "us-east-1" });
    expect(Object.keys(config.functions)).toContain("hello");
    const yaml = await cli(["print", "-c", cfg]);
    expect(yaml.stdout).toContain("service: svc");
  });

  it("invoke runs http and other events", async () => {
    let res = await cli(["invoke", "-c", cfg, "-f", "hello", "--path", "/hello?name=Ada", "-H", "X-Test: 1"]);
    expect(res.code, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.status).toBe(200);
    expect(out.headers["content-type"]).toContain("application/json");
    expect(out.body).toMatchObject({ message: "Hello, Ada!" });

    res = await cli(["invoke", "-c", cfg, "-f", "get-item", "--path", "/items/404"]);
    expect(JSON.parse(res.stdout).status).toBe(404);

    res = await cli(["invoke", "-c", cfg, "-f", "create-item", "-d", '{"name":"lamp"}']);
    expect(JSON.parse(res.stdout)).toMatchObject({ status: 201, body: { name: "lamp" } });

    res = await cli(["invoke", "-c", cfg, "-f", "process-jobs", "-e", "queue", "-d", '[{"a":1},"not json"]']);
    expect(JSON.parse(res.stdout)).toEqual({ batchItemFailures: [{ itemIdentifier: "2" }] });

    res = await cli(["invoke", "-c", cfg, "-f", "nightly-report", "-e", "schedule"]);
    expect(JSON.parse(res.stdout)).toEqual({ ok: true, input: { report: "daily" } });

    res = await cli(["invoke", "-c", cfg, "-f", "validate-order", "-d", '{"amount":3}']);
    expect(JSON.parse(res.stdout)).toEqual({ amount: 3, valid: true });

    const dataFile = path.join(tmpRoot, "order.json");
    writeFileSync(dataFile, '{"amount": 7}');
    res = await cli(["invoke", "-c", cfg, "-f", "charge-order", "-d", `@${dataFile}`]);
    expect(JSON.parse(res.stdout)).toEqual({ amount: 7, charged: true });
  });

  it("invoke reports errors", async () => {
    const unknown = await cli(["invoke", "-c", cfg, "-f", "nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("unknown function 'nope'");
    const raised = await cli(["invoke", "-c", cfg, "-f", "validate-order", "-d", '{"amount":0}']);
    expect(raised.code).toBe(1);
    expect(raised.stderr).toContain("validate-order raised OrderInvalid: amount must be positive");
    const header = await cli(["invoke", "-c", cfg, "-f", "hello", "-H", "broken"]);
    expect(header.code).toBe(1);
    expect(header.stderr).toContain("expected --header 'Name: value'");
    const noFn = await cli(["invoke", "-c", cfg]);
    expect(noFn.code).toBe(1);
    expect(noFn.stderr).toContain("required option '-f, --function <name>' not specified");
  });

  it("workflow run and show", async () => {
    let res = await cli(["workflow", "run", "order-pipeline", "-c", cfg, "-i", '{"amount":10}', "--history"]);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain("SUCCEEDED");
    expect(res.stdout).toContain('"charged": true');
    expect(res.stdout).toContain('"state": "Validate"');

    res = await cli(["workflow", "run", "order-pipeline", "-c", cfg, "-i", '{"amount":0}']);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("FAILED OrderRejected");

    res = await cli(["workflow", "run", "nope", "-c", cfg]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("unknown workflow 'nope'");

    res = await cli(["workflow", "show", "order-pipeline", "-c", cfg]);
    expect(JSON.parse(res.stdout)).toMatchObject({ StartAt: "Validate" });
    res = await cli(["workflow", "show", "order-pipeline", "-c", cfg, "--format", "json"]);
    expect(JSON.parse(res.stdout)).toMatchObject({ startAt: "Validate" });
    res = await cli(["workflow", "show", "order-pipeline", "-c", cfg, "--format", "gcp"]);
    expect(res.code).toBe(0);
    const gcp = JSON.parse(res.stdout);
    if (existsSync(path.resolve("src/workflows/gcp.ts"))) expect(gcp).toHaveProperty("main");
  });

  it("package, info and dashboard before deploying", async () => {
    const pkg = await cli(["package", "-c", cfg, "--skip-install"]);
    expect(pkg.code, pkg.stderr).toBe(0);
    expect(existsSync(path.join(dir, ".nskit", "aws-dev", "main.tf.json"))).toBe(true);
    const info = await cli(["info", "-c", cfg, "--json"]);
    const record = JSON.parse(info.stdout);
    expect(record.status).toBe("not deployed");
    expect(record.functions).toHaveLength(8);
    const human = await cli(["info", "-c", cfg]);
    expect(human.stdout).toContain("svc | dev | AWS Lambda | us-east-1 | not deployed");
    const dash = await cli(["dashboard", dir]);
    expect(dash.code).toBe(0);
    expect(dash.stdout).toContain("No deployments yet");
    const html = readFileSync(path.join(dir, ".nskit", "dashboard", "index.html"), "utf-8");
    expect(html).toContain("order-pipeline");
    const custom = path.join(tmpRoot, "site", "dash.html");
    expect((await cli(["dashboard", dir, "-o", custom])).code).toBe(0);
    expect(existsSync(custom)).toBe(true);
  });

  it("stage / provider / region flags reach the generated terraform", async () => {
    const res = await cli(["package", "-c", cfg, "--skip-install", "-s", "prod", "-r", "eu-central-1"]);
    expect(res.code, res.stderr).toBe(0);
    const tf = JSON.parse(readFileSync(path.join(dir, ".nskit", "aws-prod", "main.tf.json"), "utf-8"));
    expect(JSON.stringify(tf.provider)).toContain("eu-central-1");
    expect(JSON.stringify(tf.resource.aws_lambda_function)).toContain("svc-prod-hello");
  });

  it("deploy, info, tf and remove with a fake terraform", async () => {
    const dep = await cli(["deploy", "-c", cfg, "--skip-install"], withFake);
    expect(dep.code, dep.stderr).toBe(0);
    expect(fake!.calls).toEqual(["init", "apply", "output"]);
    expect(dep.stdout).toContain("Deployed svc (dev) to AWS Lambda us-east-1");
    expect(dep.stdout).toContain("GET    https://api.example.com/hello");
    expect(dep.stdout).toContain("Dashboard: file://");
    const saved = JSON.parse(readFileSync(path.join(dir, ".nskit", "aws-dev", "deployment.json"), "utf-8"));
    expect(saved.status).toBe("deployed");
    expect(saved.workflows[0].id).toContain("stateMachine");
    const html = readFileSync(path.join(dir, ".nskit", "dashboard", "index.html"), "utf-8");
    expect(html).toContain("https://api.example.com/hello");

    const info = await cli(["info", "-c", cfg]);
    expect(info.stdout).toContain("endpoint: https://api.example.com");
    expect(info.stdout).toContain("arn:aws:lambda:us-east-1:1:function:svc-dev-hello");

    const tf = await cli(["tf", "-c", cfg, "--", "state", "list"], withFake);
    expect(tf.code).toBe(0);
    expect(fake!.calls).toEqual(["tf state list"]);
    const tfFail = await cli(["tf", "-c", cfg, "fail", "-x"], withFake);
    expect(tfFail.code).toBe(3);

    const refused = await cli(["remove", "-c", cfg], withFake);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("pass -y");
    const aborted = await cli(["remove", "-c", cfg], { ...withFake, isTTY: true, confirm: async () => false });
    expect(aborted.code).toBe(1);
    expect(aborted.stderr).toContain("Aborted");

    let asked = "";
    const removed = await cli(["remove", "-c", cfg], {
      ...withFake,
      isTTY: true,
      confirm: async (q) => {
        asked = q;
        return true;
      },
    });
    expect(removed.code, removed.stderr).toBe(0);
    expect(asked).toContain("Destroy ALL resources of 'svc' stage 'dev'");
    expect(fake!.calls).toEqual(["init", "destroy"]);
    expect(JSON.parse(readFileSync(path.join(dir, ".nskit", "aws-dev", "deployment.json"), "utf-8")).status).toBe("removed");
    expect((await cli(["remove", "-c", cfg, "-y"], withFake)).code).toBe(0);
  });

  it("plan uses the runner", async () => {
    const res = await cli(["plan", "-c", cfg, "--skip-install"], withFake);
    expect(res.code, res.stderr).toBe(0);
    expect(fake!.calls).toEqual(["init", "plan"]);
    expect(res.stdout).toContain("Plan has changes.");
  });

  it("reports a missing terraform binary as a clean error", async () => {
    const saved = { PATH: process.env.PATH, BIN: process.env.NSKIT_TERRAFORM_BIN };
    const empty = path.join(tmpRoot, "empty-bin");
    mkdirSync(empty, { recursive: true });
    process.env.PATH = empty;
    delete process.env.NSKIT_TERRAFORM_BIN;
    try {
      const res = await cli(["deploy", "-c", cfg, "--skip-install", "--no-dashboard"]);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain("Error: Neither `terraform` nor `tofu` was found on PATH");
      const tf = await cli(["tf", "-c", cfg, "--", "version"]);
      expect(tf.code).toBe(1);
      expect(tf.stderr).toContain("Neither `terraform` nor `tofu`");
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.BIN !== undefined) process.env.NSKIT_TERRAFORM_BIN = saved.BIN;
    }
  });

  it("tf refuses before anything is generated", async () => {
    const other = path.join(tmpRoot, "fresh");
    await cli(["init", other, "--name", "fresh"]);
    const res = await cli(["tf", "-c", path.join(other, "nskit.yml"), "--", "state", "list"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("run `nskit package` first");
  });

  it("loads the project the CLI uses", () => {
    expect(Project.load(cfg).config.service).toBe("svc");
  });
});

// ------------------------------------------------------------------ program level

describe("program", () => {
  it("prints the version and help with examples", async () => {
    const version = await cli(["--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(/^\d+\.\d+\.\d+/);
    const help = await cli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Examples:");
    for (const cmd of ["init", "validate", "package", "plan", "deploy", "remove", "info", "dashboard", "dev", "invoke", "workflow", "providers", "print", "tf"]) {
      expect(help.stdout).toContain(cmd);
    }
    const sub = await cli(["invoke", "--help"]);
    expect(sub.stdout).toContain("-H, --header <header>");
    expect(sub.stdout).toContain("--env-file <file>");
  });

  it("strips node + script from process.argv", async () => {
    const res = await cli([process.execPath, "/usr/lib/nskit.js", "--version"]);
    expect(res.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("fails on unknown commands", async () => {
    const res = await cli(["frobnicate"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("unknown command 'frobnicate'");
  });

  it("parses --data values", () => {
    expect(parseData('{"a":1}')).toEqual({ a: 1 });
    expect(parseData("plain text")).toBe("plain text");
    expect(parseData(undefined)).toBeUndefined();
    expect(() => parseData("@/definitely/missing.json")).toThrow("data file not found");
  });
});
