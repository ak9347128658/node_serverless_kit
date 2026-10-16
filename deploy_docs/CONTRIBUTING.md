# Contributing to node-serverless-kit

Thanks for helping. This guide covers how the project is organised, how to set up a dev environment, the rules every change must follow, and step-by-step recipes for the common contributions: a config option, an event type, a cloud provider, docs and examples.

node-serverless-kit is the Node.js sibling of [py-serverless-kit](https://github.com/ak9347128658/serverless_kit) and follows the same architecture. When in doubt about a design question, read the matching Python module.

## Ground rules

1. **Handler code must never change between clouds.** Every feature is designed around this. Anything that can't be portable goes under a provider's `options:` and is documented as provider-specific.
2. **The runtime has zero dependencies and runs everywhere.** `src/runtime/` and `src/index.ts` are bundled into every deployment and must run on Node.js 18+ **and** in V8 isolates (Cloudflare Workers). No `node:*` imports, and no `Buffer` or `process` without a guard: use the helpers in `src/runtime/util.ts` (`getEnv`, `env`, `base64Encode`/`base64Decode`, `utf8Encode`/`utf8Decode`).
3. **Generated Terraform must be real.** Build it as JS objects with `TerraformDoc`, never as HCL strings. Never guess a resource type or argument: verify with `terraform validate` against the real provider plugin ([Verifying Terraform](#verifying-terraform)).
4. **Be honest about limits.** If a provider can't support something, return a validation `Issue` (or add to `doc.warnings` when it is harmless). Never skip it silently.
5. **Artifacts are byte-reproducible.** Sorted zip entries, fixed timestamps, LF line endings, no timestamps or absolute paths in generated files.
6. **Tests come with every change.** Bug fixes need a regression test.

## Development setup

Requirements: **Node.js >= 20.19** (CI tests 20, 22 and 24) and npm. Optional: **Terraform >= 1.5** or OpenTofu ([HOW_TO_INSTALL_TERRAFORM.md](HOW_TO_INSTALL_TERRAFORM.md)) for `npm run validate:terraform` and real deploys.

```bash
git clone https://github.com/ak9347128658/node_serverless_kit.git
cd node_serverless_kit
npm ci
npm run check            # typecheck + lint + tests + build
```

Try the CLI from your checkout:

```bash
npm run build
node bin/nskit.js --version
cd examples/01-hello-http && node ../../bin/nskit.js validate
```

To use your checkout from another project: `npm link` here, then `npm link node-serverless-kit` there (run `npm run dev` to rebuild on change).

## Project layout

```
src/
  index.ts            # runtime public API (zero deps): Event, Context, HttpResponse, errors, BatchResult, invoke, ...
  testing.ts          # node-serverless-kit/testing: LocalRunner and test helpers
  api.ts              # node-serverless-kit/api: programmatic API (Project, Deployer, providers, ...)
  version.ts          # VERSION (kept equal to package.json)
  cli/                # `nskit` commands (commander) and `nskit init` templates
  config/
    schema.ts         # zod ServiceConfigSchema: camelCase keys, snake_case accepted
    loader.ts         # extends, providers:/stages: overrides, ${env|opt|self|file} variables
  core/
    project.ts        # Project: config + provider, default runtime, handler lookup, embedded orchestrators
    deployer.ts       # package / plan / deploy / remove, hooks, deployment record
    describe.ts       # deployment.json (powers `nskit info` and the dashboard)
    paths.ts          # locate the package's own sources (runtime is bundled from src/)
  dashboard/          # static HTML dashboard generator
  local/              # LocalRunner (import / bundle mode); `nskit dev` server
  packaging/
    builder.ts        # generated entry module -> esbuild -> build/ -> artifact.zip
    zip.ts            # deterministic zip writer
    glob.ts           # include/exclude globs, default excludes
  providers/
    base.ts           # Provider base class, capabilities, RenderContext, Issue
    registry.ts       # built-in providers, registerProvider, loadProviderPlugins
    terraform-doc.ts  # TerraformDoc builder, escape(), ref(), tfId()
    schedule.ts       # rate/cron -> each provider's dialect
    <cloud>.ts        # one renderer per cloud
  runtime/            # bundled into every deployment (zero deps, Node + V8 isolates)
    event.ts          #   Event, HttpRequest, EventRecord, Headers
    context.ts        #   Context (requestId, logger, remainingTimeMs, waitUntil)
    response.ts       #   HttpResponse + coercion of handler results
    dispatch.ts       #   execute(): manifest lookup, routing, CORS, 405, error mapping, BatchResult
    manifest.ts       #   installBundle(), lazy handler resolution
    routing.ts        #   {id} / {path+} route matching
    envelope.ts       #   the __nskit envelope
    workflow.ts       #   embedded state-machine engine + orchestrate()
    invoke.ts         #   portable function-to-function invoke()
    batch.ts, errors.ts, log.ts, util.ts
    adapters/
      <cloud>.ts      #   native event/response <-> portable model
      httpfn.ts       #   shared logic for HTTP-only clouds
      local.ts        #   runtime surface used by the CLI's local tools
  terraform/runner.ts # terraform / tofu subprocess wrapper
  workflows/          # compilers: asl.ts (Step Functions), gcp.ts (Cloud Workflows), index.ts
tests/                # vitest, mirrors src/ (tests/providers/<cloud>.test.ts, tests/runtime/adapter-<cloud>.test.ts)
examples/             # runnable projects; each nskit.yml is validated, packaged and run by tests/examples.test.ts
docs/                 # user documentation (docs/providers/<cloud>.md per provider)
deploy_docs/          # maintainer docs (contributing, releasing, Terraform install)
scripts/              # validate-all-providers.mjs, check-version.mjs
bin/nskit.js          # CLI launcher (imports dist/cli.js)
```

## Architecture recap

**Deploy time (CLI):** `nskit.yml` becomes a bundle plus `main.tf.json`.

```
nskit deploy
  -> config/loader.ts      extends, providers:/stages: overrides, ${env|opt|self|file} variables
  -> config/schema.ts      zod validation (strict: unknown keys are errors)
  -> core/project.ts       pick the Provider, default runtime, add <workflow>-orchestrator functions
  -> Provider.validate()   capabilities, runtimes, timeouts, provider limits -> Issues
  -> packaging/builder.ts  generated entry -> esbuild bundle -> build/ -> deterministic artifact.zip
  -> Provider.render()     providers/<cloud>.ts -> TerraformDoc -> main.tf.json
  -> terraform/runner.ts   terraform init / apply
  -> core/describe.ts      `nskit` output -> deployment.json -> dashboard/
```

Everything lands in `.nskit/<provider>-<stage>/`.

**Run time (in the cloud):**

```
platform -> generated entry (installBundle({manifest, handlers}) + Provider.entryCode glue)
         -> runtime/adapters/<cloud>.ts   native event -> portable Event / Context
         -> runtime/dispatch.ts execute   manifest lookup, HTTP routing/CORS/405, lazy handler import,
                                          error -> JSON mapping, BatchResult
         -> adapter                       result -> native response
```

TypeScript runtime sources are bundled directly, and `node-serverless-kit` imports in user code are aliased to `src/index.ts`, so user code and the dispatcher share one copy of the runtime.

Key concepts:

- **Handler references** are `<module path relative to package.source>.<export>` (`src/orders.getOrder`, `src/index.default`). `core/project.ts::locateHandler` resolves `.ts/.mts/.cts/.tsx/.js/.mjs/.cjs/.jsx` and `index.*`.
- **The `__nskit` envelope:** payloads nskit itself produces (schedule inputs, workflow tasks, `invoke()`) are `{"__nskit": "<schedule|workflow|invoke>", "data": ...}`, so adapters on HTTP-only clouds recover the real `event.type`.
- **The `nskit` Terraform output:** every provider emits `output "nskit"` shaped `{functions: {<name>: {id, arn?, url?, base_url?, console?}}, workflows: {...}, endpoint}`. `nskit info` and the dashboard read only this.
- **Workflows:** `workflows/asl.ts` (AWS), `workflows/gcp.ts` (GCP), and the embedded engine `runtime/workflow.ts` everywhere else and locally.

More detail: [docs/architecture.md](../docs/architecture.md).

## Running tests and checks

```bash
npm test                                     # whole suite: no cloud access, no terraform needed
npx vitest run tests/providers/aws.test.ts   # one file
npx vitest run -t "routes"                   # tests whose name matches
npm run test:watch                           # watch mode
npm run coverage                             # v8 coverage report in coverage/
npm run typecheck                            # tsc --noEmit (strict)
npm run lint                                 # eslint
npm run build                                # tsup -> dist/ (ESM + CJS + .d.ts)
npm run check                                # all of the above (what CI and prepublishOnly run)
npm run validate:terraform -- --provider aws # real `terraform validate` (network, no credentials)
```

## Workflow

1. Open an issue first for anything non-trivial (new provider, config changes) so the design can be agreed.
2. Fork and branch from `main`: `feat/<name>`, `fix/<name>`, `docs/<name>`.
3. Keep PRs focused: one provider or one feature per PR.
4. Write [Conventional Commits](https://www.conventionalcommits.org/): `feat(gcp): support Cloud Tasks queues`, `fix(runtime): keep multi-value headers`, `docs(cli): document --env-file`. Common scopes: `runtime`, `config`, `cli`, `packaging`, `local`, `dashboard`, `workflows`, and provider names.
5. Add an entry under **Unreleased** in `CHANGELOG.md`.
6. Make sure CI is green: tests on Node 20/22/24 (Ubuntu) and Node 22 on Windows/macOS, lint, typecheck, build, `npm pack --dry-run`, and `terraform validate` for all 10 providers.

## Recipes

### Add a config option

Example: `queue.maxConcurrency`.

1. Add the field to the model in `src/config/schema.ts` with a default and validation. Use camelCase; the `obj()` helper accepts the snake_case spelling (`max_concurrency`) automatically.
2. Implement it in every provider that can support it (`src/providers/<cloud>.ts`). Where a provider can't, add a `doc.warnings` entry if ignoring it is harmless, or return an `Issue("error", ...)` from `extraValidation()` if ignoring it would be dangerous.
3. If the runtime needs it, pass it through the bundle manifest (`core/project.ts::bundleManifest`, `runtime/manifest.ts`).
4. Show it in `core/describe.ts` if it belongs in `nskit info` / the dashboard.
5. Tests: `tests/config/` and the relevant `tests/providers/<cloud>.test.ts`.
6. Docs: `docs/configuration.md` (or `docs/events.md`), and `docs/providers/<cloud>.md` if behaviour differs per provider.

Provider-specific settings belong under `provider.options` / `functions.<fn>.options` instead. Their keys stay snake_case (`subscription_id`, `artifact_bucket`) for parity with py-serverless-kit.

### Add an event type

1. `src/config/schema.ts`: add the kind to `EVENT_KINDS`, define its model with `obj({...})`, add it to `EVENT_MODELS`, `EventSpec`, `EventConfigOf`, and the YAML shorthand in `expandEventShorthand`.
2. `src/runtime/event.ts`: add the value to `EventType` if handlers see a new `event.type`.
3. `src/providers/base.ts`: add a capability constant, include it in `Capability` and `EVENT_CAPABILITIES`, and export it from `src/api.ts`. `Provider.validate()` then rejects the event on providers that don't list it.
4. Render it in each provider that supports it, and add the capability to that provider's `capabilities`.
5. Convert the native payload in each `src/runtime/adapters/<cloud>.ts`.
6. `src/core/describe.ts::eventSummary` (dashboard/info) and `functionKind` in the schema if needed.
7. Local tooling: a `LocalRunner` method in `src/local/runner.ts`, `nskit invoke -e <type>` and the dev server's invoke endpoint.
8. Tests for schema, providers, adapters and `LocalRunner`; docs in `docs/events.md`, `docs/handlers.md` and the capability matrices (`docs/providers.md`, README).

### Add a new cloud provider

1. **Research.** Find the Terraform provider and the exact resources for a function from a zip (or container image), an HTTP endpoint and each trigger. Note the Node.js runtimes, the module format the platform loads (CJS or ESM), the entrypoint signature, whether it runs Node.js or a V8 isolate, the max timeout, and how dependencies get installed. Record real native event payloads.

2. **Adapter:** create `src/runtime/adapters/<cloud>.ts`:
   - convert every native payload (HTTP and each trigger) to `Event` and the native context to `Context`;
   - call `execute()` from `runtime/dispatch.ts`, then turn the result into the native response (`HttpResponse.renderForGateway()` for gateway-style HTTP);
   - recognise `__nskit` envelopes with `unwrapEnvelope()` (`runtime/envelope.ts`). For clouds where every invocation arrives as an HTTP request, reuse `runtime/adapters/httpfn.ts` (`eventFromRequest` and friends), which also returns non-HTTP failures as JSON 500 `{"errorType", "cause"}` so native workflows can match errors by name;
   - follow the runtime rules: zero dependencies, no `node:*`, guard `Buffer`/`process` via `runtime/util.ts`.

3. **Provider:** create `src/providers/<cloud>.ts` with a class extending `Provider` (`src/providers/base.ts`):

   | Member | Purpose |
   |---|---|
   | `name`, `displayName` | `mycloud`, `My Cloud Functions` |
   | `tier` | `"experimental"` until it has really been deployed |
   | `terraformSource`, `terraformVersion` | e.g. `acme/mycloud`, `>= 1.0` (and `terraformLocalName` if the local name differs) |
   | `defaultRegion` | used when `provider.region` is not set |
   | `capabilities` | `new Set<Capability>([HTTP, SCHEDULE, ...])`; `WORKFLOW_NATIVE` only with a native engine |
   | `runtimes` | canonical -> provider id, e.g. `{ nodejs20: "nodejs20", nodejs22: "nodejs22" }` |
   | `maxTimeout`, `maxNameLength`, `namePattern` | limits and naming rules |
   | `bundle` | `{ format: "cjs" \| "esm", platform: "node" \| "neutral" \| "browser", entryFile, external?, conditions? }` (override `bundleTarget(config)` to vary by options) |
   | `dependencies` | npm packages installed into the artifact, e.g. `{ "@azure/functions": "^4.0.0" }` |
   | `remoteInstall` | `true` when the platform runs `npm install` itself (the bundler then only writes `package.json`) |
   | `entryCode(ctx)` | glue appended to the generated entry, e.g. ``export { handler } from ${JSON.stringify(ctx.runtime("adapters/mycloud"))};`` |
   | `extraFiles(config, manifest)` | extra files at the artifact root (host.json, package.json, Dockerfile, ...) |
   | `providerBlock(ctx)` | the Terraform `provider` block (region, credentials options) |
   | `renderResources(doc, ctx)` | every resource, and **always** `doc.output("nskit", { functions, workflows, endpoint })` |
   | `extraValidation(config)` | provider-specific limits as `Issue`s |
   | `notes` | one line shown by `nskit providers` |

   Use `ctx.functionItems()`, `ctx.physicalName()`, `ctx.environment(name, fn)` (adds the `NSKIT_*` variables), `ctx.tags(fn)`, `ctx.runtimeIdOf(fn)`, `ctx.artifact` and `escape()` / `escapeMap()` for user strings. Read provider options with `ctx.opt("snake_case_key")`.

4. **Register** it in `src/providers/registry.ts` (`BUILTIN`) and add its name to `PROVIDERS` in `src/config/schema.ts`.

5. **Tests:** `tests/providers/<cloud>.test.ts` (render, the `nskit` output, validation errors, warnings) and `tests/runtime/adapter-<cloud>.test.ts` (realistic native payloads, recorded from the real platform when possible).

6. **Terraform:** add placeholder values for required options to `DUMMY_OPTIONS` in `scripts/validate-all-providers.mjs`, then run `npm run validate:terraform -- --provider <cloud>` until it passes. Add the provider to the matrix in `.github/workflows/ci.yml`.

7. **CLI templates:** add the default region and required options to `DEFAULT_REGIONS` / `REQUIRED_OPTIONS` in `src/cli/templates.ts` so `nskit init -p <cloud>` produces a valid config.

8. **Docs:** write `docs/providers/<cloud>.md` (Terraform provider, credentials, options, trigger implementation table, resources, limits), add it to the matrix in `docs/providers.md`, `docs/events.md` and the README, and add an entry to `CHANGELOG.md`.

**Third-party providers** don't need a change to this repository. Publish an npm package whose default export (or `provider` export) is a `Provider` subclass or instance, then either:

- list it in `NSKIT_PROVIDER_PLUGINS` (comma-separated package names, resolved from the project directory), or
- call `registerProvider(new MyCloudProvider())` / `await loadProviderPlugins(["nskit-provider-mycloud"])` from `node-serverless-kit/api`.

The loader then accepts `provider: {name: mycloud}`. See [docs/architecture.md](../docs/architecture.md#third-party-providers).

### Add an example

Create `examples/NN-name/` with `nskit.yml`, handler code and a `README.md`. `tests/examples.test.ts` picks it up automatically: it validates, packages and runs it locally. Add it to the examples table in the README.

## Verifying Terraform

Unit tests check the shape of the generated JSON. Only Terraform can tell whether the resource types and arguments exist. For any provider change:

```bash
npm run validate:terraform -- --provider <cloud>      # builds dist/ if needed, renders every supported trigger, init + validate
npm run validate:terraform -- --provider <cloud> --keep   # keep the temp project to inspect main.tf.json
```

Manually, against an example:

```bash
cd examples/08-multi-cloud
node ../../bin/nskit.js package --skip-install --provider <cloud>
cd .nskit/<cloud>-dev
terraform init -backend=false
terraform validate          # must print: Success! The configuration is valid.
```

Look up a resource's exact schema (inside an initialised workspace):

```bash
terraform providers schema -json | node -e "
  const s = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const p = Object.values(s.provider_schemas)[0];
  console.log(JSON.stringify(p.resource_schemas['aws_lambda_function'].block.attributes, null, 1));"
```

## Coding rules

- TypeScript strict, ESM sources with `.js` import suffixes, 2-space indent, double quotes, lines up to ~130 characters.
- `src/runtime/` and `src/index.ts`: zero dependencies, Node 18+ and V8 isolates. Cross-copy checks use `Symbol.for` brands (`isHttpError`, `isBatchResult`, `isHttpResponse`); runtime singletons live on `globalThis` (see `runtime/manifest.ts`).
- Terraform as JS objects through `TerraformDoc`, never HCL strings. User strings go through `escape()` (`${` -> `$${`) unless written as `${tf:...}`. Terraform argument names stay snake_case.
- Generated files: LF endings, sorted keys/entries where order is not meaningful, no timestamps or absolute paths.
- User-facing errors say what is wrong **and** how to fix it.
- Comments explain why, not what.
- The version lives in `src/version.ts` and `package.json`; `node scripts/check-version.mjs` checks they match.

## Pull request checklist

- [ ] `npm run check` passes
- [ ] Tests added or updated; bug fixes include a regression test
- [ ] Handler code stays portable; non-portable features are under `options:` and documented
- [ ] Runtime rules respected (zero deps, no unguarded Node globals)
- [ ] `npm run validate:terraform -- --provider <name>` passes for every provider you touched
- [ ] Docs updated (user docs, provider page, README matrix if capabilities changed)
- [ ] `CHANGELOG.md` entry under **Unreleased**

## Reporting bugs and security issues

- Bugs: open an issue with `nskit --version`, the provider, the relevant part of `nskit.yml` (secrets removed) and the full error (run with `-v`).
- Security vulnerabilities: **don't** open a public issue. Follow [SECURITY.md](../SECURITY.md).

## Releasing

Maintainers: [How_to_deploy.md](How_to_deploy.md) (checklist) and [PUBLISHING_TO_NPM.md](PUBLISHING_TO_NPM.md) (full guide).
