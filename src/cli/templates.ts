/** Project scaffolds for `nskit init`. */

import { VERSION } from "../version.js";

export const TEMPLATES = ["http", "events", "workflow", "full"] as const;
export type TemplateName = (typeof TEMPLATES)[number];
export const LANGUAGES = ["ts", "js"] as const;
export type Language = (typeof LANGUAGES)[number];

/** Region written into a new project for each built-in provider. */
export const DEFAULT_REGIONS: Record<string, string> = {
  aws: "us-east-1",
  azure: "eastus",
  gcp: "us-central1",
  alibaba: "cn-hangzhou",
  oracle: "us-ashburn-1",
  ibm: "us-south",
  digitalocean: "nyc1",
  tencent: "ap-guangzhou",
  huawei: "cn-north-4",
  cloudflare: "global",
};

/**
 * Provider options a deployment cannot do without, as YAML lines (relative to
 * the `options:` key). Values come from environment variables with a
 * placeholder default so a fresh project validates before credentials exist.
 */
export const REQUIRED_OPTIONS: Record<string, string[]> = {
  gcp: ["project: ${env:GOOGLE_CLOUD_PROJECT, my-gcp-project}"],
  azure: ["subscription_id: ${env:ARM_SUBSCRIPTION_ID, 00000000-0000-0000-0000-000000000000}"],
  oracle: [
    "compartment_id: ${env:OCI_COMPARTMENT_ID, ocid1.compartment.oc1..change-me}",
    'subnet_ids: ["${env:OCI_SUBNET_ID, ocid1.subnet.oc1..change-me}"]',
    "image_repository: ${env:OCI_IMAGE_REPOSITORY, iad.ocir.io/namespace/change-me}",
  ],
  huawei: ["apig_instance_id: ${env:HUAWEI_APIG_INSTANCE_ID, change-me}"],
  digitalocean: ["namespace: ${env:DO_FUNCTIONS_NAMESPACE, fn-change-me}"],
  cloudflare: ["account_id: ${env:CLOUDFLARE_ACCOUNT_ID, change-me}"],
};

export interface RenderOptions {
  template: TemplateName;
  service: string;
  provider: string;
  lang: Language;
  /** Event types the provider supports (`Provider.capabilities`); unsupported triggers are commented out. */
  capabilities?: ReadonlySet<string>;
}

// ------------------------------------------------------------------ nskit.yml

function optionsBlock(provider: string, indent: string): string {
  const lines = REQUIRED_OPTIONS[provider];
  if (!lines) return "";
  return `${indent}options:\n` + lines.map((l) => `${indent}  ${l}\n`).join("");
}

function otherProvidersComment(provider: string): string {
  const out = [
    "# Deploy the same code to another cloud with `nskit deploy -p <name>`.",
    "# Per-cloud overrides (any top-level key) go under `providers:`, e.g.:",
    "#",
    "# providers:",
  ];
  for (const [name, region] of Object.entries(DEFAULT_REGIONS)) {
    if (name === provider) continue;
    out.push(`#   ${name}:`);
    out.push(`#     region: ${region}`);
    for (const line of optionsBlock(name, "    ").trimEnd().split("\n").filter(Boolean)) out.push(`# ${line}`);
  }
  return out.join("\n") + "\n";
}

/** One event-driven function; the trigger is commented out when the provider does not support it. */
function eventFunction(o: RenderOptions, name: string, handler: string, kind: string, eventLines: string[]): string {
  const supported = !o.capabilities || o.capabilities.has(kind);
  const lines = ["", `  ${name}:`, `    handler: src/handlers.${handler}`];
  if (supported) {
    lines.push("    events:", ...eventLines.map((l) => `      ${l}`));
  } else {
    lines.push(
      `    # ${kind} events are not supported on ${o.provider}; invoke it directly (nskit invoke -f ${name} -e ${kind})`,
      "    # or deploy to a cloud that has them (see `nskit providers`).",
      "    # events:",
      ...eventLines.map((l) => `    #   ${l}`),
    );
  }
  return lines.join("\n") + "\n";
}

function configYaml(o: RenderOptions): string {
  const region = DEFAULT_REGIONS[o.provider] ?? "";
  const events = o.template === "events" || o.template === "full";
  const workflow = o.template === "workflow" || o.template === "full";
  let yml = `# nskit.yml - see https://github.com/ak9347128658/node_serverless_kit/tree/main/docs
service: ${o.service}

provider:
  name: ${o.provider}
${region ? `  region: ${region}\n` : ""}  stage: dev
  memory: 256
  timeout: 15
  environment:
    LOG_LEVEL: info
${optionsBlock(o.provider, "  ")}
${otherProvidersComment(o.provider)}
functions:
  hello:
    handler: src/handlers.hello
    description: Says hello
    events:
      - http: GET /hello

  get-item:
    handler: src/handlers.getItem
    events:
      - http: GET /items/{id}

  create-item:
    handler: src/handlers.createItem
    events:
      - http:
          method: POST
          path: /items
          cors: true
`;
  if (events) {
    const bucket = o.provider === "tencent" ? `${o.service}-uploads-1250000000` : `${o.service}-uploads-change-me`;
    yml += eventFunction(o, "nightly-report", "nightlyReport", "schedule", [
      "- schedule:",
      '    cron: "0 2 * * *"',
      "    input: { report: daily }",
    ]);
    yml += eventFunction(o, "process-jobs", "processJobs", "queue", [`- queue: { name: ${o.service}-jobs, batchSize: 10 }`]);
    yml += eventFunction(o, "on-upload", "onUpload", "storage", [
      `- storage: { bucket: ${bucket}, events: [created], suffix: .csv }`,
    ]);
  }
  if (workflow) {
    yml += `
  validate-order:
    handler: src/handlers.validateOrder

  charge-order:
    handler: src/handlers.chargeOrder

workflows:
  order-pipeline:
    description: Validate then charge an order
    startAt: Validate
    states:
      Validate:
        type: task
        function: validate-order
        retry: [{ errors: ["*"], maxAttempts: 2 }]
        catch: [{ errors: ["OrderInvalid"], next: Rejected }]
        next: Charge
      Charge:
        type: task
        function: charge-order
        end: true
      Rejected:
        type: fail
        error: OrderRejected
`;
  }
  return yml;
}

// ------------------------------------------------------------------ handlers

function handlersSource(o: RenderOptions): string {
  const ts = o.lang === "ts";
  const events = o.template === "events" || o.template === "full";
  const workflow = o.template === "workflow" || o.template === "full";
  const imports = ["defineHandler", "HttpResponse", "NotFound"];
  if (events) imports.push("BatchResult");
  let src = `// HTTP handlers. This code runs unchanged on every supported cloud.
import { ${imports.sort().join(", ")} } from "node_serverless_kit";
${ts ? "\ninterface Item {\n  id: string;\n  name: string;\n  [key: string]: unknown;\n}\n" : ""}
const items${ts ? ": Map<string, Item>" : ""} = new Map([["1", { id: "1", name: "first item" }]]);

/** GET /hello?name=Ada */
export const hello = defineHandler(async (event, ctx) => {
  const name = event.http?.query.name ?? "world";
  ctx.logger.info("saying hello", { name });
  return { message: \`Hello, \${name}!\`, provider: event.provider, stage: ctx.stage };
});

/** GET /items/{id} */
export const getItem = defineHandler(async (event) => {
  const id = event.http${ts ? "!" : "?"}.pathParams.id;
  const item = items.get(id);
  if (!item) throw new NotFound(\`item \${id} does not exist\`);
  return item;
});

/** POST /items  {"name": "lamp"} */
export const createItem = defineHandler(async (event) => {
  const body = event.http${ts ? "!" : "?"}.json${ts ? "<Record<string, unknown>>" : ""}();
  const item = { ...body, id: String(items.size + 1), name: String(body.name ?? "unnamed") };
  items.set(item.id, item);
  return HttpResponse.json(item, 201);
});
`;
  if (events) {
    src += `
/** Runs on a schedule; \`event.data\` is the \`input\` from nskit.yml. */
export const nightlyReport = defineHandler(async (event, ctx) => {
  ctx.logger.info("nightly report", { input: event.data });
  return { ok: true, input: event.data };
});

/** Queue consumer: only failed records are retried where the cloud supports it. */
export const processJobs = defineHandler(async (event, ctx) => {
  const result = new BatchResult();
  for (const record of event.records) {
    try {
      const job = record.json();
      ctx.logger.info("processing job", { job });
    } catch {
      result.fail(record);
    }
  }
  return result;
});

/** Object created in the uploads bucket. */
export const onUpload = defineHandler(async (event, ctx) => {
  for (const record of event.records) {
    ctx.logger.info("object event", { bucket: record.bucket, key: record.key, action: record.action });
  }
});
`;
  }
  if (workflow) {
    src += `
/** Thrown for bad orders; the workflow catches it by name. */
export class OrderInvalid extends Error {
  name = "OrderInvalid";
}

export const validateOrder = defineHandler(async (event) => {
  const order = { ...((event.data${ts ? " as Record<string, unknown> | null" : ""}) ?? {}) };
  if (!(Number(order.amount) > 0)) throw new OrderInvalid("amount must be positive");
  return { ...order, valid: true };
});

export const chargeOrder = defineHandler(async (event) => {
  return { ...(event.data${ts ? " as Record<string, unknown>" : ""}), charged: true };
});
`;
  }
  return src;
}

function testSource(o: RenderOptions): string {
  const workflow = o.template === "workflow" || o.template === "full";
  const events = o.template === "events" || o.template === "full";
  let src = `import { beforeAll, describe, expect, it } from "vitest";
import { LocalRunner } from "node_serverless_kit/testing";

let runner${o.lang === "ts" ? ": LocalRunner" : ""};

beforeAll(async () => {
  runner = await LocalRunner.fromConfig("nskit.yml");
});

describe("${o.service}", () => {
  it("says hello", async () => {
    const res = await runner.http("GET", "/hello?name=test");
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ message: "Hello, test!" });
  });

  it("returns 404 for unknown items", async () => {
    const res = await runner.http("GET", "/items/404");
    expect(res.status).toBe(404);
  });

  it("creates items", async () => {
    const res = await runner.http("POST", "/items", { json: { name: "lamp" } });
    expect(res.status).toBe(201);
  });
`;
  if (events) {
    src += `
  it("reports failed queue records", async () => {
    const result = await runner.queue("process-jobs", [{ job: 1 }, "not json"]);
    expect(result).toMatchObject({ failed: ["2"] });
  });
`;
  }
  if (workflow) {
    src += `
  it("runs the order workflow", async () => {
    const { output } = await runner.workflow("order-pipeline", { amount: 10 });
    expect(output).toMatchObject({ valid: true, charged: true });
  });
`;
  }
  return src + "});\n";
}

// ------------------------------------------------------------------ project files

function packageJson(o: RenderOptions): string {
  const pkg = {
    name: o.service,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "nskit dev",
      deploy: "nskit deploy",
      validate: "nskit validate",
      test: "vitest run",
      ...(o.lang === "ts" ? { typecheck: "tsc --noEmit" } : {}),
    },
    devDependencies: {
      "node_serverless_kit": `^${VERSION}`,
      vitest: "^4.0.0",
      ...(o.lang === "ts" ? { "@types/node": "^22.0.0", typescript: "^5.9.0" } : {}),
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

const TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    lib: ["ES2023"],
    types: ["node"],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    isolatedModules: true,
    noEmit: true,
  },
  include: ["src", "tests"],
};

const GITIGNORE = ".nskit/\nnode_modules/\ndist/\ncoverage/\n.env\n.env.*\n";

function readme(o: RenderOptions): string {
  return `# ${o.service}

Serverless functions built with [node_serverless_kit](https://github.com/ak9347128658/node_serverless_kit).
Write the handlers once in \`src/handlers.${o.lang}\`, deploy them to ${o.provider} (or any other supported cloud).

\`\`\`bash
npm install
npx nskit dev                         # local server on http://127.0.0.1:3000 with hot reload
npx nskit invoke -f hello --path "/hello?name=Ada"
npm test                              # vitest + LocalRunner, no cloud needed
npx nskit validate                    # check the config for ${o.provider}
npx nskit deploy --stage dev          # bundle + terraform apply
npx nskit info                        # endpoints and resource ids
npx nskit dashboard --open            # everything you deployed, on one page
npx nskit remove                      # terraform destroy
\`\`\`

Deploying needs Terraform >= 1.5 (or OpenTofu) and credentials for ${o.provider}.
`;
}

/** Files of a new project, keyed by POSIX relative path. */
export function render(options: RenderOptions): Record<string, string> {
  const ext = options.lang;
  const files: Record<string, string> = {
    "nskit.yml": configYaml(options),
    [`src/handlers.${ext}`]: handlersSource(options),
    [`tests/handlers.test.${ext}`]: testSource(options),
    "package.json": packageJson(options),
    ".gitignore": GITIGNORE,
    "README.md": readme(options),
  };
  if (options.lang === "ts") files["tsconfig.json"] = JSON.stringify(TSCONFIG, null, 2) + "\n";
  return files;
}
