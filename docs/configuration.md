# Configuration reference (`nskit.yml`)

nskit looks for `nskit.yml`, `nskit.yaml`, `serverless-kit.yml` or `serverless-kit.yaml` in the current directory. Pass `-c FILE` to use another file. Unknown keys are rejected, so typos fail fast.

**Key spelling.** Keys are camelCase (`batchSize`, `logRetentionDays`, `startAt`). snake_case and kebab-case spellings (`batch_size`, `log_retention_days`, `start_at`) are accepted too and renamed, so configs written for py-serverless-kit port over. Provider `options:` keys are passed to the provider as written; the built-in providers use snake_case (`subscription_id`, `artifact_bucket`).

```yaml
service: orders                 # required
provider:                       # required
  name: aws
  region: us-east-1
package: {...}
functions: {...}
workflows: {...}
hooks: {...}
custom: {...}                   # free-form values for ${self:custom.x}
providers: {...}                # per-cloud overrides (see below)
stages: {...}                   # per-stage overrides (see below)
extends: base.yml               # inherit another file (see below)
```

`nskit print --yaml` (or `--json`) shows the merged, interpolated document for the selected provider and stage.

## Top level

| Key | Type | Default | Rules |
|---|---|---|---|
| `service` | string | — | 2–32 chars of lowercase letters, digits and `-`, starting with a letter |
| `provider` | mapping or string | — | `provider: aws` is shorthand for `provider: {name: aws}` |
| `package` | mapping | see [package](#package) | |
| `functions` | map name → [function](#functions) | `{}` | names start with a letter; letters, digits, `-`, `_`; max 63 chars |
| `workflows` | map name → workflow | `{}` | see [workflows.md](workflows.md) |
| `hooks` | map hook → command or list of commands | `{}` | see [hooks](#hooks) |
| `custom` | any mapping | `{}` | only for `${self:custom...}` |

`providers`, `stages` and `extends` are consumed by the loader before validation (see [overrides and layering](#overrides-and-layering)).

## `provider`

| Key | Type | Default | Notes |
|---|---|---|---|
| `name` | `aws` \| `azure` \| `gcp` \| `alibaba` \| `oracle` \| `ibm` \| `digitalocean` \| `tencent` \| `huawei` \| `cloudflare`, or a [plug-in](architecture.md#third-party-providers) name | — | required (or `--provider`); `[a-z][a-z0-9_-]{1,31}` |
| `region` | string | provider default | e.g. `us-east-1`, `europe-west1`, `westeurope`; overridden by `--region` |
| `stage` | string | `dev` | `[a-z][a-z0-9-]{0,15}`; overridden by `--stage` |
| `runtime` | `nodejs18` \| `nodejs20` \| `nodejs22` \| `nodejs24` | see [default runtime](#default-runtime) | `22`, `node22`, `nodejs22.x` are accepted; provider support varies |
| `memory` | int MB | `256` | 64–32768 |
| `timeout` | int seconds | `30` | 1–3600, and ≤ the provider's max |
| `architecture` | `x86_64` \| `arm64` | `x86_64` | Lambda architecture on AWS; also selects the CPU for `npm install` of externals |
| `environment` | map | `{}` | values are converted to strings (`null` becomes `""`) |
| `tags` | map | `{}` | merged with `nskit-service`, `nskit-stage`, `managed-by: node_serverless_kit` |
| `iam.statements` | list of `{effect, actions, resources}` | `[]` | AWS-style; `effect` defaults to `Allow`, `resources` to `["*"]`. Clouds that can't map them ignore them with a warning |
| `iam.role` | string | — | use an existing role / service account / agency instead of creating one |
| `logRetentionDays` | int or `null` | `14` | log retention where the provider creates a log group (AWS CloudWatch); `null` = don't create one |
| `options` | mapping | `{}` | provider-specific settings, see the [provider pages](providers.md) |
| `state` | mapping | local state | see [state](#state-remote-terraform-backend) |
| `terraform` | mapping | | see [terraform](#terraform) |

### Default runtime

If you don't pin `provider.runtime`, nskit uses **nodejs22** when the target cloud supports it, otherwise the newest supported version below 22 (or, if there is none, the closest one above). This is what makes "change only the provider" work. If you *do* pin a runtime the cloud lacks, `nskit validate` reports an error listing the supported ones (`nskit providers --json` shows them for every provider).

### State: remote Terraform backend

By default Terraform state lives in `.nskit/<provider>-<stage>/terraform.tfstate`, which is git-ignored. For teams and CI, use a remote backend:

```yaml
provider:
  state:
    backend: s3                      # any terraform backend type: s3, gcs, azurerm, http, remote, ...
    config:
      bucket: my-tf-state
      key: orders/${opt:stage}.tfstate
      region: us-east-1
      dynamodb_table: tf-locks
```

| Key | Type | Default |
|---|---|---|
| `state.backend` | string | — (local state) |
| `state.config` | mapping | `{}` (written as the backend block's arguments) |

### `terraform`

| Key | Default | Notes |
|---|---|---|
| `binary` | autodetect: `NSKIT_TERRAFORM_BIN`, then `terraform`, then `tofu` | name or path of the binary |
| `requiredVersion` | `>= 1.5.0` | written into `terraform { required_version }` |
| `providerVersion` | provider's built-in constraint (e.g. `>= 5.40` for `hashicorp/aws`) | e.g. `~> 5.70` |
| `extra` | `{}` | raw Terraform JSON deep-merged into the generated config (see [escape hatches](#escape-hatches)) |

## `functions`

```yaml
functions:
  create-order:
    handler: src/orders.createOrder  # <module path relative to package.source>.<export>
    description: Creates an order
    runtime: nodejs22               # override provider.runtime
    memory: 512                     # MB, 64-32768
    timeout: 20                     # s, 1-3600
    architecture: arm64
    concurrency: 10                 # reserved concurrency / max instances where supported
    environment: {TABLE: orders}
    tags: {team: checkout}
    iam:
      statements:
        - {actions: ["dynamodb:PutItem"], resources: ["${tf:aws_dynamodb_table.orders.arn}"]}
    events:
      - http: POST /orders
    options: {}                     # merged into the provider's function resource (escape hatch)
```

| Key | Type | Default |
|---|---|---|
| `handler` | string, required | — |
| `description` | string | `""` |
| `runtime`, `memory`, `timeout`, `architecture` | as `provider` | inherit from `provider` |
| `environment`, `tags` | map | `{}` (merged over the provider-level values) |
| `events` | list | `[]` (no events = invoke-only function) |
| `concurrency` | int ≥ 0 | — |
| `iam` | like `provider.iam` | statements are added to the provider-level ones; a dedicated role is created (AWS) |
| `options` | mapping | `{}` |

### Handler references

`handler` is `<module path>.<export path>`:

| Reference | Loads |
|---|---|
| `src/orders.getOrder` | export `getOrder` of `src/orders.ts` (or `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx`, or `src/orders/index.*`) |
| `src/index.default` | the default export (`export default fn` or `module.exports = fn`) |
| `lib/api.handlers.list` | `handlers.list` from `lib/api.*` (nested export path) |
| `src/orders.service.list` | file names may contain dots: `src/orders.service.ts` → `list` is tried first |

The path is relative to `package.source`. `nskit validate` reports a missing module. Details in [handlers.md](handlers.md) and [typescript-and-javascript.md](typescript-and-javascript.md).

Event syntax is in [events.md](events.md). Deployed functions are named `<service>-<stage>-<function>`, lowercased, with invalid characters replaced and long names shortened with a stable hash. Two functions can't declare the same `METHOD /path`.

Every deployed function gets these environment variables in addition to yours: `NSKIT_PROVIDER`, `NSKIT_SERVICE`, `NSKIT_STAGE`, `NSKIT_REGION`, `NSKIT_FUNCTION`, `NSKIT_HANDLER`, and `NODE_OPTIONS=--enable-source-maps` when `package.sourcemap` is on and the provider runs Node.js. Your values win on conflicts.

## `package`

| Key | Type | Default | Notes |
|---|---|---|---|
| `source` | string | `.` | directory (relative to the config) that handler paths are relative to |
| `include` | list of globs | `[]` | extra files (templates, data, ...) copied into the artifact next to the bundle; gitignore-style (`**` = any depth), relative to `source` |
| `exclude` | list of globs | `[]` | removes files from `include` matches, on top of the default excludes below |
| `external` | list of package names | `[]` | npm packages **not** bundled: they are installed into the artifact's `node_modules` for Linux (native addons, packages that can't be bundled). Wildcards such as `@aws-sdk/*` are left to the platform |
| `minify` | bool | `false` | esbuild `minify` |
| `sourcemap` | bool | `true` | linked source map next to the bundle (sources content omitted) |
| `tsconfig` | string | `tsconfig.json` at the project root, if present | tsconfig used for `paths` aliases, decorators and JSX settings |
| `esbuild` | mapping | `{}` | raw [esbuild options](https://esbuild.github.io/api/) merged last into the build (`define`, `loader`, `banner`, `mainFields`, ...) |

Your code is bundled from the handler modules' import graph, so you don't list source files. `include` is only for non-imported files you read at runtime.

Default excludes (applied to `include`): `.git/**`, `.hg/**`, `.nskit/**`, `.terraform/**`, `node_modules/**`, `coverage/**`, `.idea/**`, `.vscode/**`, `**/.DS_Store`, `.env`, `.env.*`, `**/*.tfstate`, `**/*.tfstate.*`, `nskit*.yml`, `nskit*.yaml`, `serverless-kit*.yml`.

Versions of `external` packages are pinned to what is installed in your project's `node_modules` (falling back to the range in your `package.json`). `nskit package --skip-install` skips the install. More in [typescript-and-javascript.md](typescript-and-javascript.md#externals-and-native-modules).

## `hooks`

```yaml
hooks:
  beforePackage: "npm run generate"
  afterDeploy:   ["node scripts/smoke-test.mjs"]
```

Allowed hooks: `beforePackage`, `afterPackage`, `beforeDeploy`, `afterDeploy`, `beforeRemove`, `afterRemove` (snake_case spellings such as `before_deploy` are accepted). A value is one command or a list. Commands run through the shell in the project root, with `NSKIT_SERVICE`, `NSKIT_STAGE`, `NSKIT_PROVIDER` and `NSKIT_WORK_DIR` set. A non-zero exit aborts the command.

## Overrides and layering

### `providers:`: per-cloud overrides

```yaml
provider:
  name: aws
  region: us-east-1
providers:
  gcp:
    region: europe-west1            # shorthand for provider.region
    options: {project: my-proj}     # shorthand for provider.options
  azure:
    region: westeurope
    functions:                      # any top-level key can be overridden too
      create-order: {memory: 1024}
```

The block for the active provider (`provider.name` or `--provider`) is deep-merged into the config. Inside a block, provider keys (`region`, `stage`, `runtime`, `memory`, `timeout`, `architecture`, `environment`, `tags`, `iam`, `logRetentionDays`, `options`, `state`, `terraform`) may be written directly as shorthand for `provider: {...}`. Unknown provider names under `providers:` are an error.

### `stages:`: per-stage overrides

```yaml
stages:
  prod:
    provider: {memory: 1024}
    functions:
      create-order: {concurrency: 50}
```

### `extends:`: inherit files

```yaml
# nskit.gcp.yml
extends: nskit.yml            # or a list: [base.yml, team.yml]
provider:
  name: gcp
  options: {project: my-proj}
```

Relative paths resolve from the extending file. Circular `extends` is an error.

### Precedence (later wins)

1. For each file in the `extends` chain, parents first:
   1. that file's own values;
   2. that file's `providers.<active provider>` block.

   So a child file's explicit values beat its parent's per-provider overrides.
2. `stages.<active stage>` (merged across all files; the child wins).
3. CLI flags: `--provider`, `--stage`, `--region`.

Objects are deep-merged; lists are replaced, not appended.

## Variables

| Syntax | Resolves to |
|---|---|
| `${env:NAME}` | environment variable; error if unset |
| `${env:NAME, default}` | environment variable or `default` |
| `${opt:stage}` / `${opt:provider}` / `${opt:region}` | effective CLI values (`${opt:x, default}` allowed) |
| `${self:dotted.path}` | any value of the merged config, e.g. `${self:service}`, `${self:custom.table}`, `${self:custom.list.0}` |
| `${file(path.json)}` | file content relative to the config: `.json` / `.yml` / `.yaml` parsed, other files as trimmed text |

When a value is exactly one variable, its type is kept (`memory: ${self:custom.mem}` stays a number). Variables can nest across passes; unresolved variables are reported together.

Two forms are **not** resolved by nskit and are passed through:

- `${tf:<terraform expression>}` becomes a live Terraform reference, e.g. `${tf:aws_dynamodb_table.orders.arn}` in an IAM statement or environment value. Every other `${` in user values is escaped (`$${`), so Terraform never interprets it.
- Any other `${...}`, such as IAM policy variables like `${aws:username}`, stays literal.

Secrets: don't put them in YAML. Use `${env:...}` for CI-provided values, or reference a secret manager via `${tf:...}`. See [`examples/10-stages-and-config`](../examples/10-stages-and-config).

## Escape hatches

| Need | Use |
|---|---|
| Set an argument nskit doesn't model (VPC, layers, tracing…) | `functions.<fn>.options`: merged into the provider's function resource (e.g. `aws_lambda_function`) |
| Provider-level settings | `provider.options`: see the [provider pages](providers.md) |
| Extra cloud resources (tables, buckets, alarms…) | `provider.terraform.extra`: raw Terraform JSON, deep-merged |
| Reference those resources | `${tf:...}` in `iam.statements`, `environment`, etc. |
| Custom esbuild behaviour | `package.esbuild` |

```yaml
provider:
  name: aws
  terraform:
    extra:
      resource:
        aws_dynamodb_table:
          orders:
            name: orders-${opt:stage}
            billing_mode: PAY_PER_REQUEST
            hash_key: id
            attribute: [{name: id, type: S}]
functions:
  create-order:
    handler: src/orders.createOrder
    environment:
      TABLE_NAME: ${tf:aws_dynamodb_table.orders.name}
    options:
      tracing_config: {mode: Active}
```

Full example: [`examples/11-custom-terraform`](../examples/11-custom-terraform).

## Workflows

The `workflows:` keys (`startAt`, `states`, `description`, `engine`, `timeout`, `options`) are documented in [workflows.md](workflows.md#workflow-keys).
