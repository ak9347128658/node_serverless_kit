# Oracle Cloud (OCI Functions)

| | |
|---|---|
| Provider name | `oracle` |
| Tier | experimental |
| Terraform | `oracle/oci >= 6.0` (local name `oci`; override with `provider.terraform.providerVersion`) |
| Default region | `us-ashburn-1` |
| Runtimes | `nodejs20` → `fnproject/node:20`, `nodejs22` → `fnproject/node:22` (default), `nodejs24` → `fnproject/node:24` |
| Max timeout | 300 s |
| Triggers | http (API Gateway), storage (Object Storage + Events) |
| Workflows | embedded engine only (`<workflow>-orchestrator` function) |
| Bundle | CommonJS, Node platform, entry `index.js` + generated `func.js`; `@fnproject/fdk` kept external and installed in the image |
| Credentials | `~/.oci/config` (`oci setup config`), or the provider-block options below; Docker logged in to OCIR (`docker login <region-key>.ocir.io`) when nskit builds the image |

OCI Functions only run **container images**. nskit writes a `Dockerfile`, `func.yaml` and `func.js` next to the bundle in `.nskit/oracle-<stage>/build/`, then either uses a pre-built image (`options.image`) or builds and pushes one with your local Docker (`options.image_repository`), tagged with the first 16 hex characters of the artifact hash, so an unchanged project never rebuilds.

## Prerequisites

- **Docker** with `buildx` (for `--platform`), logged in to the Oracle Container Registry: `docker login <region-key>.ocir.io -u '<namespace>/<user>'` with an auth token. Only needed with `image_repository`.
- An existing **VCN subnet** for the Functions application (and the API Gateway).
- **IAM policies** letting API Gateway and Events call functions (nskit does not create them):

  ```text
  ALLOW any-user to use functions-family in compartment <name> where ALL {request.principal.type = 'ApiGateway'}
  Allow service cloudEvents to use functions-family in compartment <name>
  ```

## Example

```yaml
service: orders
provider:
  name: oracle
  region: eu-frankfurt-1
  runtime: nodejs22
  architecture: x86_64                       # arm64 -> GENERIC_ARM application + linux/arm64 image
  options:
    compartment_id: ocid1.compartment.oc1..aaaa       # required
    subnet_ids: [ocid1.subnet.oc1..aaaa]               # required
    image_repository: fra.ocir.io/mytenancy/orders     # nskit runs docker build + push, OR
    # image: fra.ocir.io/mytenancy/orders:1.0          # use an image you built yourself
    gateway_subnet_id: ocid1.subnet.oc1..bbbb          # optional, default: first of subnet_ids
    gateway_endpoint_type: PUBLIC                      # optional: PUBLIC | PRIVATE
    config_file_profile: DEFAULT                       # optional provider auth
functions:
  api:
    handler: src/api.handler
    events:
      - http: GET /orders/{id}
      - http: {path: "/files/{path+}", method: POST, cors: true}
  ingest:
    handler: src/ingest.handler
    events:
      - storage: {bucket: orders-uploads, events: [created, deleted]}
```

To build the image yourself instead of `image_repository`:

```bash
nskit package -p oracle
docker build --platform linux/amd64 -t fra.ocir.io/mytenancy/orders:1.0 .nskit/oracle-dev/build
docker push fra.ocir.io/mytenancy/orders:1.0
```

## Options

### `provider.options`

| Option | Default | Effect |
|---|---|---|
| `compartment_id` | — (required) | compartment for every resource |
| `subnet_ids` | — (required) | subnets of the `oci_functions_application` |
| `image` | — | pre-built image used by every function (`source_details.image`) |
| `image_repository` | — | OCIR repository; nskit adds a `terraform_data` resource running `docker build` + `docker push` of `<repo>:<artifact hash>` |
| `gateway_subnet_id` | first `subnet_ids` entry | subnet of the API Gateway |
| `gateway_endpoint_type` | `PUBLIC` | `PUBLIC` or `PRIVATE` gateway |
| `config_file_profile`, `auth`, `tenancy_ocid`, `user_ocid`, `fingerprint`, `private_key_path` | — | copied into the `provider "oci"` block |

One of `image` / `image_repository` is required; the validation error prints the manual docker commands.

### `functions.<fn>.options`

Merged as-is into the function's `oci_functions_function` resource (`provisioned_concurrency_config`, `trace_config`, `shape`, ...). Applied last, so it can override anything nskit sets.

## Triggers

| Trigger | Implementation |
|---|---|
| http | one `oci_apigateway_gateway` + `oci_apigateway_deployment` (path prefix `/<service>`), one route per http event with an `ORACLE_FUNCTIONS_BACKEND`; `{path+}` becomes OCI's `{path*}`; routes with `cors` also allow `OPTIONS` (the nskit runtime answers the preflight) |
| storage | `oci_objectstorage_bucket` with `object_events_enabled` (unless `existing: true`) + an `oci_events_rule` with a `FAAS` action. `created` = createobject + updateobject, `deleted` = deleteobject |
| schedule, queue, topic | not supported (validation error) |

- `auth` other than `none` is a validation error: add an API Gateway authentication policy with `provider.terraform.extra`, or check tokens in the handler.
- Events rules cannot filter by `prefix` / `suffix` (warning; filter in the handler). Existing buckets must have *Emit Object Events* enabled (warning).

## Resources

`oci_functions_application`, `oci_functions_function`, `terraform_data` (image build, with `image_repository`), `oci_apigateway_gateway`, `oci_apigateway_deployment`, `oci_objectstorage_bucket`, `oci_events_rule`, `data.oci_objectstorage_namespace`.

## Artifact and runtime

- The build directory contains `index.js` (the esbuild bundle exporting `handler`), `nskit_manifest.json`, `package.json` (`"type": "commonjs"`, dependency `@fnproject/fdk` plus your `package.external` packages), `func.js`, `func.yaml`, `Dockerfile`.
- Dependencies are **not** installed on your machine: the `Dockerfile` runs `npm install --omit=dev` in `fnproject/node:<ver>-dev` and copies `node_modules` into the `fnproject/node:<ver>` runtime image, so native addons are built for Linux.
- `func.js` is the only file that touches the FDK: `fdk.handle((input, ctx) => handler(input, ctx, fdk.rawResult), { inputMode: "buffer" })`. `src/runtime/adapters/oracle.ts` never imports `@fnproject/fdk`.
- Behind API Gateway the adapter reads `Fn-Http-Method`, `Fn-Http-Request-Url` and `Fn-Http-H-*` from the FDK context and answers with `Fn-Http-Status` / `Fn-Http-H-*` response headers. Route matching tolerates the `/<service>` gateway prefix.
- An Object Storage CloudEvent becomes a `storage` event; a `__nskit` envelope becomes `invoke` / `workflow` / `schedule`; anything else is `invoke` with the JSON (or text) body as `event.data`. A failed non-HTTP invocation throws, so Fn reports the call as failed.
- Environment variables are set through the function `config` map.

## Outputs

`nskit info` reads the `nskit` output: function OCIDs, the console URL, `base_url` (gateway deployment endpoint) for http functions, and `endpoint`.

## Limits

- Max timeout 300 s; memory as in OCI (`memory_in_mbs`).
- No schedule / queue / topic triggers; workflows run on the embedded engine (capped by the 300 s timeout). `invoke()` between functions needs `NSKIT_ENDPOINT_<NAME>` (the target's gateway URL).
- Every function uses the same image; `NSKIT_FUNCTION` selects the handler.

## See also

- [Fn Project Node FDK](https://github.com/fnproject/fdk-node)
