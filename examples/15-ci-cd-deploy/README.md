# 15 · CI/CD: deploy per stage from GitHub Actions

A tiny service (`GET /health`) with a production-style pipeline: tests on every push,
`main` deploys to `dev`, a `v*` tag deploys to `staging` and then `prod` after approval.
Cloud access uses OIDC, so no long-lived keys are stored in GitHub.

## Files

| File | Purpose |
| --- | --- |
| `nskit.yml` | remote Terraform state per stage (S3 / GCS / azurerm), `APP_VERSION` from `GITHUB_SHA` |
| `deploy.github-workflow.yml` | copy to `.github/workflows/deploy.yml` |
| `src/handlers.ts` | `/health` returns stage and version for the smoke test |

## One-time setup (AWS)

1. Create the state bucket (versioning on) and a DynamoDB lock table (`LockID` string key).
2. Create an IAM OIDC identity provider for `token.actions.githubusercontent.com` and a deploy
   role that trusts it, restricted to your repository and environments
   (`repo:<owner>/<repo>:environment:prod`). Grant it what nskit's Terraform manages (Lambda, API
   Gateway, IAM roles for the functions, CloudWatch Logs, ...) plus the state bucket/table.
3. In GitHub create the environments `dev`, `staging`, `prod` (add required reviewers to `prod`)
   and set the variables `AWS_DEPLOY_ROLE_ARN`, `TF_STATE_BUCKET`, `TF_LOCK_TABLE`.

The workflow file contains the equivalent steps for GCP (Workload Identity Federation) and
Azure (federated credentials) as comments; `providers.gcp.state` / `providers.azure.state` switch
the backend to `gcs` / `azurerm` automatically.

## Pipeline

```
push main ──► test ──► deploy dev
tag v1.2.3 ─► test ──► deploy staging ──► (approval) ──► deploy prod
```

Each deploy runs `nskit validate`, `nskit deploy --stage <stage>`, then curls `<endpoint>/health`
from `nskit info --json`. `concurrency` makes sure two applies never run at once.

## Run locally

```bash
npm install
npx nskit dev                       # GET localhost:3000/health
npx nskit package --stage prod      # see what CI would deploy (.nskit/aws-prod/main.tf.json)
```

Local runs need no state bucket: the backend is only used by `terraform init` during
`nskit deploy`.

## Switch clouds

```bash
npx nskit deploy --provider gcp --stage dev
npx nskit deploy --provider azure --stage dev
```
