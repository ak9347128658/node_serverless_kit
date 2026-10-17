# 13 · Migrating AWS Lambda + Step Functions to any cloud

`before/` is a typical AWS-only service: Node.js Lambda handlers that parse API Gateway / SQS
events by hand, a SAM template and a hand-written ASL state machine. `after/` is the same service
on node_serverless_kit. It deploys to AWS first, unchanged in behaviour, and then to GCP, Azure or
any other supported cloud by changing the provider.

```
before/                                after/
  handler.mjs            ──────────►     src/orders.ts      (business logic kept)
  template.yaml          ──┐
  state_machine.asl.json ──┴───────►     nskit.yml          (functions + triggers + workflow)
```

## Step 1 · Inventory what you have

For every Lambda, list its trigger and the AWS APIs it calls. Each trigger maps 1:1 to an
nskit event:

| AWS (SAM) | nskit.yml |
| --- | --- |
| `Type: Api` `POST /orders` | `- http: POST /orders` |
| `Type: SQS` + `ReportBatchItemFailures` | `- queue: {name: ..., batchSize: 10}` (partial failures are always on) |
| `Type: S3` notification | `- storage: {bucket: ..., events: [created], prefix: ...}` |
| `Type: SNS` | `- topic: name` |
| `Type: Schedule` | `- schedule: "0 9 * * *"` or `- schedule: 5 minutes` |
| Step Functions task Lambda | a function without events + a `workflows:` task state |
| `Runtime: nodejs20.x` | `runtime: nodejs20` (or leave it out for the newest supported) |
| `Policies:` / IAM | `iam.statements` (provider-wide or per function) |
| `lambda.invoke(...)` | `invoke("function-name", payload)` |

## Step 2 · Strip the event plumbing out of the handlers

| Before (`handler.mjs`) | After (`src/orders.ts`) |
| --- | --- |
| `JSON.parse(Buffer.from(event.body, "base64")...)` | `event.http.json()` |
| `event.pathParameters.id` | `event.http.pathParams.id` |
| `event.queryStringParameters` | `event.http.query` |
| `event.headers["Authorization"]` | `event.http.headers.get("authorization")` (case-insensitive) |
| `return { statusCode: 400, body: JSON.stringify(...) }` | `throw new BadRequest(...)` |
| `return { statusCode: 202, body: ... }` | `return HttpResponse.json(data, 202)` |
| `for (const r of event.Records) JSON.parse(r.body)` | `for (const r of event.records) r.json()` |
| `{ batchItemFailures: [{ itemIdentifier }] }` | `new BatchResult().fail(record)` or `processBatch(...)` |
| task Lambda `event` (raw state) | `event.data` |
| `context.awsRequestId` | `ctx.requestId` |
| `context.getRemainingTimeInMillis()` | `ctx.remainingTimeMs()` |
| `console.log(...)` | `ctx.logger.info(message, {fields})` |
| `exports.handler = async (event, context) => ...` | `export const handler = defineHandler(async (event, ctx) => ...)` |

Returning a Lambda-proxy object (`{statusCode, headers, body}`) still works, which helps a
step-by-step migration, but it is better to switch to `HttpResponse`.

## Step 3 · Translate the state machine

| ASL | nskit |
| --- | --- |
| `"Type": "Task", "Resource": "<lambda arn>"` | `type: task, function: <logical name>` |
| `"Choice"` + `NumericGreaterThan` | `type: choice`, `{variable: $.total, gt: 500, next: ...}` |
| `StringEquals`, `BooleanEquals`, `IsPresent`, `IsNull`, `And` / `Or` / `Not` | `equals`, `isPresent`, `isNull`, `and` / `or` / `not` |
| `"Wait"`, `"Pass"`, `"Parallel"`, `"Map"` | `wait`, `pass`, `parallel`, `map` |
| `"Retry"` / `"Catch"` with `ErrorEquals` | `retry` / `catch` with `errors` (`States.ALL` -> `"*"`) |
| `IntervalSeconds`, `MaxAttempts`, `BackoffRate` | `intervalSeconds`, `maxAttempts`, `backoffRate` |
| `ResultPath` / `InputPath` / `ItemsPath` | `resultPath` / `inputPath` / `itemsPath` |
| `"Succeed"` / `"Fail"` | `succeed` / `fail` (`error`, `cause`) |

Errors are matched by `error.name`, exactly like Step Functions matches the Lambda error type,
so set `name` on custom errors.

`npx nskit workflow show order-processing --format asl` prints the ASL nskit generates; it
should be equivalent to `before/state_machine.asl.json`, with ARNs filled in automatically.

## Step 4 · Test locally

```bash
cd after && npm install
npx nskit invoke -f create-order --path /orders -d '{"items": [{"qty": 2, "price": 300}]}'
npx nskit workflow run order-processing -i '{"items": [{"qty": 2, "price": 300}]}'
npx nskit workflow run order-processing -i '{"items": [{"qty": 0, "price": 1}]}'   # FAILED OrderRejected
```

Automate it with `LocalRunner` (example 14).

## Step 5 · Redeploy to AWS first (no behaviour change)

```bash
npx nskit deploy           # Lambdas + HTTP API + SQS + Step Functions, via Terraform
```

Run your existing integration tests against the new endpoint. Then switch traffic over
(DNS / API mapping) and delete the old SAM stack.

## Step 6 · Move to the target cloud

```bash
npx nskit validate --provider gcp      # lists anything the target can't do
npx nskit deploy --provider gcp        # Cloud Functions + Pub/Sub + Cloud Workflows
npx nskit deploy --provider azure      # Function App + Storage Queue + embedded workflow engine
```

### Starting the workflow

`before/` called `StartExecutionCommand` from the AWS SDK. Choose one of:

- **Portable:** set `engine: embedded` on the workflow. Every cloud then exposes
  `POST /workflows/order-processing`, which runs the workflow and returns its output.
  `create-order` (or any client) POSTs the order there. Limit: the workflow must finish within
  one function timeout.
- **Native engines** (Step Functions, Cloud Workflows): start executions with the cloud's SDK
  behind a small function of your own, as with queue producers in example 04.

### Other AWS APIs your code calls

DynamoDB, S3 and Secrets Manager calls are data-plane code that nskit doesn't abstract. Hide each
behind a small repository (see example 11) with one implementation per cloud, selected by
`NSKIT_PROVIDER`.

## Checklist

- [ ] every trigger expressed in `nskit.yml`; `nskit validate --provider <target>` clean
- [ ] no `event.body` parsing or `statusCode` objects left in handlers
- [ ] state machine translated; `nskit workflow show --format asl` reviewed
- [ ] unit tests run with `LocalRunner` (example 14)
- [ ] remote Terraform state configured (example 11)
- [ ] data-plane SDK calls behind interfaces
- [ ] deployed to AWS via nskit, traffic switched, old stack removed
- [ ] deployed to the target cloud
