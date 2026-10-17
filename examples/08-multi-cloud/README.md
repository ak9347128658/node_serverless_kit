# 08 · Multi-cloud: same code, eleven targets

`src/handlers.ts` deploys unchanged to all ten clouds and to on-premises. Only the configuration differs,
and you can organise it in either of two ways.

## Option A: one file with `providers:` overrides

`nskit.yml` holds the shared definition plus a `providers.<cloud>` block per cloud:

```bash
npx nskit deploy                          # provider.name (aws)
npx nskit deploy --provider gcp
npx nskit deploy --provider azure
npx nskit deploy --provider alibaba
npx nskit deploy --provider tencent
npx nskit deploy --provider huawei
npx nskit deploy --provider oracle
npx nskit deploy --provider ibm
npx nskit deploy --provider digitalocean
npx nskit deploy --provider cloudflare
npx nskit deploy --provider onprem
```

## Option B: one small file per cloud with `extends:`

```bash
npx nskit deploy -c nskit.aws.yml          # eu-west-1, arm64
npx nskit deploy -c nskit.gcp.yml          # europe-west1
npx nskit deploy -c nskit.azure.yml        # northeurope + Application Insights
npx nskit deploy -c nskit.cloudflare.yml
```

Each child file names the cloud in `provider.name` and sets its own values under
`providers.<cloud>`, so they take precedence over the parent's block for that cloud.

Every combination gets its own Terraform workspace (`.nskit/<provider>-<stage>/`), so the same
service can be live on several clouds at once.

## What each cloud needs

| Cloud | Required settings | Notes |
| --- | --- | --- |
| aws | AWS credentials | Lambda + API Gateway HTTP API, EventBridge Scheduler |
| gcp | `options.project` | Cloud Functions gen2, Cloud Scheduler |
| azure | `options.subscription_id` | Function App (Linux consumption) |
| alibaba | `ALICLOUD_*` credentials | Function Compute HTTP + timer triggers |
| tencent | `TENCENTCLOUD_*` credentials | SCF + API Gateway |
| huawei | `options.apig_instance_id` | FunctionGraph + dedicated APIG |
| oracle | `compartment_id`, `subnet_ids`, `image_repository` | container images; no schedules |
| ibm | `IC_API_KEY` | Code Engine functions; HTTP only |
| digitalocean | `options.namespace`, `doctl` on PATH | deployed with `doctl serverless` |
| cloudflare | `options.account_id` | Workers (V8 isolates: web APIs only, no `node:*` modules) |
| onprem | nothing | one Node.js process; no cloud account. `nskit deploy -c nskit.onprem.yml` |

Where a cloud lacks a feature, the override says so explicitly: `functions.ticker.events: []` on
IBM and Oracle deploys `ticker` without a schedule instead of failing. `runtime` is not pinned,
so nskit picks the newest Node.js (up to 22) each cloud supports. Run
`npx nskit validate --provider <cloud>` to check the config before deploying.

The placeholder values (`${env:X, default}`) let `nskit validate` run without credentials.
Export the real values before `nskit deploy`.

## Writing portable handlers

- Use the kit's `Event` / `Context` / `HttpResponse`, never the native event.
- Prefer web APIs (`fetch`, `crypto.subtle`, `TextEncoder`, `URL`) over `node:*` modules if
  Cloudflare is a target. Read configuration with `ctx.env` / `getEnv()` (works in Workers too).

## Run locally

```bash
npm install
npx nskit dev
curl localhost:3000/whoami
curl -X POST "localhost:3000/echo?debug=1" -d '{"hello": "world"}'
npx nskit invoke -f ticker
```

`whoami` returns `"provider": "local"` locally and `"aws"`, `"gcp"`, ... once deployed. That
field is the only thing that changes.
