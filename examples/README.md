# Examples

Every directory is a complete project: `cd` into it, `npm install`, then run `npx nskit dev`,
`npx nskit invoke`, `npx nskit workflow run` or `npx nskit deploy`. Handlers use only the public
API (`import ... from "node-serverless-kit"`), so each example deploys to every cloud listed for
it by changing only the provider (`npx nskit deploy --provider gcp`).

| # | Example | Language | Shows |
| --- | --- | --- | --- |
| 01 | [hello-http](01-hello-http) | TypeScript | the smallest deployable function |
| 02 | [rest-api](02-rest-api) | TypeScript | CRUD, path/query params, 400/404/409/422, CORS, cookies, binary, redirect, HS256 JWT with WebCrypto |
| 03 | [scheduled-jobs](03-scheduled-jobs) | JavaScript (ESM) | rate + cron schedules, `input`, time zones, pausing schedules |
| 04 | [queue-worker](04-queue-worker) | TypeScript | `processBatch` / `BatchResult` partial failures, dead-letter queue, `batchSize` / `batchWindow` |
| 05 | [storage-events](05-storage-events) | TypeScript | object created/deleted, prefix/suffix filters, existing buckets |
| 06 | [pubsub-topic](06-pubsub-topic) | JavaScript (`@ts-check`) | topic fan-out to two subscribers, filter policies |
| 07 | [workflow-orders](07-workflow-orders) | TypeScript | every workflow state type, retry/catch, choice rules, `events/*.json` inputs |
| 08 | [multi-cloud](08-multi-cloud) | TypeScript | one code base, **all 10 clouds**: `providers:` overrides and `extends:` files |
| 09 | [function-invoke](09-function-invoke) | TypeScript | `invoke()` between functions, per-cloud resolution |
| 10 | [stages-and-config](10-stages-and-config) | TypeScript | `stages:`, `${env:}`, `${opt:}`, `${self:}`, `${file()}`, `.env`, secrets |
| 11 | [custom-terraform](11-custom-terraform) | TypeScript | `terraform.extra` (DynamoDB), `${tf:...}` references, IAM, remote state, hooks |
| 12 | [async-and-context](12-async-and-context) | TypeScript | async handlers, structured logging, `ctx.remainingTimeMs()`, `ctx.waitUntil` |
| 13 | [migrate-from-aws-lambda](13-migrate-from-aws-lambda) | JS -> TypeScript | migrating raw Lambdas + SAM + Step Functions ASL (before/after) |
| 14 | [testing](14-testing) | TypeScript | Vitest with `LocalRunner`, `vi.mock`, hand-built events, workflow tests, CI |
| 15 | [ci-cd-deploy](15-ci-cd-deploy) | TypeScript | GitHub Actions per-stage deploys with OIDC, remote state |
| 16 | [javascript-commonjs](16-javascript-commonjs) | JavaScript (CommonJS) | `require()`, `module.exports = { handler }`, `exports.list = ...` |
| 17 | [typescript-paths](17-typescript-paths) | TypeScript | `tsconfig` path aliases, shared modules, bundled HTML template via `package.esbuild` |

## How they are tested

`tests/examples.test.ts` (part of `npm test`) discovers every directory with an `nskit.yml` and:

- validates it for its configured provider and for AWS, GCP and Azure;
- builds the artifact and renders the Terraform for its configured provider;
- runs its HTTP routes, invoke / queue / topic / storage / schedule calls and workflows locally with
  `LocalRunner` in bundle mode, i.e. through the same esbuild bundle that gets deployed;
- validates `08-multi-cloud` for all ten providers and each `extends` variant.

## Inside this repository

The examples depend on `node-serverless-kit` like any user project. Inside the repository the
package name resolves to `src/` instead (esbuild alias while bundling, `paths` in each
`tsconfig.json` for type checking), so nothing has to be installed:

```bash
npx tsc --noEmit -p examples/02-rest-api/tsconfig.json
npx vitest run --root examples/14-testing
```

## Placeholders

The configs use `${env:NAME, placeholder}` for account-specific values (GCP project, Azure
subscription, bucket names). Validation and local runs therefore work out of the box; export the
real values before `nskit deploy`.
