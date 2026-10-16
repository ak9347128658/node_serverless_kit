import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { afterAll, describe, expect, test } from "vitest";
import { Deployer } from "../../src/core/deployer";
import { Project } from "../../src/core/project";
import { DigitalOceanProvider } from "../../src/providers/digitalocean";

const HANDLERS = `export async function hello() { return { ok: true }; }
export async function tick(event: { type: string }) { return event.type; }
`;

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function makeProject(yaml: string): Project {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nskit-do-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "handlers.ts"), HANDLERS);
  writeFileSync(path.join(dir, "nskit.yml"), yaml);
  return Project.load(path.join(dir, "nskit.yml"));
}

const errors = (p: Project) => p.validate().filter((i) => i.level === "error").map(String);

async function render(p: Project) {
  const res = await new Deployer(p, () => undefined).package({ skipInstall: true });
  return JSON.parse(readFileSync(res.tfFile, "utf-8"));
}

const CONFIG = `
service: demo
provider:
  name: digitalocean
  options: {namespace: fn-1234, api_host: "https://faas-nyc1-abc.doserverless.co/"}
functions:
  hello:
    handler: src/handlers.hello
    events:
      - http: "GET /hello/{name}"
  tick:
    handler: src/handlers.tick
    events:
      - schedule: 5 minutes
      - schedule: {cron: "0 12 * * 1", input: {r: 1}}
      - schedule: {cron: "0 1 * * *", enabled: false}
`;

describe("digitalocean provider", () => {
  test("metadata", () => {
    const p = new DigitalOceanProvider();
    expect(p.tier).toBe("beta");
    expect(p.defaultRuntime).toBe("nodejs22");
    expect(p.runtimeId("nodejs18")).toBe("nodejs:18");
    expect(p.runtimeId("nodejs24")).toBe("nodejs:24");
  });

  test("required namespace and unsupported events", () => {
    const p = makeProject(`
service: demo
provider: {name: digitalocean}
functions:
  w:
    handler: src/handlers.tick
    events: [{schedule: 5 minutes}, {queue: jobs}, {storage: b}, {topic: events}]
`);
    const joined = errors(p).join("\n");
    expect(joined).toContain("options.namespace is required");
    expect(joined).not.toContain("runtime");
    for (const kind of ["queue", "storage", "topic"]) expect(joined).toContain(`\`${kind}\` events`);
    expect(joined).not.toContain("`schedule` events");
  });

  test("render", async () => {
    const project = makeProject(CONFIG);
    expect(errors(project)).toEqual([]);
    const tf = await render(project);
    expect(tf.provider).toBeUndefined();
    expect(tf.terraform.required_providers).toEqual({});
    const deploy = tf.resource.terraform_data.deploy;
    expect(deploy.triggers_replace).toHaveLength(2);
    expect(deploy.input).toEqual({ namespace: "fn-1234", package: "demo-dev" });
    const [create, destroy] = deploy.provisioner;
    expect(create["local-exec"].command).toBe("doctl serverless connect fn-1234 && doctl serverless deploy do_project");
    expect(destroy["local-exec"].when).toBe("destroy");
    expect(destroy["local-exec"].command).toContain("doctl serverless undeploy --packages ${self.input.package}");

    const root = path.join(project.workDir, "do_project");
    const spec = parseYaml(readFileSync(path.join(root, "project.yml"), "utf-8"));
    const pkg = spec.packages[0];
    expect(pkg.name).toBe("demo-dev");
    const fns = Object.fromEntries(pkg.functions.map((f: { name: string }) => [f.name, f]));
    expect(fns.hello).toMatchObject({ web: "raw", runtime: "nodejs:22", main: "main", limits: { timeout: 30000, memory: 256 } });
    expect(fns.hello.environment.NSKIT_FUNCTION).toBe("hello");
    expect(fns.tick.web).toBe(false);
    const triggers = fns.tick.triggers;
    expect(triggers.map((t: { sourceDetails: { cron: string } }) => t.sourceDetails.cron)).toEqual(["*/5 * * * *", "0 12 * * 1"]);
    expect(triggers[1]).toMatchObject({ name: "tick-1", sourceType: "scheduler" });
    expect(triggers[1].sourceDetails.withBody).toEqual({ __nskit: "schedule", data: { r: 1 }, source: "digitalocean.scheduler" });
    for (const f of ["index.js", "nskit_manifest.json", "package.json"]) {
      expect(existsSync(path.join(root, "packages/demo-dev/hello", f))).toBe(true);
    }
    const fnPkg = JSON.parse(readFileSync(path.join(root, "packages/demo-dev/hello/package.json"), "utf-8"));
    expect(fnPkg.main).toBe("index.js");

    // Round trip: DigitalOcean calls `main(event, context)` from the function directory's package.json main.
    const bundle = createRequire(import.meta.url)(path.join(root, "packages/demo-dev/hello", fnPkg.main));
    process.env.NSKIT_FUNCTION = "hello";
    const resp = await bundle.main(
      { http: { method: "GET", path: "/hello/Ada", headers: {}, queryString: "", body: "", isBase64Encoded: false } },
      { activationId: "a1", getRemainingTimeInMillis: () => 1000 },
    );
    expect(resp.statusCode).toBe(200);
    expect(JSON.parse(resp.body)).toEqual({ ok: true });
    delete process.env.NSKIT_FUNCTION;

    const out = tf.output.nskit.value;
    expect(out.functions.hello.url).toBe("https://faas-nyc1-abc.doserverless.co/api/v1/web/fn-1234/demo-dev/hello");
    expect(out.functions.hello.base_url).toBe(out.functions.hello.url);
    expect(out.functions.tick.url).toBeNull();
    expect(out.functions.tick.id).toBe("demo-dev/tick");
    expect(out.endpoint).toBe("https://faas-nyc1-abc.doserverless.co/api/v1/web/fn-1234/demo-dev");
  });

  test("remote build and project hash changes with the spec", async () => {
    const a = await render(makeProject(CONFIG));
    const b = await render(makeProject(CONFIG.replace("api_host:", "remote_build: true, api_host:").replace("5 minutes", "10 minutes")));
    expect(b.resource.terraform_data.deploy.provisioner[0]["local-exec"].command).toContain("deploy do_project --remote-build");
    expect(a.resource.terraform_data.deploy.triggers_replace[1]).not.toBe(b.resource.terraform_data.deploy.triggers_replace[1]);
  });

  test("memory range and auth", () => {
    const p = makeProject(CONFIG.replace("name: digitalocean", "name: digitalocean\n  memory: 2048"));
    expect(errors(p).some((e) => e.includes("128-1024 MB"))).toBe(true);
    const q = makeProject(CONFIG.replace('"GET /hello/{name}"', "{path: /x, auth: key}"));
    expect(errors(q).some((e) => e.includes("auth `key`"))).toBe(true);
  });
});
