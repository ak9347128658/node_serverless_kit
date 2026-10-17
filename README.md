# node_serverless_kit

[![CI](https://github.com/ak9347128658/node_serverless_kit/actions/workflows/ci.yml/badge.svg)](https://github.com/ak9347128658/node_serverless_kit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/node_serverless_kit.svg)](https://www.npmjs.com/package/node_serverless_kit)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/ak9347128658/node_serverless_kit/blob/main/LICENSE)

**Write your Node.js functions once, in TypeScript or JavaScript. Deploy them to any of 10 clouds, or to a machine you control, by changing one line of YAML.**

`node_serverless_kit` (CLI: `nskit`) is a Serverless-Framework-style toolkit built on **esbuild** and **Terraform**. Your handlers use one small, provider-neutral API (`Event`, `Context`, `HttpResponse`). An `nskit.yml` file says which cloud they run on and what triggers them: HTTP, schedules, queues, storage, topics. The same file can define Step Functions-style workflows. `nskit deploy` bundles your code, generates Terraform for the chosen cloud, applies it, and builds an HTML dashboard of everything you deployed. nskit never calls cloud APIs itself.

It is the Node.js sibling of [py-serverless-kit](https://github.com/ak9347128658/serverless_kit) and uses the same architecture and config model.

```ts
// src/orders.ts - identical on AWS, Azure, GCP, Alibaba, Tencent, Huawei, Oracle, IBM, DigitalOcean, Cloudflare
import { defineHandler, NotFound } from "node_serverless_kit";

export const getOrder = defineHandler(async (event, ctx) => {
  const order = await db.find(event.http!.pathParams.id);
  if (!order) throw new NotFound("no such order"); // -> HTTP 404 JSON on every cloud
  ctx.logger.info("order served", { id: order.id });
  return order;                                     // -> HTTP 200 JSON
});
```

```js
// src/orders.cjs - plain JavaScript (CommonJS) works too; ESM .js/.mjs as well
const { NotFound } = require("node_serverless_kit");

exports.getOrder = async (event) => {
  const order = await db.find(event.http.pathParams.id);
  if (!order) throw new NotFound("no such order");
  return order;
};
```

```yaml
# nskit.yml
service: orders
provider:
  name: aws          # <- change to gcp, azure, cloudflare, ... and redeploy. That's the migration.
  region: us-east-1
functions:
  get-order:
    handler: src/orders.getOrder     # <module path relative to package.source>.<export>
    events:
      - http: GET /orders/{id}
```

```bash
nskit deploy                      # esbuild bundle + terraform apply on AWS
nskit deploy --provider gcp       # same code, Google Cloud Functions
nskit dashboard --open            # every function, trigger, URL and resource id
```

---

## Why

Teams that build on AWS Lambda and Step Functions end up with code full of API Gateway event parsing, SQS record loops and hand-written ASL. When the business needs another cloud, every function has to be rewritten. `node_serverless_kit` fixes this at both layers:

| Layer | Locked-in way | With nskit |
|---|---|---|
| Handler code | Parses `event.requestContext.http.method`, `event.Records[].body`, ... | Uses `event.http.method`, `event.records[].body`: the same on every cloud |
| Triggers / infra | SAM / CloudFormation / CDK / console clicks | One `nskit.yml`, rendered to Terraform for the target cloud |
| Workflows | Step Functions ASL | Portable state machine, compiled to Step Functions, Google Cloud Workflows, or run by the built-in engine everywhere else |
| Visibility | One console per cloud | One generated dashboard across all clouds and stages |

## Features

- **11 providers:** AWS Lambda, Azure Functions, Google Cloud Functions, Alibaba Function Compute, Tencent SCF, Huawei FunctionGraph, Oracle Functions, IBM Code Engine, DigitalOcean Functions, Cloudflare Workers, and on-premises (a process on this machine, copied over SSH, or packed as a folder, with queues, topics and storage brought up for you). The server can run a Node.js you ship, Node.js already on PATH, or Docker. Python and npm are not required there.
- **TypeScript and JavaScript, ESM and CommonJS:** `.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx`, bundled by esbuild with tsconfig `paths` support. Each handler module is loaded lazily on its first invocation.
- **Triggers:** HTTP (path params, CORS, auth), schedules (rate/cron, translated into each cloud's dialect), queues, object storage, pub/sub topics, and direct function-to-function `invoke()`.
- **Workflows:** task / choice / wait / pass / parallel / map / succeed / fail with retry and catch. Native on AWS (Step Functions) and GCP (Cloud Workflows); an embedded engine elsewhere; runnable locally with `nskit workflow run`.
- **Terraform underneath:** real, reviewable `main.tf.json`, any backend (S3, GCS, azurerm, ...), works with OpenTofu. Escape hatches: `terraform.extra`, `${tf:...}` references, per-function `options`.
- **Config that scales:** `extends:`, per-provider `providers:` blocks, per-stage `stages:` blocks, and `${env:}`, `${opt:}`, `${self:}`, `${file()}` variables.
- **Local dev:** `nskit dev` (watching HTTP server), `nskit invoke` with synthetic queue/storage/schedule events, and `LocalRunner` for Vitest/Jest (works with `vi.mock`).
- **Migration friendly:** returning an AWS-Lambda-proxy object (`{statusCode, headers, body}`) or a WHATWG `Response` works on every cloud.
- **Production details:** deterministic artifacts (no redeploy when nothing changed), partial batch failures (`BatchResult`), structured JSON logs, consistent HTTP error mapping, stack traces hidden from clients, a zero-dependency runtime (no extra packages inside your function), and hooks (`beforeDeploy`, ...).

## Supported providers

| Provider | HTTP | Schedule | Queue | Storage | Topic | Workflows |
|---|:-:|:-:|:-:|:-:|:-:|---|
| AWS Lambda (stable) | ✅ | ✅ | ✅ SQS | ✅ S3 | ✅ SNS | native (Step Functions) |
| Google Cloud Functions | ✅ | ✅ | ✅ Pub/Sub | ✅ GCS | ✅ Pub/Sub | native (Cloud Workflows) |
| Azure Functions | ✅ | ✅ | ✅ Storage Queue | ✅ Blob | ✅ Service Bus | embedded |
| Alibaba Function Compute | ✅ | ✅ | – | ✅ OSS | ✅ MNS | embedded |
| Huawei FunctionGraph | ✅ | ✅ | – | ✅ OBS | ✅ SMN | embedded |
| Tencent SCF | ✅ | ✅ | – | ✅ COS | – | embedded |
| DigitalOcean Functions | ✅ | ✅ | – | – | – | embedded |
| IBM Code Engine | ✅ | – | – | – | – | embedded |
| Oracle Functions | ✅ | – | – | ✅ Object Storage | – | embedded |
| Cloudflare Workers | ✅ | ✅ | ✅ Queues | – | – | embedded |
| On-premises | ✅ | ✅ | ✅ broker / Redis | ✅ broker / directory / S3 | ✅ broker / Redis | embedded |

Tiers (stable / beta / experimental) and the exact trigger set per provider are listed in [docs/providers.md](https://github.com/ak9347128658/node_serverless_kit/blob/main/docs/providers.md); `nskit providers` prints the live matrix of your installed version. If a config uses a trigger the target cloud can't support, **`nskit validate` fails with a clear message instead of deploying something half-working.**

> **Maturity, honestly stated:** the Terraform generated for every provider is checked with `terraform validate` against the real provider plugins, in CI too. AWS is *stable*. Other providers follow vendor docs for event payloads that `validate` can't check, so try them on a non-production account first.

## Install

```bash
npm install --save-dev node_serverless_kit     # per project (recommended): npx nskit ...
npm install -g node_serverless_kit             # or globally: nskit ...
```

Requirements: **Node.js >= 20.19** for the CLI, **Terraform >= 1.5** (or OpenTofu) on your `PATH` for `plan`/`deploy`/`remove`, plus credentials for your cloud. Local development, `validate` and `package` need neither. See [Getting started](https://github.com/ak9347128658/node_serverless_kit/blob/main/docs/getting-started.md).

## Quick start

```bash
npx nskit init my-api --provider aws --template full --lang ts   # templates: http | events | workflow | full
cd my-api
npm install
npx nskit dev                                          # http://127.0.0.1:3000/hello
npx nskit invoke -f hello --path "/hello?name=Ada"
npx nskit workflow run order-pipeline -i '{"amount": 42}'
npx nskit deploy --stage dev
npx nskit info
npx nskit dashboard --open
npx nskit remove --stage dev
```

### Move to another cloud

Change `provider.name`, or keep one file with per-cloud blocks:

```yaml
provider:
  name: aws
  region: us-east-1
providers:              # applied only when that provider is selected
  gcp:   {region: europe-west1, options: {project: my-project}}
  azure: {region: westeurope, options: {subscription_id: "${env:ARM_SUBSCRIPTION_ID}"}}
```

```bash
nskit deploy --provider gcp
nskit deploy --provider azure --stage prod
```

### Triggers at a glance

```yaml
functions:
  api:
    handler: src/api.handle
    events:
      - http: {method: POST, path: /orders, cors: true}
      - http: GET /orders/{id}
  nightly:
    handler: src/jobs.nightly
    events:
      - schedule: {cron: "0 2 * * *", input: {report: daily}, timezone: Europe/Berlin}
  worker:
    handler: src/jobs.processOrders
    timeout: 60
    events:
      - queue: {name: orders, batchSize: 10, deadLetter: orders-dlq}
  thumbnails:
    handler: src/media.onUpload
    events:
      - storage: {bucket: my-uploads-bucket, events: [created], suffix: .jpg}
  audit:
    handler: src/audit.onEvent
    events:
      - topic: order-events
```

```ts
import { defineHandler, processBatch } from "node_serverless_kit";

// Retries only the failed messages where the cloud supports it (SQS); elsewhere the batch is redelivered.
export const processOrders = defineHandler((event) =>
  processBatch(event.records, async (record) => handle(record.json()), { concurrency: 5 }),
);
```

### Workflows (portable Step Functions)

```yaml
workflows:
  order-pipeline:
    startAt: Validate
    states:
      Validate:
        type: task
        function: validate-order
        retry: [{errors: [TimeoutError], maxAttempts: 3, backoffRate: 2}]
        catch: [{errors: [ValidationError], next: Rejected}]
        next: Route
      Route:
        type: choice
        choices: [{variable: "$.amount", gt: 1000, next: ManualReview}]
        default: Charge
      ManualReview: {type: wait, seconds: 3600, next: Charge}
      Charge: {type: task, function: charge-order, end: true}
      Rejected: {type: fail, error: OrderRejected}
```

The same definition becomes **AWS Step Functions** on AWS, **Google Cloud Workflows** on GCP, and an **embedded orchestrator function** on the other clouds. Error names in `retry`/`catch` are your JavaScript error names (`err.name`). `nskit workflow show order-pipeline --format asl` prints the generated ASL.

## How it works

```
 nskit.yml ──► config loader ──► provider validation ──► esbuild bundler ─────────► artifact.zip
 (extends, providers:,          (capabilities,           (generated entry + lazy     (deterministic)
  stages:, ${vars})              limits, runtimes)        handler imports + runtime)
                                        │
                                        ▼
                              provider renderer ──► .nskit/<provider>-<stage>/main.tf.json
                                                              │ terraform init / apply
                                                              ▼
                                       deployment.json ──► dashboard/index.html

 At runtime:  cloud event ──► entry glue ──► runtime/adapters/<cloud> ──► Event ──► your handler
              your result ──► HttpResponse / raw value ──► adapter ──► native cloud response
```

More: [docs/architecture.md](https://github.com/ak9347128658/node_serverless_kit/blob/main/docs/architecture.md).

## Examples

Runnable scenarios live in [`examples/`](https://github.com/ak9347128658/node_serverless_kit/tree/main/examples/). Every example is validated, packaged and run locally by the test suite.

| | |
|---|---|
| [01-hello-http](https://github.com/ak9347128658/node_serverless_kit/tree/main/examples/01-hello-http) | Minimal HTTP function |
| [02-rest-api](https://github.com/ak9347128658/node_serverless_kit/tree/main/examples/02-rest-api) | CRUD, path params, validation errors, CORS, cookies, binary, JWT |
| [03-scheduled-jobs](https://github.com/ak9347128658/node_serverless_kit/tree/main/examples/03-scheduled-jobs) | rate/cron schedules with input and time zones |
| [04-queue-worker](https://github.com/ak9347128658/node_serverless_kit/tree/main/examples/04-queue-worker) | Queue consumer, partial batch failures, dead-letter queue |
| [05-storage-events](https://github.com/ak9347128658/node_serverless_kit/tree/main/examples/05-storage-events) | Object created/deleted with filters |
| [06-pubsub-topic](https://github.com/ak9347128658/node_serverless_kit/tree/main/examples/06-pubsub-topic) | Topic fan-out and filters |
| [07-workflow-orders](https://github.com/ak9347128658/node_serverless_kit/tree/main/examples/07-workflow-orders) | Every workflow state type, retry/catch |
| [08-multi-cloud](https://github.com/ak9347128658/node_serverless_kit/tree/main/examples/08-multi-cloud) | Same code, all 11 providers |
| [18-on-premises](https://github.com/ak9347128658/node_serverless_kit/tree/main/examples/18-on-premises) | HTTP, schedules, queues, topics, storage, invoke and workflows on one machine |
| [19-on-premises-deploy](https://github.com/ak9347128658/node_serverless_kit/tree/main/examples/19-on-premises-deploy) | Copy that process over SSH, as a folder, or with a Node binary or Docker when the server has neither |
| [09-function-invoke](https://github.com/ak9347128658/node_serverless_kit/tree/main/examples/09-function-invoke) | Function-to-function `invoke()` |
| [10-stages-and-config](https://github.com/ak9347128658/node_serverless_kit/tree/main/examples/10-stages-and-config) | Stages, variables, secrets |
| [11-custom-terraform](https://github.com/ak9347128658/node_serverless_kit/tree/main/examples/11-custom-terraform) | `terraform.extra`, `${tf:...}`, remote state, hooks |
| [12-async-and-context](https://github.com/ak9347128658/node_serverless_kit/tree/main/examples/12-async-and-context) | async handlers, logging, deadlines, `waitUntil` |
| [13-migrate-from-aws-lambda](https://github.com/ak9347128658/node_serverless_kit/tree/main/examples/13-migrate-from-aws-lambda) | Before/after migration of Lambda + Step Functions |
| [14-testing](https://github.com/ak9347128658/node_serverless_kit/tree/main/examples/14-testing) | Unit-testing handlers and workflows with Vitest |
| [15-ci-cd-deploy](https://github.com/ak9347128658/node_serverless_kit/tree/main/examples/15-ci-cd-deploy) | GitHub Actions deploys per stage |
| [16-javascript-commonjs](https://github.com/ak9347128658/node_serverless_kit/tree/main/examples/16-javascript-commonjs) | Plain JavaScript handlers with `require` / `module.exports` |
| [17-typescript-paths](https://github.com/ak9347128658/node_serverless_kit/tree/main/examples/17-typescript-paths) | tsconfig `paths` aliases and shared modules |

## Documentation

| | |
|---|---|
| [Getting started](https://github.com/ak9347128658/node_serverless_kit/blob/main/docs/getting-started.md) | Install, credentials, first deploy |
| [Configuration reference](https://github.com/ak9347128658/node_serverless_kit/blob/main/docs/configuration.md) | Every `nskit.yml` key, variables, `extends`, stages |
| [Events](https://github.com/ak9347128658/node_serverless_kit/blob/main/docs/events.md) | HTTP, schedule, queue, storage, topic |
| [Handler API](https://github.com/ak9347128658/node_serverless_kit/blob/main/docs/handlers.md) | `Event`, `Context`, `HttpResponse`, errors, `BatchResult`, `invoke()`, logging |
| [TypeScript and JavaScript](https://github.com/ak9347128658/node_serverless_kit/blob/main/docs/typescript-and-javascript.md) | ESM/CJS, tsconfig paths, decorators, native modules, esbuild options |
| [Workflows](https://github.com/ak9347128658/node_serverless_kit/blob/main/docs/workflows.md) | State machine reference, engines, limitations |
| [Providers](https://github.com/ak9347128658/node_serverless_kit/blob/main/docs/providers.md) | Capability matrix, options, credentials, resources and limits per cloud |
| [CLI](https://github.com/ak9347128658/node_serverless_kit/blob/main/docs/cli.md) | Every command and flag |
| [Local development](https://github.com/ak9347128658/node_serverless_kit/blob/main/docs/local-development.md) | `nskit dev`, `invoke`, testing with `LocalRunner` |
| [Dashboard](https://github.com/ak9347128658/node_serverless_kit/blob/main/docs/dashboard.md) | The deployment UI |
| [Architecture](https://github.com/ak9347128658/node_serverless_kit/blob/main/docs/architecture.md) | Bundling, runtime dispatch, third-party providers |
| [Migrating from AWS](https://github.com/ak9347128658/node_serverless_kit/blob/main/docs/migrating-from-aws.md) | Lambda + Step Functions → nskit |
| [Migrating from py-serverless-kit](https://github.com/ak9347128658/node_serverless_kit/blob/main/docs/migrating-from-py-serverless-kit.md) | `pskit` → `nskit` |
| [Troubleshooting](https://github.com/ak9347128658/node_serverless_kit/blob/main/docs/troubleshooting.md) | Common errors and fixes |

## Contributing & releasing

- Contributor guide: [deploy_docs/CONTRIBUTING.md](https://github.com/ak9347128658/node_serverless_kit/blob/main/deploy_docs/CONTRIBUTING.md)
- Quick npm release checklist: [deploy_docs/How_to_deploy.md](https://github.com/ak9347128658/node_serverless_kit/blob/main/deploy_docs/How_to_deploy.md)
- Publishing to npm (step by step): [deploy_docs/PUBLISHING_TO_NPM.md](https://github.com/ak9347128658/node_serverless_kit/blob/main/deploy_docs/PUBLISHING_TO_NPM.md)
- Installing Terraform / OpenTofu: [deploy_docs/HOW_TO_INSTALL_TERRAFORM.md](https://github.com/ak9347128658/node_serverless_kit/blob/main/deploy_docs/HOW_TO_INSTALL_TERRAFORM.md)
- Security policy: [SECURITY.md](https://github.com/ak9347128658/node_serverless_kit/blob/main/SECURITY.md) · Changelog: [CHANGELOG.md](https://github.com/ak9347128658/node_serverless_kit/blob/main/CHANGELOG.md)

## Author

Created and maintained by **Asif Khan**.

Source code, issues and releases: <https://github.com/ak9347128658/node_serverless_kit>

## License

MIT, see [LICENSE](https://github.com/ak9347128658/node_serverless_kit/blob/main/LICENSE).
