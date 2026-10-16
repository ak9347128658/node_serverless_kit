# 11 · Custom Terraform

Add any Terraform resource next to the generated ones and reference it from functions.
This example adds a DynamoDB table, wires its name into the environment and its ARN into IAM.

## `terraform.extra`

```yaml
provider:
  terraform:
    providerVersion: "~> 5.60"
    extra:                                   # raw Terraform JSON, deep-merged into main.tf.json
      resource:
        aws_dynamodb_table:
          orders: {name: "${self:service}-${opt:stage}-orders", billing_mode: PAY_PER_REQUEST, ...}
      output:
        orders_table_arn: {value: "${aws_dynamodb_table.orders.arn}"}
```

Inside `extra` you write plain Terraform JSON, so Terraform expressions such as
`${aws_dynamodb_table.orders.arn}` are used as is. nskit's own variables (`${self:...}`,
`${opt:stage}`) are resolved before.

## `${tf:...}` references

Everywhere else nskit escapes `${` so user strings can never inject Terraform expressions. To
reference a Terraform value on purpose, write `${tf:<expression>}`:

```yaml
environment:
  ORDERS_TABLE: "${tf:aws_dynamodb_table.orders.name}"      # -> "${aws_dynamodb_table.orders.name}"
iam:
  statements:
    - actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"]
      resources: ["${tf:aws_dynamodb_table.orders.arn}", "${tf:aws_dynamodb_table.orders.arn}/index/*"]
```

Inspect the result with `npx nskit package` and open `.nskit/aws-dev/main.tf.json`.

## Remote state

Uncomment `provider.state` once the S3 bucket and DynamoDB lock table exist. Everyone (and CI)
then shares one state file per stage (`key: ${self:service}/${opt:stage}/terraform.tfstate`).
Any Terraform backend works: `gcs`, `azurerm`, `remote`, `http`, ...

## Hooks

```yaml
hooks:
  beforeDeploy: [npm run typecheck]          # a failing command stops the deployment
  afterDeploy: [node scripts/smoke-test.mjs] # reads .nskit/aws-<stage>/deployment.json
```

Available hooks: `beforePackage`, `afterPackage`, `beforeDeploy`, `afterDeploy`, `beforeRemove`,
`afterRemove`. They run from the project root with `NSKIT_SERVICE`, `NSKIT_STAGE`,
`NSKIT_PROVIDER` and `NSKIT_WORK_DIR` set.

## Data access

`src/repository.ts` hides storage behind an interface: DynamoDB on AWS (the AWS SDK v3 that ships
with the Lambda runtime, loaded lazily), an in-memory map locally. Adding Firestore or Cosmos DB
for another cloud means one more class; handlers stay unchanged.

## Run locally

```bash
npm install
npx nskit dev
curl -X POST localhost:3000/orders -d '{"item": "book"}'      # 201 + location header
```

## Deploy

```bash
npx nskit deploy           # table + Lambdas + API, then the smoke test
```

`terraform.extra` here is AWS-specific by design; on another cloud replace the table with that
cloud's database resource under `providers.<cloud>.terraform.extra`.
