# tencent - Tencent Cloud Serverless Cloud Function (SCF)

| | |
|---|---|
| Tier | **beta** (Terraform validated against `tencentcloudstack/tencentcloud` 1.83.35; the bundle was run locally with real SCF API Gateway, timer and COS event shapes; not yet deployed end to end) |
| Terraform provider | `tencentcloudstack/tencentcloud >= 1.81.0` |
| Capabilities | http (API Gateway), schedule, storage (COS) |
| Node.js runtimes | `nodejs18` (`Nodejs18.15`), `nodejs20` (`Nodejs20.19`, default) |
| Max timeout | 900 s |
| Bundle | CommonJS / node, `index.js`, handler `index.main_handler` |
| Default region | `ap-guangzhou` |

## Credentials

```bash
export TENCENTCLOUD_SECRET_ID=AKID...
export TENCENTCLOUD_SECRET_KEY=...
# or a tccli profile: provider.options.profile
```

The identity needs permission to manage SCF, API Gateway and COS. Functions run with the role named in `iam.role`
(for example `SCF_QcsRole`).

## Example `nskit.yml`

```yaml
service: orders
provider:
  name: tencent
  region: ap-shanghai
  runtime: nodejs20
  memory: 256                # 64, 128 or a multiple of 128
  options:
    profile: default         # optional tccli profile
    namespace: default       # SCF namespace
  iam:
    role: SCF_QcsRole        # CAM role name (iam.statements are not translated)
functions:
  api:
    handler: src/orders.api
    events:
      - http: GET /orders/{id}
      - http: {path: "/files/{path+}", method: ANY, cors: true}
  ingest:
    handler: src/orders.ingest
    events:
      - storage: {bucket: uploads-1250000000, prefix: incoming/}   # COS buckets need the -<APPID> suffix
  nightly:
    handler: src/orders.nightly
    events:
      - schedule: {cron: "0 2 * * *", input: {full: true}, name: nightly}
```

## Provider options (`provider.options`, snake_case)

| Option | Default | Description |
|---|---|---|
| `profile` | - | tccli profile for the Terraform provider block. |
| `namespace` | `default` | SCF namespace of every function (and of console links). |

Per-function `options:` are merged into `tencentcloud_scf_function` (for example `vpc_id`, `subnet_id`, `layers`,
`cls_logset_id`, `cls_topic_id`, `l5_enable`).

## How it is deployed

### Code and entry point

The esbuild bundle (`index.js`, CommonJS) exports `main_handler` (and `handler`), which SCF calls as
`async (event, context)` with the event already parsed from JSON. The context's `request_id`, `memory_limit_in_mb`,
`time_limit_in_ms` and `tencentcloud_region` populate the portable `Context`.

SCF only re-uploads code when the `zip_file` **path** changes, so `nskit package` copies the artifact to
`.nskit/tencent-<stage>/artifact-<sha256 prefix>.zip` (removing older copies) and points every function at it.
Environment variables go into `environment`; `enable_public_net` is on.

### Trigger mapping

| nskit event | SCF implementation |
|---|---|
| `http` | One `tencentcloud_api_gateway_service` (`http&https`, OUTER) per deployment, one `tencentcloud_api_gateway_api` per route (SCF backend, integrated response, `$LATEST`), and a `tencentcloud_api_gateway_service_release` to the `release` environment. `{name}` segments become PATH parameters; a trailing `{path+}` becomes a prefix route (`/files`). `base_url` / `endpoint` is `https://<outer_sub_domain>/release`. |
| `schedule` | Inline `timer` trigger with a 7-field cron (`0 <min> <hour> <dom> <month> <dow-name> *`; rates are converted to cron). When `input` is set or `enabled: false`, a `tencentcloud_scf_trigger_config` sets `custom_argument` (the `__nskit` envelope) and `enable` (`OPEN` / `CLOSE`). |
| `storage` | `tencentcloud_cos_bucket` (private, unless `existing: true`) plus an inline `cos` trigger per action (`cos:ObjectCreated:*`, `cos:ObjectRemove:*`) with an optional Prefix/Suffix filter. |
| `queue`, `topic` | Not supported (validation error). |

Workflows run on the embedded engine (`<workflow>-orchestrator` function).

### Event shapes the adapter understands

- API Gateway: `{httpMethod, path, headers, body, isBase64Encoded, pathParameters, queryString, queryStringParameters, requestContext: {sourceIp, path, ...}}`.
  `queryString` may be an object (repeated keys as arrays) or raw text.
- Timer: `{Type: "Timer", TriggerName, Time, Message}`; the envelope in `Message` becomes `event.data`.
- COS: `{Records: [{cos: {cosBucket: {name}, cosObject: {key: "/<appid>/<bucket>/<path>", size, meta}}, event: {eventName, eventTime}}]}`;
  the `/<appid>/<bucket>/` prefix is stripped and the key URL-decoded.
- Anything else is an `invoke` event.

The integrated response is `{isBase64Encoded, statusCode, headers, body}`.

### Resources

`tencentcloud_scf_function`, `tencentcloud_scf_trigger_config`, `tencentcloud_api_gateway_service`,
`tencentcloud_api_gateway_api`, `tencentcloud_api_gateway_service_release`, `tencentcloud_cos_bucket`.

### `nskit` output

`functions.<name>` has `id` (function name), `console` and, for HTTP functions, `base_url`. `endpoint` is the
API Gateway release URL.

## Limits and caveats

- HTTP `auth` must be `none`; `PATCH` routes are rejected by API Gateway (use `ANY`).
- COS bucket names must end with the account APPID: `name-1250000000`.
- Memory must be 64, 128 or a multiple of 128 MB.
- `iam.statements` are not translated to CAM policies (warning); set `iam.role`.
- `Nodejs20.19` is listed in the SCF Node.js runtime docs but not yet in the (older) `CreateFunction` API reference;
  pin `runtime: nodejs18` if your region rejects it.
- Changing the inline trigger list makes SCF delete and recreate all of the function's triggers.
