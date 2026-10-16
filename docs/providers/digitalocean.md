# DigitalOcean Functions

| | |
|---|---|
| Provider name | `digitalocean` |
| Tier | beta |
| Terraform | no cloud provider plugin: `terraform_data` + `local-exec` running `doctl` |
| Default region | — (set by the namespace) |
| Runtimes | `nodejs18` → `nodejs:18`, `nodejs22` → `nodejs:22` (default), `nodejs24` → `nodejs:24` |
| Max timeout | 900 s |
| Triggers | http (`web: raw`), schedule (scheduled triggers) |
| Workflows | embedded engine only (`<workflow>-orchestrator` function) |
| Bundle | CommonJS, Node platform, entry `index.js` (package.json `"main": "index.js"`, export `main`) |
| Credentials | `doctl auth init` (API token); `doctl` must be on `PATH` |

The DigitalOcean Terraform provider has no resource for Functions, so nskit renders a standard `doctl serverless` project in `.nskit/digitalocean-<stage>/do_project/` and deploys it from a `terraform_data` resource: Terraform decides *when* to redeploy (artifact hash + `project.yml` hash), `doctl serverless deploy` does the upload, and `doctl serverless undeploy --packages <package>` runs on destroy.

## Prerequisites

- [`doctl`](https://docs.digitalocean.com/reference/doctl/how-to/install/) installed and authenticated (`doctl auth init`), with the serverless plugin (`doctl serverless install`).
- A Functions namespace: `doctl serverless namespaces create --label orders --region nyc1`, then `doctl serverless namespaces list` for its id (`fn-...`).
- `npm` on the deploying machine (doctl runs `npm install --production` in each function directory) unless `remote_build: true`.

## Example

```yaml
service: orders
provider:
  name: digitalocean
  memory: 256                                            # 128-1024 MB
  options:
    namespace: fn-00000000-0000-0000-0000-000000000000   # required
    api_host: https://faas-nyc1-2ef2e6cc.doserverless.co  # optional: enables URLs in outputs (doctl serverless status)
    remote_build: false                                  # true = doctl serverless deploy --remote-build
functions:
  api:
    handler: src/api.handler
    events:
      - http: GET /orders/{id}
  report:
    handler: src/report.handler
    events:
      - schedule: {cron: "0 12 * * 1", input: {kind: weekly}}
    options:                                             # merged into the project.yml function entry
      webSecure: false
```

## Options

### `provider.options`

| Option | Default | Effect |
|---|---|---|
| `namespace` | — (required) | namespace connected with `doctl serverless connect` before deploy / undeploy |
| `api_host` | — | namespace API host; when set, `url` / `base_url` / `endpoint` are filled in (`<api_host>/api/v1/web/<namespace>/<package>/<fn>`) |
| `region` | — | used for `NSKIT_REGION` when `provider.region` is not set |
| `remote_build` | `false` | build functions on DigitalOcean (`--remote-build`), needed for native dependencies |

### `functions.<fn>.options`

Merged as-is into the function's entry in `project.yml` (`webSecure`, `parameters`, `limits`, `main`, ...), applied last.

## Triggers

| Trigger | Implementation |
|---|---|
| http | `web: raw` public web function; nskit's runtime matches the routes |
| schedule | a `scheduler` trigger in `project.yml` (`cron` = the standard 5-field expression, `withBody` = the `__nskit` schedule envelope with your `input`). Disabled schedules are left out |
| queue, storage, topic | not supported (validation error) |

- `auth` other than `none` is a validation error: web functions are public (use `webSecure` via `options` or check tokens in the handler).
- Scheduled triggers run in UTC; a non-UTC `timezone` is ignored (warning).

## Resources

One `terraform_data.deploy` resource with two `local-exec` provisioners (deploy on create/replace, undeploy on destroy). Everything else lives in DigitalOcean and is managed by `doctl`.

## Artifact and runtime

- `do_project/project.yml` has one package named `<service>-<stage>` and one function per nskit function (`runtime`, `main: main`, `web`, `limits: {timeout (ms), memory (MB)}`, `environment`, `triggers`).
- Each function directory `do_project/packages/<service>-<stage>/<fn>/` holds a copy of the build: `index.js`, `nskit_manifest.json`, `package.json` (`"main": "index.js"`, `"type": "commonjs"`) and your `package.include` assets. On Windows keep project paths short or enable long paths.
- Request mapping: `event.http.method`, `path`, `headers`, `queryString`, `body` and `isBase64Encoded` become `event.http`. Without a raw body (`web: true` set through `options`) the merged parameters are rebuilt into a JSON body. The `context` gives `activationId` (→ `ctx.requestId`) and `getRemainingTimeInMillis()`.
- Responses are `{statusCode, headers, body}`; binary bodies are base64.
- A scheduled trigger or a `__nskit` envelope becomes a `schedule` / `invoke` / `workflow` event; anything else is `invoke` with the event as `event.data` (failures: JSON 500 `{errorType, cause}`).

## Outputs

The `nskit` output lists `<package>/<fn>` ids, the console URL and, with `api_host`, each http function's URL and the package `endpoint`.

## Limits

- HTTP and schedule only; memory 128–1024 MB; max timeout 900 s.
- Terraform cannot see drift in DigitalOcean: changes made in the control panel are overwritten on the next redeploy only.
- `invoke()` between functions needs `NSKIT_ENDPOINT_<NAME>` set to the target's web URL.

## See also

- [DigitalOcean Functions: Node.js runtime](https://docs.digitalocean.com/products/functions/reference/runtimes/node-js/)
- [project.yml reference](https://docs.digitalocean.com/products/functions/reference/project-configuration/)
