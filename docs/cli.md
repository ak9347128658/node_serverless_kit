# CLI reference

```
nskit [--version] [-h] <command> [options]
```

`node-serverless-kit` is an alias of `nskit`. Installed per project, run it as `npx nskit ...` (or from an npm script).

## Common project options

Every command that loads a project accepts:

| Flag | Meaning |
|---|---|
| `-c, --config <file>` | config file (default: `nskit.yml`, `nskit.yaml`, `serverless-kit.yml`, `serverless-kit.yaml` in the current directory) |
| `-p, --provider <name>` | override `provider.name` (`aws`, `azure`, `gcp`, `alibaba`, `oracle`, `ibm`, `digitalocean`, `tencent`, `huawei`, `cloudflare`, or a plug-in) |
| `-s, --stage <name>` | stage, e.g. `dev`, `staging`, `prod` |
| `-r, --region <name>` | override `provider.region` |
| `-v, --verbose` | print stack traces on errors |

Configuration, packaging, provider and Terraform errors print a single `Error: …` line and exit with code 1.

| Command | What it does |
|---|---|
| [`init`](#nskit-init-dir) | scaffold a project |
| [`validate`](#nskit-validate) | check the config for the selected provider |
| [`package`](#nskit-package) | build the artifact and `main.tf.json` |
| [`plan`](#nskit-plan) | package + `terraform plan` |
| [`deploy`](#nskit-deploy) | package + `terraform apply` |
| [`remove`](#nskit-remove) | `terraform destroy` |
| [`info`](#nskit-info) | show what is deployed |
| [`dashboard`](#nskit-dashboard-dir) | generate / serve the HTML dashboard |
| [`dev`](#nskit-dev) | local HTTP server |
| [`invoke`](#nskit-invoke) | run one function locally with a synthetic event |
| [`workflow`](#nskit-workflow) | run or show a workflow |
| [`providers`](#nskit-providers) | capability matrix |
| [`print`](#nskit-print) | the resolved config |
| [`tf`](#nskit-tf-args) | run any Terraform command in the workspace |

## `nskit init [dir]`

Scaffold a project (default directory `.`): `nskit.yml`, handlers under `src/`, a Vitest test using `LocalRunner`, `package.json`, `.gitignore`, and `tsconfig.json` for TypeScript.

| Flag | Default | |
|---|---|---|
| `--name <service>` | directory name | service name |
| `-p, --provider <name>` | `aws` | target cloud (fills in the region and required options) |
| `-t, --template <name>` | `http` | `http`, `events` (+ schedule/queue/storage), `workflow` (+ order workflow), `full` (everything) |
| `--lang <ts\|js>` | `ts` | TypeScript or JavaScript (ESM) handlers |
| `--force` | | overwrite existing files |

```bash
nskit init orders-api -p gcp -t full --lang ts
```

## `nskit validate`

Validate the config for the selected provider: schema, unsupported triggers/options, runtime, timeouts, required options, and that handler modules exist. Prints errors and warnings, and exits 1 on errors.

```bash
nskit validate --provider azure --stage prod
```

## `nskit package`

Build `.nskit/<provider>-<stage>/artifact.zip` and `main.tf.json` without calling the cloud or Terraform. Runs the `beforePackage` / `afterPackage` hooks.

| Flag | |
|---|---|
| `--skip-install` | don't `npm install` `package.external` and provider dependencies into the artifact |

## `nskit plan`

Package, `terraform init`, then `terraform plan`.

| Flag | |
|---|---|
| `--skip-install` | as above |
| `--destroy` | plan a destroy |

## `nskit deploy`

Package, then `terraform init` and `terraform apply -auto-approve`. Saves `deployment.json`, prints endpoints and ids, and regenerates the dashboard.

| Flag | |
|---|---|
| `--skip-install` | as above |
| `--confirm` | run `terraform plan -out tfplan`, then apply that plan instead of `-auto-approve` |
| `--upgrade` | `terraform init -upgrade` (update provider plugins) |
| `--no-dashboard` | don't regenerate `.nskit/dashboard/index.html` |

Hooks `beforePackage`, `afterPackage`, `beforeDeploy` and `afterDeploy` run around these steps.

## `nskit remove`

`terraform destroy` for this service, stage and provider. Marks the deployment record as `removed`. Runs `beforeRemove` / `afterRemove`.

| Flag | |
|---|---|
| `-y, --yes` | don't ask for confirmation |

## `nskit info`

Show the deployed functions, triggers, URLs and resource ids.

| Flag | |
|---|---|
| `--json` | machine-readable deployment record |
| `--refresh` | re-read `terraform output` instead of the saved record |

Before anything is deployed, `info` shows the configured functions as not deployed.

## `nskit dashboard [dir]`

Generate the HTML dashboard from every `.nskit/*/deployment.json` under `dir` (default `.`).

| Flag | Default | |
|---|---|---|
| `-o, --output <file>` | `.nskit/dashboard/index.html` | where to write the HTML |
| `--serve` | | serve it over HTTP on 127.0.0.1 |
| `--port <n>` | `8765` | port for `--serve` |
| `--open` | | open in the browser |

See [dashboard.md](dashboard.md).

## `nskit dev`

Local HTTP server that routes requests to your handlers through the same dispatcher as in the cloud, rebuilding on change.

| Flag | Default | |
|---|---|---|
| `--host <host>` | `127.0.0.1` | |
| `--port <n>` | `3000` | |
| `--env-file <file>` | `.env` | dotenv file loaded into the environment |
| `--no-watch` | | don't watch `package.source` for changes |

See [local-development.md](local-development.md).

## `nskit invoke`

Invoke one function locally with a synthetic event.

| Flag | |
|---|---|
| `-f, --function <name>` | **required**, function name |
| `-e, --event <type>` | `http`, `invoke`, `schedule`, `queue`, `topic`, `storage` (default: the function's first event type, or `invoke`) |
| `-d, --data <json\|@file>` | JSON payload, or `@path/to/file.json` |
| `--method <method>` | HTTP method (default: the route's method) |
| `--path <path>` | HTTP path including the query string (default: the route's path) |
| `-H, --header <"Name: value">` | HTTP header, repeatable |
| `--env-file <file>` | dotenv file (default `.env`) |

```bash
nskit invoke -f hello --path "/hello?name=Ada"
nskit invoke -f create-item -d '{"name": "lamp"}'                  # POST route, JSON body
nskit invoke -f worker -e queue -d '[{"id": 1}, {"id": 2}]'        # two records
nskit invoke -f on-upload -e storage -d '[{"bucket": "b", "key": "in/a.csv"}]'
nskit invoke -f nightly -e schedule                                # uses the configured input
nskit invoke -f charge -e invoke -d @events/order.json
```

PowerShell: quote JSON with single quotes and escape inner double quotes as `\"`, or use `-d @file.json`.

## `nskit workflow`

```bash
nskit workflow run <name> [-i <json|@file>] [--sleep] [--history]
nskit workflow show <name> [--format auto|asl|gcp|json]
```

- `run` executes the workflow locally on the embedded engine; task functions run in-process. `wait` states are skipped unless `--sleep` is given; `--history` prints every state transition. A failed run prints the error and cause and exits with a non-zero code.
- `show` prints the compiled definition. `auto` picks ASL for AWS, Cloud Workflows for GCP, and the portable JSON otherwise.

## `nskit providers`

Print the capability matrix of the installed providers (built-in and plug-ins). `--json` adds details: tier, default region, runtimes, max timeout, Terraform provider, bundle format, notes.

## `nskit print`

Print the fully merged and interpolated configuration for the selected provider and stage (`extends`, `providers:`, `stages:`, variables, defaults applied).

| Flag | |
|---|---|
| `--json` | print JSON |
| `--yaml` | print YAML |

## `nskit tf <args...>`

Run any Terraform command in the generated workspace `.nskit/<provider>-<stage>/` (after `package` or `deploy`):

```bash
nskit tf state list
nskit tf --stage prod output -json
nskit tf import aws_s3_bucket.b_uploads my-existing-bucket
```

Put nskit's own options (`-s`, `-p`, ...) before the Terraform arguments. If your Terraform arguments start with `-`, separate them with `--` (`nskit tf -- -version`).

## Environment variables

| Variable | Used by |
|---|---|
| `NSKIT_TERRAFORM_BIN` | name or path of `terraform` / `tofu` |
| `NSKIT_PROVIDER_PLUGINS` | comma-separated npm package names of [provider plug-ins](architecture.md#third-party-providers) |
| `NSKIT_LOG_FORMAT`, `NSKIT_LOG_LEVEL`, `LOG_LEVEL` | runtime logging (`json` / `text`; `debug`, `info`, `warn`, `error`) |
| `NSKIT_DEBUG` | include exception details in 500 responses (local or deployed) |
| `NO_COLOR`, `FORCE_COLOR` | disable / force colored output |
