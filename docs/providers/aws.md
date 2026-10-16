# AWS (Lambda)

| | |
|---|---|
| Provider name | `aws` |
| Tier | stable |
| Terraform | `hashicorp/aws >= 5.40` (override with `provider.terraform.providerVersion`) |
| Default region | `us-east-1` |
| Runtimes | `nodejs20` → `nodejs20.x`, `nodejs22` → `nodejs22.x` (default), `nodejs24` → `nodejs24.x` |
| Max timeout | 900 s (API Gateway caps HTTP integrations at 30 s) |
| Triggers | http, schedule, queue, storage, topic |
| Workflows | native: AWS Step Functions |
| Bundle | CommonJS, Node platform, entry `index.js`; `@aws-sdk/*` kept external |
| Credentials | standard AWS chain: `aws configure`, `aws sso login`, `AWS_PROFILE`, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, OIDC in CI |

## Example

```yaml
service: orders
provider:
  name: aws
  region: eu-west-1
  architecture: arm64
  options:
    profile: my-profile                 # AWS CLI profile used by Terraform
    assume_role_arn: arn:aws:iam::123456789012:role/deployer
    allowed_account_ids: ["123456789012"]
    artifact_bucket: my-deploy-bucket   # optional: upload code here instead of a bucket nskit creates
    artifact_upload: s3                 # s3 (default) | direct (inline zip; small bundles only)
    bundle_aws_sdk: false               # true = bundle @aws-sdk/* instead of using the Lambda runtime's copy
  iam:
    statements:
      - {actions: ["dynamodb:GetItem"], resources: ["arn:aws:dynamodb:*:*:table/orders"]}
functions:
  api:
    handler: src/api.handler
    options:                            # merged into aws_lambda_function
      layers: ["arn:aws:lambda:eu-west-1:123456789012:layer:deps:3"]
      vpc_config: {subnet_ids: [subnet-1], security_group_ids: [sg-1]}
      tracing_config: {mode: Active}
```

## Options

### `provider.options`

| Option | Default | Effect |
|---|---|---|
| `profile` | — | `profile` in the Terraform `provider "aws"` block |
| `allowed_account_ids` | — | `allowed_account_ids` in the provider block (guards against deploying to the wrong account) |
| `assume_role_arn` | — | `assume_role { role_arn }` in the provider block |
| `artifact_bucket` | — | existing S3 bucket for the code artifact; otherwise nskit creates a private one |
| `artifact_upload` | `s3` | `s3` uploads the zip once to S3 and every function references it; `direct` sends the zip inline with each function (`filename`). Any other value is a validation error |
| `bundle_aws_sdk` | `false` | `true` removes `@aws-sdk/*` from the externals so the SDK version you installed is bundled |

### `functions.<fn>.options`

Merged as-is into the function's `aws_lambda_function` resource: `vpc_config`, `layers`, `tracing_config`, `ephemeral_storage`, `dead_letter_config`, `kms_key_arn`, ... (Terraform argument names, snake_case). It is applied last, so it can override anything nskit sets.

### Per-workflow options

| Option | Default | Effect |
|---|---|---|
| `workflows.<wf>.options.type` | `STANDARD` | `STANDARD` or `EXPRESS` state machine |

## Triggers

| Trigger | Implementation |
|---|---|
| http | one API Gateway **HTTP API** per service (`$default` stage, auto-deploy), Lambda proxy integration with payload format 2.0; one route per `METHOD /path`; CORS configured on the API when any route has `cors` |
| schedule | EventBridge Scheduler schedule per event (`rate(...)` / `cron(...)`, `timezone` honoured, `enabled: false` → `DISABLED`), with a scheduler role that can invoke Lambda; `input` is delivered in the `__nskit` envelope and arrives as `event.data`; retry policy 2 attempts |
| queue | SQS queue (or `existing: true` data source) + event source mapping with `ReportBatchItemFailures`; `batchSize`, `batchWindow`; `visibilityTimeout` defaults to `max(30, 6 × function timeout)`; `deadLetter` creates a DLQ with a redrive policy (`maxReceive`); `fifo` adds the `.fifo` suffix and content-based deduplication; message retention 14 days |
| storage | S3 bucket with public access blocked (or `existing: true`) + one bucket notification per bucket; `created` → `s3:ObjectCreated:*`, `deleted` → `s3:ObjectRemoved:*`; `prefix` / `suffix` filters are native |
| topic | SNS topic (or `existing: true`) + Lambda subscription; `filter` becomes the subscription's filter policy |
| workflows | Step Functions state machine (ASL compiled from the portable definition) with a role allowed to invoke the task functions |

### HTTP auth

| `auth` | Result |
|---|---|
| `none` | public route |
| `iam` | `authorization_type: AWS_IAM` (SigV4-signed requests) |
| `jwt` | JWT authorizer; requires `authorizer.issuer` and `authorizer.audience` (string or list); optional `authorizer.identitySource` / `identity_source` (default `$request.header.Authorization`) and `authorizer.scopes` |
| `key` | not available on HTTP APIs → validation error |

```yaml
- http:
    path: /orders
    method: POST
    auth: jwt
    authorizer:
      issuer: https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_abc123
      audience: [my-app-client-id]
      scopes: [orders/write]
```

### Schedule expressions

Rates become `rate(5 minutes)`. 5-field cron becomes the 6-field AWS form with a year field: `0 3 * * *` → `cron(0 3 * * ? *)`, `30 8 * * 1-5` → `cron(30 8 ? * 2-6 *)`. `?` goes into whichever of day-of-month / day-of-week is unrestricted, and day-of-week is converted to AWS numbering (1–7, Sunday = 1). Restricting both day-of-month and day-of-week is an error.

### Partial batch failures

Return a `BatchResult` (or `processBatch(...)`) from a queue handler and only the failed message ids are retried (`batchItemFailures`). See [handlers.md](../handlers.md#batchresult-and-processbatch).

## Resources

`aws_lambda_function`, `aws_iam_role` + `aws_iam_role_policy_attachment` (basic execution, SQS execution when needed) + `aws_iam_role_policy` (your `iam.statements`), `aws_cloudwatch_log_group` (`/aws/lambda/<name>`, retention `provider.logRetentionDays`), `aws_s3_bucket` + `aws_s3_bucket_public_access_block` + `aws_s3_object` (code artifact), `aws_apigatewayv2_api` / `_stage` / `_integration` / `_route` / `_authorizer`, `aws_lambda_permission`, `aws_scheduler_schedule`, `aws_sqs_queue`, `aws_lambda_event_source_mapping`, `aws_s3_bucket_notification`, `aws_sns_topic`, `aws_sns_topic_subscription`, `aws_sfn_state_machine`.

All resources get `default_tags` (`nskit-service`, `nskit-stage`, `managed-by`, plus `provider.tags`).

**IAM.** One shared role for all functions. A function with its own `iam.statements` or `iam.role` gets a dedicated role whose policy contains the provider-level statements plus its own. `iam.role` (provider or function level) uses an existing role ARN instead of creating one. Use `${tf:...}` to reference resources from `terraform.extra`.

**Code upload.** With `artifact_upload: s3` (default) the artifact is uploaded once as `<service>-<stage>/artifact-<sha>.zip` to a private `<service>-<stage>-code-*` bucket (created with `force_destroy`) or to `options.artifact_bucket`, and every function reads it from there. This avoids the 50 MB inline limit and the Terraform AWS provider error `decomposing request: bufio.Scanner: token too long` that inline uploads hit with larger bundles. The deploying identity needs `s3:CreateBucket` / `s3:PutObject` (or just `s3:PutObject` on `artifact_bucket`). `source_code_hash` is the artifact's SHA-256, so unchanged code means no function update.

## Artifact and runtime

- Entry `index.js` (CommonJS) with Lambda handler `index.handler`, plus `index.js.map` when `package.sourcemap` is on (`NODE_OPTIONS=--enable-source-maps` is set on the function).
- `@aws-sdk/*` is provided by the Lambda Node.js runtime and kept out of the bundle unless `bundle_aws_sdk: true`. `invoke()` uses `@aws-sdk/client-lambda` from the runtime (`lambda:InvokeFunction`; grant it with `iam.statements`).
- The adapter understands API Gateway HTTP API (payload 2.0), REST API / ALB (payload 1.0), Lambda Function URLs, SQS, SNS, S3, EventBridge (`event.type === "schedule"`, `event.data` = `detail` for raw EventBridge rules), Step Functions tasks and direct invocations (`event.type === "invoke"`).
- Cookies set with `HttpResponse.setCookie` are returned as `cookies` (payload 2.0) or `multiValueHeaders["set-cookie"]` (1.0).

## Outputs

`nskit info` shows, per function: `id` (function name), `arn`, `base_url` (the HTTP API endpoint for HTTP functions, combined with each route into clickable URLs) and a Lambda console link. Workflows show the state machine ARN and a Step Functions console link. `endpoint` is the HTTP API endpoint.

## Limits

- `auth: key` is not available on API Gateway HTTP APIs.
- API Gateway integration timeout is capped at 30 s even if the function timeout is longer.
- Lambda limits apply: 15 min timeout, 10 GB memory, 250 MB unzipped deployment package (including `node_modules` of externals).
- Function names are limited to 64 characters; longer `<service>-<stage>-<function>` names are shortened with a stable hash.

## See also

- [Events](../events.md) · [Workflows](../workflows.md) · [Migrating from AWS](../migrating-from-aws.md)
- [`examples/02-rest-api`](../../examples/02-rest-api) (JWT on AWS), [`examples/11-custom-terraform`](../../examples/11-custom-terraform) (DynamoDB via `terraform.extra`)
