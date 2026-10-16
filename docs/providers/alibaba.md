# alibaba - Alibaba Cloud Function Compute 3.0

| | |
|---|---|
| Tier | **beta** (Terraform validated against `aliyun/alicloud` 2.0.0; the bundle was run locally with real FC 3.0 HTTP and timer event shapes; not yet deployed end to end) |
| Terraform provider | `aliyun/alicloud >= 1.234.0` (`http_trigger[0].url_internet` needs 1.234.0) |
| Capabilities | http, schedule, storage (OSS), topic (MNS) |
| Node.js runtimes | `nodejs18`, `nodejs20` (default). FC 3.0 has no Node.js 22/24 built-in runtime yet. |
| Max timeout | 3600 s in nskit (FC allows up to 86400 s; the config schema caps `timeout` at 3600) |
| Bundle | CommonJS / node, `index.js`, handler `index.handler` |
| Default region | `cn-hangzhou` |

## Credentials

The alicloud Terraform provider reads:

```bash
export ALICLOUD_ACCESS_KEY=LTAI...
export ALICLOUD_SECRET_KEY=...
# or a profile from ~/.aliyun/config.json (aliyun CLI)
```

Set `provider.options.profile` to use a named aliyun CLI profile. The identity needs permission to manage Function
Compute, OSS, MNS (Message Service) and RAM roles (for storage/topic triggers).

## Example `nskit.yml`

```yaml
service: orders
provider:
  name: alibaba
  region: cn-shanghai
  runtime: nodejs20
  options:
    profile: default                                  # optional aliyun CLI profile
  iam:
    role: acs:ram::1234567890123456:role/fc-runtime   # RAM role the functions assume (instead of iam.statements)
functions:
  api:
    handler: src/orders.api
    memory: 512
    events:
      - http: GET /orders/{id}
      - http: {path: /orders, method: POST, cors: true}
  worker:
    handler: src/orders.worker
    events:
      - storage: {bucket: orders-uploads-cn, events: [created, deleted], prefix: incoming/, suffix: .csv}
      - topic: {name: order-events, filter: {tag: paid}}
  nightly:
    handler: src/orders.nightly
    events:
      - schedule: 15 minutes
      - schedule: {cron: "0 2 * * 1-5", timezone: Asia/Shanghai, input: {full: true}}
```

## Provider options (`provider.options`, snake_case)

| Option | Default | Description |
|---|---|---|
| `profile` | - | aliyun CLI profile for the Terraform provider block. |

Per-function `options:` are merged into `alicloud_fcv3_function` (for example `vpc_config`, `log_config`, `layers`,
`cpu`, `disk_size`).

## How it is deployed

### Code and entry point

`nskit package` bundles everything with esbuild into `index.js` (CommonJS). The bundle exports `handler`, which FC 3.0
calls as `async (event, context)`. On built-in runtimes FC passes `event` as a **Buffer** holding the raw payload; the
adapter (`src/runtime/adapters/alibaba.ts`) decodes Buffers, strings and plain objects alike, then dispatches to your
handler. The zip is sent inline (`code.zip_file = filebase64("artifact.zip")`). For very large bundles, upload to OSS and
override `code` through the function's `options` (`oss_bucket_name` / `oss_object_name`).

All `NSKIT_*` variables, `provider.environment` and the function's `environment` go into `environment_variables`.
`internet_access` is enabled.

### Trigger mapping

| nskit event | FC 3.0 implementation |
|---|---|
| `http` | One anonymous `http` trigger per function (`trigger_name = "http"`, qualifier `LATEST`) allowing the union of the declared methods (`ANY` = all; `OPTIONS` is added when any route has `cors`). The `fcapp.run` URL is `url` / `base_url` in the output. Routing, 405s and CORS are done by the portable dispatcher. |
| `schedule` | `timer` trigger. `rate` becomes `@every 5m`; `cron` becomes a 6-field expression with a leading `0` seconds field and weekday names (`0 0 12 * * MON-FRI`). A non-UTC `timezone` is prefixed as `CRON_TZ=<tz>`. `enabled` maps to `enable`, and `input` is sent as the `{"__nskit":"schedule","data":...}` payload. |
| `storage` | `alicloud_oss_bucket` (unless `existing: true`) plus an `oss` trigger with `oss:ObjectCreated:*` / `oss:ObjectRemoved:*` and a prefix/suffix filter. OSS invokes the function through a RAM role (`<service>-<stage>-triggers`, `AliyunFCInvocationAccess`). |
| `topic` | `alicloud_message_service_topic` (unless `existing: true`) plus an `mns_topic` trigger with JSON notify format and `BACKOFF_RETRY`; `filter: {tag: x}` becomes `filterTag`. Each notification is one record. |
| `queue` | Not supported (validation error). |

Workflows run on the embedded engine: nskit adds a `<workflow>-orchestrator` function (with its own HTTP trigger).

### Event shapes the adapter understands

- HTTP trigger: `{version: "v1", rawPath, headers, queryParameters, body, isBase64Encoded, requestContext: {http: {method, path, sourceIp}, ...}}`.
  Repeated query keys arrive comma-joined by FC (`"a,b"`) and are kept as one value.
- Timer: `{triggerTime, triggerName, payload}`; the `__nskit` envelope inside `payload` is unwrapped into `event.data`.
- OSS: `{events: [{eventName, eventTime, oss: {bucket: {name}, object: {key, size, eTag}}, responseElements: {requestId}}]}`.
- MNS topic (JSON format): `{TopicOwner, TopicName, MessageId, Message, PublishTime, ...}`.
- Anything else is an `invoke` event (`data` is the parsed JSON, or the raw Buffer when it is not JSON).

The HTTP response is FC's response struct `{statusCode, headers, body, isBase64Encoded}`; binary bodies are base64.
FC takes one string per header, so several cookies are joined into one `set-cookie` value.

### Resources

`alicloud_fcv3_function`, `alicloud_fcv3_trigger`, `alicloud_oss_bucket`, `alicloud_message_service_topic`,
`alicloud_ram_role` + `alicloud_ram_role_policy_attachment`, data source `alicloud_account` (only when OSS/MNS
triggers are used).

### `nskit` output

`functions.<name>` has `id` (function name), `arn` (`function_arn`), `console` and, for HTTP functions, `url` /
`base_url`. `endpoint` is the first HTTP function's URL.

## Limits and caveats

- HTTP `auth` must be `none` (FC signature/JWT auth is not wired up).
- `iam.statements` are not translated to RAM policies (warning); set `iam.role` to an existing RAM role ARN.
- The default `fcapp.run` domain adds `Content-Disposition: attachment` to responses, so browsers download HTML
  instead of rendering it. Bind a custom domain (`alicloud_fcv3_custom_domain` via `provider.terraform.extra`) for web pages.
- Each function has its own `fcapp.run` URL; there is no shared API gateway in front of several functions.
- `concurrency` maps to `instance_concurrency` (requests per instance), not a reserved-concurrency cap.
