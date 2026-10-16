# 10 · Stages and configuration

One `nskit.yml` for dev, staging and prod, with every variable source the loader supports.

## Variable sources

| Syntax | Resolves to | Example here |
| --- | --- | --- |
| `${env:NAME}` / `${env:NAME, default}` | environment variable at deploy time | `region`, `PAYMENT_API_KEY` |
| `${opt:stage}` / `${opt:region}` / `${opt:provider}` | the effective CLI value (`--stage prod`) | `API_BASE_URL` |
| `${self:path.to.value}` | any value of the merged config | `${self:custom.table}`, `${self:service}` |
| `${file(config/limits.json)}` | JSON / YAML content (or trimmed text) of a file, relative to `nskit.yml` | `custom.limits` |
| `${tf:resource.attr}` | left for Terraform (see example 11) | |

A value that is exactly one reference keeps its type: `memory: "${self:custom.limits.dev.memory}"`
becomes the number `256`. References inside a longer string are converted to text.

## Stages

```bash
npx nskit deploy                    # stage dev (provider.stage)
npx nskit deploy --stage staging    # memory 512, LOG_LEVEL info
npx nskit deploy --stage prod       # eu-central-1, memory 1024, concurrency 100, S3 remote state
```

`stages.<name>` is deep-merged over the whole config when that stage is selected (after
`providers.<cloud>`), so it can change anything: provider settings, function settings, state
backend. Each stage gets its own resources (`shop-config-prod-config`) and its own Terraform
workspace (`.nskit/aws-prod/`).

Resolution order, later wins: `extends` parents -> the file -> `providers.<cloud>` -> `stages.<stage>`
-> CLI flags; then variables are interpolated.

## Secrets

Never commit secrets. `PAYMENT_API_KEY: "${env:PAYMENT_API_KEY, }"` reads it from the deploying
shell or CI secret store (empty default so validation works without it). For local runs copy
`.env.example` to `.env`; `.env` files are git-ignored and never packaged. For production prefer a
secret manager (AWS Secrets Manager, GCP Secret Manager, Key Vault) read at runtime.

`src/settings.ts` validates the environment once per cold start and exposes typed settings.

## Run locally

```bash
npm install
npx nskit dev                       # GET localhost:3000/config
npx nskit dev --stage prod          # prod values, still local
```

## Switch clouds

```bash
npx nskit deploy --provider gcp --stage staging
npx nskit deploy --provider azure --stage prod
```
