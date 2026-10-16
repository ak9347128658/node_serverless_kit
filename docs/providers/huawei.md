# huawei - Huawei Cloud FunctionGraph

| | |
|---|---|
| Tier | **beta** (Terraform validated against `huaweicloud/huaweicloud` 1.99.0; the bundle was run locally with real APIG, timer, OBS and SMN event shapes; not yet deployed end to end) |
| Terraform provider | `huaweicloud/huaweicloud >= 1.60.0` |
| Capabilities | http (dedicated APIG), schedule, storage (OBS), topic (SMN) |
| Node.js runtimes | `nodejs18` (`Node.js18.15`), `nodejs20` (`Node.js20.15`, default) |
| Max timeout | 900 s |
| Bundle | CommonJS / node, `index.js`, handler `index.handler` |
| Default region | `cn-north-4` |

## Credentials

```bash
export HW_ACCESS_KEY=...
export HW_SECRET_KEY=...
export HW_REGION_NAME=cn-north-4     # or provider.region
# or a hcloud CLI profile: provider.options.profile
```

The identity needs permission to manage FunctionGraph, API Gateway (dedicated instance), OBS and SMN.

## Example `nskit.yml`

```yaml
service: orders
provider:
  name: huawei
  region: ap-southeast-3
  runtime: nodejs20
  options:
    apig_instance_id: 0a1b2c3d4e5f...     # required for http events: an existing dedicated APIG instance
    app: default                          # FunctionGraph application
    enterprise_project_id: "0"            # optional
  iam:
    role: fgs-agency                      # IAM agency the functions use
functions:
  api:
    handler: src/orders.api
    events:
      - http: GET /orders/{id}
      - http: {path: "/files/{path+}", method: ANY, auth: iam, cors: true}
  worker:
    handler: src/orders.worker
    events:
      - storage: {bucket: orders-uploads, suffix: .csv}
      - topic: {name: order-events, existing: true}
  nightly:
    handler: src/orders.nightly
    events:
      - schedule: 2 hours
      - schedule: {cron: "30 6 * * 1", input: {report: weekly}, enabled: false}
```

## Provider options (`provider.options`, snake_case)

| Option | Default | Description |
|---|---|---|
| `apig_instance_id` | - | Dedicated API Gateway instance used for HTTP routes. Required when any function has `http` events. |
| `app` | `default` | FunctionGraph application (`app`) of every function. |
| `profile` | - | Profile for the Terraform provider block. |
| `enterprise_project_id` | - | Enterprise project on the provider block. |

Per-function `options:` are merged into `huaweicloud_fgs_function` (for example `vpc_id`, `network_id`, `depend_list`,
`functiongraph_version`, `max_instance_num`).

## How it is deployed

### Code and entry point

The esbuild bundle (`index.js`, CommonJS) exports `handler`, which FunctionGraph calls as `async (event, context)`
with the event parsed from JSON. The context getters `getRequestID()`, `getRemainingTimeInMilliSeconds()`,
`getMemorySize()` and `getFunctionName()` populate the portable `Context`.

The zip is sent inline (`code_type = "zip"`, `func_code = filebase64("artifact.zip")`). Environment variables are
written as sorted JSON to `user_data`, which FunctionGraph exposes to the function as environment variables.

### Trigger mapping

| nskit event | FunctionGraph implementation |
|---|---|
| `http` | `huaweicloud_apig_group` + `huaweicloud_apig_environment` (`nskit_<stage>`) on the dedicated instance, one `huaweicloud_apig_api` per route (FunctionGraph backend, sync) and an `huaweicloud_apig_api_publishment`. `{name}` segments become PATH parameters; a trailing `{path+}` becomes a `Prefix` match. `auth`: `none` -> `NONE`, `iam` -> `IAM`, `key` -> `APP`. `base_url` / `endpoint` is the group's `sl_domain` (from the `huaweicloud_apig_groups` data source). |
| `schedule` | `TIMER` trigger. `rate` -> `Rate` with `5m` / `2h` / `1d`; `cron` -> `Cron` with a 6-field Quartz expression where day-of-month or day-of-week is `?` (`0 30 6 ? * MON`). `enabled` maps to `ACTIVE` / `DISABLED`; the `__nskit` envelope goes into `additional_information`. |
| `storage` | `huaweicloud_obs_bucket` (private, unless `existing: true`) plus an `OBS` trigger (`ObjectCreated` / `ObjectRemoved`, prefix/suffix). |
| `topic` | `huaweicloud_smn_topic` (or the `huaweicloud_smn_topics` data source with `existing: true`) plus an `SMN` trigger. |
| `queue` | Not supported (validation error). |

Workflows run on the embedded engine (`<workflow>-orchestrator` function).

### Event shapes the adapter understands

- APIG: `{httpMethod, path, headers, queryStringParameters, pathParameters, body, isBase64Encoded, requestContext: {sourceIp, ...}}`.
- Timer: `{trigger_type: "TIMER", trigger_name, time, user_event}`; the envelope in `user_event` becomes `event.data`.
- OBS: `{Records: [{eventName, eventTime, obs: {bucket: {name}, object: {key, size, eTag, sequencer}}}]}` (`s3` is accepted too); keys are URL-decoded.
- SMN: `{record: [{smn: {topic_urn, message_id, message, subject, message_attributes, timestamp}}]}`.
- Anything else is an `invoke` event.

The APIG response is `{statusCode, isBase64Encoded, headers, body}`.

### Resources

`huaweicloud_fgs_function`, `huaweicloud_fgs_trigger`, `huaweicloud_apig_group`, `huaweicloud_apig_environment`,
`huaweicloud_apig_api`, `huaweicloud_apig_api_publishment`, `huaweicloud_obs_bucket`, `huaweicloud_smn_topic`;
data sources `huaweicloud_apig_groups`, `huaweicloud_smn_topics`.

### `nskit` output

`functions.<name>` has `id` (function name), `arn` (function URN), `console` and, for HTTP functions, `base_url`.
`endpoint` is the APIG group's domain.

## Limits and caveats

- HTTP needs an existing dedicated APIG instance; nskit does not create one (they are billed per hour).
- HTTP `auth: jwt` is rejected; use `iam` or `key` (APIG app authentication).
- `iam.statements` are ignored (warning); set `iam.role` to an IAM agency name.
- FunctionGraph also lists a Node.js 22.18 runtime in some regions; nskit does not map `nodejs22` until its runtime
  identifier is confirmed in the API reference.
- The free `sl_domain` of an APIG group is rate-limited and meant for testing; bind a custom domain for production.
