# Migrating from AWS Lambda and Step Functions

The goal is to move existing Lambda functions (API Gateway, SQS, S3, SNS and EventBridge triggers) and Step Functions state machines to nskit once. After that, moving to another cloud means changing `provider.name`.

The worked example with real before/after code is [`examples/13-migrate-from-aws-lambda`](../examples/13-migrate-from-aws-lambda): `before/` holds a raw Lambda handler, a SAM template and an ASL file, and `after/` holds the nskit version.

## Step 1: separate business logic from AWS event parsing

Typical Lambda code:

```ts
export const handler = async (event: APIGatewayProxyEventV2) => {
  const body = JSON.parse(event.body ?? "{}");
  const id = event.pathParameters!.id;
  // ...
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) };
};
```

nskit version:

```ts
import { defineHandler } from "node-serverless-kit";

export const getOrder = defineHandler(async (event, ctx) => {
  const body = event.http!.json<Record<string, unknown>>({});
  const id = event.http!.pathParams.id;
  // ...
  return result;                         // object -> JSON 200
});
```

You don't have to rewrite return statements first: a handler that returns a Lambda-proxy object (`{statusCode, headers, body, isBase64Encoded, cookies, multiValueHeaders}`) is still converted to the right response on **every** provider. Returning a WHATWG `Response` works too. See [handlers.md](handlers.md#return-values).

| Lambda | nskit |
|---|---|
| `event.body` + `JSON.parse` / `isBase64Encoded` | `event.http.json()`, `event.http.body` (bytes, already decoded), `event.http.text()` |
| `event.pathParameters` | `event.http.pathParams` |
| `event.queryStringParameters` | `event.http.query` / `event.http.multiQuery` |
| `event.headers` (case varies) | `event.http.headers.get("x-foo")` (case-insensitive) |
| `event.requestContext.http.method` / `event.httpMethod` | `event.http.method` |
| `event.rawPath` / `event.path` | `event.http.path` |
| `event.cookies` | `event.http.cookies` |
| `{statusCode, headers, body}` | return an object/string, or `HttpResponse.json(...)`; throw `NotFound`, `BadRequest`, ... |
| `for (const r of event.Records)` (SQS / SNS / S3) | `for (const r of event.records)`: `r.body`, `r.json()`, `r.attributes`, `r.bucket`, `r.key`, `r.action` |
| `{batchItemFailures: [...]}` | return a `BatchResult` (or use `processBatch`) |
| EventBridge scheduled event | `event.type === "schedule"`, `event.data` = the schedule's `input` |
| `context.awsRequestId` | `ctx.requestId` |
| `context.getRemainingTimeInMillis()` | `ctx.remainingTimeMs()` |
| `context.functionName` | `ctx.functionName` (logical name) |
| `context.callbackWaitsForEmptyEventLoop` / fire-and-forget promises | `ctx.waitUntil(promise)` |
| `new LambdaClient().send(new InvokeCommand(...))` | `await invoke("other-fn", payload)` |
| `console.log` | `ctx.logger.info("msg", {fields})` (structured JSON) |
| `process.env.X` | `getEnv("X")` / `ctx.env.X` (also works on Cloudflare) |

The native objects are still there when you need them: `event.raw` and `ctx.raw`.

Calls to other AWS services (DynamoDB, S3 SDK, ...) keep working, but they tie that function to AWS. Put them behind a small interface of your own if you plan to move clouds. On AWS, `@aws-sdk/*` is provided by the Lambda runtime and left out of the bundle (see [typescript-and-javascript.md](typescript-and-javascript.md#externals-and-native-modules)).

## Step 2: translate the SAM / Serverless / CDK definition

| SAM | `nskit.yml` |
|---|---|
| `Handler: dist/orders.handler` | `handler: src/orders.getOrder` (the source path; nskit bundles it) |
| `Type: HttpApi` / `Api`, `Path: /orders/{id}`, `Method: get` | `- http: GET /orders/{id}` |
| `Path: /files/{proxy+}` | `- http: GET /files/{proxy+}` |
| `Type: Schedule`, `Schedule: rate(5 minutes)` | `- schedule: 5 minutes` |
| `Schedule: cron(0 12 * * ? *)` | `- schedule: "0 12 * * *"` (standard 5-field cron) |
| `Type: SQS`, `BatchSize: 10`, `MaximumBatchingWindowInSeconds: 5` | `- queue: {name: jobs, batchSize: 10, batchWindow: 5, existing: true}` |
| `RedrivePolicy` / DLQ | `deadLetter: jobs-dlq`, `maxReceive: 5` |
| `Type: S3`, `Events: s3:ObjectCreated:*`, suffix filter | `- storage: {bucket: b, events: [created], suffix: .csv, existing: true}` |
| `Type: SNS`, `FilterPolicy` | `- topic: {name: t, filter: {...}, existing: true}` |
| `Policies` / IAM statements | `iam.statements: [{actions: [...], resources: [...]}]` |
| `Role:` (existing role) | `iam.role: arn:aws:iam::...` |
| `MemorySize`, `Timeout`, `Runtime: nodejs22.x`, `Environment`, `Architectures` | `memory`, `timeout`, `runtime: nodejs22`, `environment`, `architecture` |
| `ReservedConcurrentExecutions` | `concurrency` |
| JWT authorizer | `auth: jwt` + `authorizer: {issuer, audience}` |
| `Layers`, `VpcConfig`, `Tracing` | `functions.<fn>.options: {layers: [...], vpc_config: {...}, tracing_config: {...}}` |
| Other resources (DynamoDB tables, ...) | `provider.terraform.extra`, referenced with `${tf:...}` |

Use `existing: true` while queues, buckets and topics are still owned by your old stack. Full key reference: [configuration.md](configuration.md) and [events.md](events.md).

## Step 3: translate Step Functions

Convert the ASL with the mapping table in [workflows.md](workflows.md#migrating-step-functions-asl), then check it:

```bash
nskit workflow run order-pipeline -i @events/order.json --history   # runs locally
nskit workflow show order-pipeline --format asl                     # compare with your old ASL
```

`ErrorEquals` names become JavaScript error names: the thrown error's `name` (set it on your error classes). `Parameters`, `ResultSelector` and intrinsic functions aren't supported; move that shaping into a small task function.

## Step 4: deploy to AWS side by side

```bash
nskit deploy --stage migration
nskit info --stage migration          # new endpoints and ARNs
```

Run both stacks in parallel, switch traffic (DNS, API mapping, event source), then remove the old stack.

## Step 5: move to another cloud

```bash
nskit validate --provider gcp         # shows what isn't portable (e.g. jwt auth, AWS-only options)
```

Typical changes, all in YAML:

- add provider options (`options.project` on GCP, `options.subscription_id` on Azure, ...), see [providers.md](providers.md);
- replace `auth: jwt` (AWS only) with what the target supports, or validate tokens in the handler;
- drop `existing: true` for resources that should be created on the new cloud;
- move AWS-only `functions.<fn>.options` and `terraform.extra` into a `providers.aws:` block (and add equivalents for the new cloud);
- set `NSKIT_ENDPOINT_<NAME>` for `invoke()` targets on clouds without native invocation (see [handlers.md](handlers.md#invoke)).

Put these in a `providers.gcp:` block or an `nskit.gcp.yml` with `extends: nskit.yml` (see [`examples/08-multi-cloud`](../examples/08-multi-cloud)), then run `nskit deploy --provider gcp`.

Step Functions become Cloud Workflows on GCP and the embedded orchestrator elsewhere. Mind the [embedded engine's time limit](workflows.md#embedded-orchestrator).
