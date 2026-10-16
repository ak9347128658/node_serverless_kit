# IBM Cloud (Code Engine functions)

| | |
|---|---|
| Provider name | `ibm` |
| Tier | beta |
| Terraform | `IBM-Cloud/ibm >= 1.70` (override with `provider.terraform.providerVersion`) |
| Default region | `us-south` |
| Runtimes | `nodejs22` → `nodejs-22` (default), `nodejs24` → `nodejs-24` |
| Max timeout | 120 s |
| Triggers | http |
| Workflows | embedded engine only (`<workflow>-orchestrator` function) |
| Bundle | CommonJS, Node platform, entry `main.js` (package.json `"main": "main.js"`, export `main`) |
| Credentials | `IC_API_KEY` (IBM Cloud API key) |

Every Code Engine function gets its own public HTTPS endpoint; nskit's runtime matches the configured routes inside the function.

## Example

```yaml
service: orders
provider:
  name: ibm
  region: eu-de
  memory: 1024                       # maps to a Code Engine CPU/memory size, see below
  options:
    resource_group: default          # optional: resource group of the provider block
    project_id: 1234abcd-...         # optional: existing Code Engine project (else one is created)
    resource_group_id: abcd...       # optional: resource group of the created project
    visibility: local_public         # managed_domain_mappings: local_public | local_private | local
    # code_reference: icr.io/ns/orders-bundle:1   # code bundle image instead of the inline upload
    # code_secret: my-registry-secret             # secret for a private code_reference
functions:
  api:
    handler: src/api.handler
    concurrency: 10                  # scale_concurrency (1-100)
    events:
      - http: GET /orders/{id}
      - http: POST /orders
    options:                         # merged into ibm_code_engine_function
      scale_down_delay: 30
      visibility: local_private      # per-function managed_domain_mappings
```

## Options

### `provider.options`

| Option | Default | Effect |
|---|---|---|
| `resource_group` | — | `resource_group` in the `provider "ibm"` block |
| `project_id` | — | use an existing Code Engine project instead of creating `ibm_code_engine_project` |
| `resource_group_id` | — | resource group of the created project |
| `visibility` | `local_public` | `managed_domain_mappings` of every function |
| `code_reference` | inline data URL | code bundle (image) reference; replaces the inline zip upload |
| `code_secret` | — | registry secret for a private `code_reference` |

### `functions.<fn>.options`

`visibility` overrides the provider-wide value; everything else is merged as-is into the function's `ibm_code_engine_function` (`scale_down_delay`, `run_compute_resource_token_enabled`, ...), applied last.

## Triggers

| Trigger | Implementation |
|---|---|
| http | the function's own endpoint (`endpoint` attribute); routes are matched by the nskit runtime |
| schedule, queue, storage, topic | not supported (validation error): the Terraform provider has no function event subscriptions |

`auth` other than `none` is a validation error; validate tokens in the handler.

## Resources

`ibm_code_engine_project` (unless `project_id` is set), `ibm_code_engine_function` (one per function, all sharing the same code).

## Artifact and runtime

- The artifact zip holds `main.js` (esbuild bundle exporting `main`), `nskit_manifest.json` and `package.json` (`"main": "main.js"`, plus your `package.external` dependencies installed into `node_modules`).
- By default it is uploaded inline: `code_reference = "data:text/plain;base64,${filebase64("artifact.zip")}"` with `code_binary = true`. Code Engine caps `code_reference` at 1,048,576 characters, i.e. a zip of about 768 KiB; `nskit package` warns when the artifact is larger. Turn off `package.sourcemap`, enable `package.minify`, or build a code bundle image and set `options.code_reference`.
- Request mapping: `__ce_method`, `__ce_path`, `__ce_headers`, `__ce_query` (raw query string) and `__ce_body` become `event.http` (`__ow_*` from IBM Cloud Functions is accepted too). JSON bodies arrive base64-encoded in `__ce_body` and are decoded; text and form bodies are plain; binary bodies are base64. When there is no `__ce_body`, the unfolded parameters (minus query parameters) are rebuilt into a JSON body.
- Responses are `{statusCode, headers, body}`: JSON bodies are returned as objects, `text/*` as strings and every other content type base64-encoded, as Code Engine expects.
- A call without `__ce_method` (direct invocation) or with a `__nskit` envelope body is a non-HTTP event; its result is returned as JSON 200, failures as JSON 500 `{errorType, cause}`.
- Memory maps to Code Engine sizes: ≤512 MB → 0.125 vCPU / 0.5G, ≤1024 → 0.25 / 1G, ≤2048 → 0.5 / 2G, ≤4096 → 1 / 4G.

## Outputs

The `nskit` output lists each function's `function_id`, `url` / `base_url` (its endpoint), the console URL, and `endpoint` (the first http function's URL).

## Limits

- HTTP only; max 120 s; max 4096 MB.
- Node.js 22 (deprecated by IBM from 2026-10-20, end of life 2027-04-30) and Node.js 24.
- Each function has its own URL: `invoke()` between functions needs `NSKIT_ENDPOINT_<NAME>` set to the target's URL.

## See also

- [Code Engine: exchanging data with functions](https://cloud.ibm.com/docs/codeengine?topic=codeengine-fun-exchanging-data-with-functions)
- [`ibm_code_engine_function`](https://registry.terraform.io/providers/IBM-Cloud/ibm/latest/docs/resources/code_engine_function)
