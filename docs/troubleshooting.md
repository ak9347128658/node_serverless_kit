# Troubleshooting & FAQ

Add `-v` to any command to see the full stack trace. Start with `nskit validate`, which catches most provider limits before Terraform runs, and `nskit print --yaml` to see the config nskit actually uses.

## Installation and tooling

**`Neither terraform nor tofu was found on PATH`**
: Install Terraform >= 1.5 or OpenTofu ([HOW_TO_INSTALL_TERRAFORM.md](../deploy_docs/HOW_TO_INSTALL_TERRAFORM.md)), or point `NSKIT_TERRAFORM_BIN` (or `provider.terraform.binary`) at the binary.

**`nskit: command not found`**
: With a per-project install, run `npx nskit ...` or call it from an npm script. Check the engine: the CLI needs Node.js >= 20.19 (`node --version`).

**`npm install failed while installing external dependencies`**
: `package.external` and provider dependencies are installed for **Linux** (`--os=linux --cpu=x64|arm64 --libc=glibc`). A native addon without a prebuilt Linux binary for that CPU fails, especially when packaging on Windows or macOS. Fixes:
  - build the artifact on Linux (CI, WSL or a container);
  - pick a version or package that ships prebuilt Linux binaries (or a pure-JS alternative);
  - check `provider.architecture` matches the binaries you need (`arm64` vs `x86_64`).

  `nskit package --skip-install` lets you test packaging without installing.

**Paths too long on Windows**
: Deep `node_modules` trees under `.nskit/` can exceed the classic 260-character limit. Enable long paths:

  ```powershell
  New-ItemProperty -Path HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force
  git config --global core.longpaths true
  ```

  Or keep the project in a short path such as `C:\src\app`.

## Bundling

**`bundling failed: Could not resolve "x"`**
: The package isn't installed in the project (`npm install x`), or it is optional/native and can't be bundled: add it to `package.external`. For path aliases, check `package.tsconfig` points at the tsconfig that defines `paths` (default: `tsconfig.json` next to `nskit.yml`).

**`No matching export` / handler is `undefined`**
: The export in the handler reference doesn't exist. `src/orders.getOrder` needs `export const getOrder` / `exports.getOrder`; a default export is `src/orders.default`. `nskit validate` checks the module exists; a wrong export name fails at invocation with `HandlerNotFound: Handler "..." is not a function`.

**`handler module 'src/x' not found under ...`**
: The module path is relative to `package.source` (default: the directory of `nskit.yml`). nskit tries `.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx` and `index.*`.

**Type errors are not reported by `nskit package`**
: esbuild strips types without checking them. Run `tsc --noEmit` (e.g. in a `beforePackage` hook or in CI).

**Top-level `await` fails to bundle**
: esbuild can't emit top-level await in CommonJS output, which most Node providers use. Move it into the handler (or a lazily-initialised promise).

**The bundle is large / cold starts are slow**
: Each handler module loads lazily, but everything it imports is in the bundle. Check with `package.esbuild: {metafile: true}` and an analyzer, set `package.minify: true`, avoid importing whole SDKs, and on AWS keep `@aws-sdk/*` external (the default). More memory also means more CPU on most clouds.

See [typescript-and-javascript.md](typescript-and-javascript.md) for ESM/CJS, decorators and native modules.

## Configuration

**`unresolved variables: env:FOO`**
: Set the variable, or give a default: `${env:FOO, fallback}`.

**`each event must be a single-key mapping`**
: Write `- http: {path: /x}` and `- queue: jobs` as separate list items, not two keys in one item.

**`route GET /x is used by both 'a' and 'b'`**
: Each `METHOD /path` may belong to one function only (`/x` and `/x/` count as the same path).

**`... does not support nodejs24; use one of: ...`**
: You pinned `runtime:`. Remove it so nskit picks a supported version, or choose one from `nskit providers --json`.

**`Unrecognized key` errors**
: Keys are strict. Check the spelling against the [configuration reference](configuration.md); camelCase and snake_case are both accepted for schema keys.

**Values from a parent file win over my child file**
: Child values beat a parent's `providers.<cloud>` block. Check the [precedence order](configuration.md#precedence-later-wins). Lists replace rather than merge.

## Deploy and state

**State conflicts / "resource already exists" after deploying from another machine**
: The default state lives in `.nskit/` on one machine. Configure `provider.state` with a remote backend (S3 + DynamoDB lock, GCS, `azurerm`, …), then migrate with `nskit tf -- init -migrate-state`.

**Changed nothing but Terraform wants to update the function**
: The artifact is deterministic, so a real diff means a source file, an installed dependency version or `nskit_manifest.json` changed. Compare `.nskit/<provider>-<stage>/build/` between runs.

**AWS: `decomposing request: bufio.Scanner: token too long` / 50 MB limit**
: Keep the default `artifact_upload: s3` (the zip is uploaded once to S3). `direct` sends the zip inline and only suits small bundles.

**Provider plugin downloads are slow in CI**
: Set `TF_PLUGIN_CACHE_DIR` and cache that directory.

## HTTP

**CORS errors in the browser**
: Add `cors: true` (or a `cors:` mapping) to the route. With `allowCredentials: true` the runtime echoes the request's `Origin` instead of `*`, so list explicit `origins`. Preflights are answered by the runtime with 204 (and by API Gateway on AWS).

**405 Method Not Allowed**
: The path matched a route but not the method. The `allow` header lists the valid methods. Use `method: ANY` to accept everything.

**404 locally but works in the cloud (or the other way round)**
: `nskit dev` matches routes exactly, like an API gateway; `GET /__nskit/routes` lists them. Path templates use `{id}` and `{path+}` (last segment only).

**500 with only a request id**
: Look in the provider's logs for that `requestId`. Locally, or temporarily, set `NSKIT_DEBUG=1` to include the error text in the response.

**`Request body is not valid JSON` (400)**
: `event.http.json()` throws `BadRequest` on invalid JSON. Use `event.http.json(fallback)` to get a default instead.

## Local development and tests

**`vi.mock` has no effect**
: Use `LocalRunner.fromConfig(path, { mode: "import" })` (the default): handlers are loaded with `import()` in the test process, so mocks apply. The `bundle` mode (used by the CLI) runs esbuild's copy and ignores mocks.

**State leaks between tests**
: `LocalRunner` sets `NSKIT_*` and your `environment` values on `process.env`. Call `runner.reload()` after changing code or env, and reset module state your handlers keep.

## Provider gotchas

Each [provider page](providers.md) lists its limits. The most common ones:

| Provider | Gotcha |
|---|---|
| aws | `auth: key` isn't supported on HTTP APIs; API Gateway caps integrations at 30 s; `jwt` needs `authorizer.issuer` and `authorizer.audience` |
| gcp | `options.project` is required; event-triggered functions have shorter timeouts than HTTP ones |
| azure | `ARM_SUBSCRIPTION_ID` / `options.subscription_id` required; all functions share one Function App, so `environment` is app-wide |
| cloudflare | V8 isolate: no native addons, Node built-ins only through Workers' Node.js compatibility; `options.account_id` and `CLOUDFLARE_API_TOKEN` required |
| oracle | runs container images: needs an image or Docker to build one |
| tencent | COS bucket names end with your APPID: `uploads-1250000000` |
| huawei | HTTP events need a dedicated API Gateway instance (`options.apig_instance_id`) |
| alibaba / tencent / huawei | `iam.statements` aren't translated; set `iam.role` |

## FAQ

**Do I add `node_serverless_kit` to my function's dependencies at runtime?**
: Install it in your project (`devDependencies` is enough). esbuild bundles the runtime into the artifact; the cloud never installs it.

**Can I keep using cloud SDKs (`@aws-sdk/*`, `@google-cloud/*`)?**
: Yes, but that code becomes cloud-specific. Isolate it behind your own modules. On AWS `@aws-sdk/*` is provided by the Lambda runtime and kept external unless `provider.options.bundle_aws_sdk: true`.

**Can I return AWS-style `{statusCode, body}` objects?**
: Yes, on every provider. See [handlers.md](handlers.md).

**How do I run something nskit doesn't model?**
: Use `functions.<fn>.options`, `provider.options`, and `provider.terraform.extra` with `${tf:...}` references. See [configuration.md](configuration.md#escape-hatches).

**Can I use OpenTofu?**
: Yes: `NSKIT_TERRAFORM_BIN=tofu` or `provider.terraform.binary: tofu`. nskit also falls back to `tofu` when `terraform` isn't on `PATH`.

## Security notes

- 500 responses never include error details unless `NSKIT_DEBUG` is set.
- `.env`, Terraform state and `nskit*.yml` are excluded from `package.include` copies. `.nskit/` is git-ignored.
- `auth: none` routes are public. Embedded workflow orchestrators get a public `POST /workflows/<name>` route unless you set `options.http: false`.
- Created AWS buckets block public access. Prefer least-privilege `iam.statements` over `"*"` resources.
- Keep secrets out of YAML: use `${env:...}` in CI or a secret manager via `${tf:...}`.
- Report vulnerabilities privately (see [SECURITY.md](../SECURITY.md)).
