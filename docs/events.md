# Events (triggers)

Each function has a list of `events`. Every entry is a **single-key mapping** whose key is the trigger type: `http`, `schedule`, `queue`, `storage` or `topic`.

```yaml
functions:
  worker:
    handler: src/jobs.process
    events:
      - http: POST /jobs
      - schedule: 15 minutes
      - queue: jobs
      - storage: uploads-bucket
      - topic: job-events
```

A function with no events is *invoke-only*. Workflows, [`invoke()`](handlers.md#invoke) and `nskit invoke` can still call it.

Keys are camelCase (`batchSize`, `exposeHeaders`). snake_case and kebab-case spellings (`batch_size`, `expose-headers`) are accepted too, so py-serverless-kit configs port over as they are. Unknown keys are rejected.

## Support at a glance

This table is a summary only. **See [providers.md](providers.md) for the authoritative, current matrix**, or run `nskit providers`.

| Trigger | aws | gcp | azure | alibaba | oracle | ibm | digitalocean | tencent | huawei | cloudflare | onprem |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `http` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `schedule` | ✓ | ✓ | ✓ | ✓ | – | – | ✓ | ✓ | ✓ | ✓ | ✓ |
| `queue` | ✓ SQS | ✓ Pub/Sub | ✓ Storage Queue | – | – | – | – | – | – | ✓ Queues | ✓ broker / Redis |
| `storage` | ✓ S3 | ✓ GCS | ✓ Blob | ✓ OSS | ✓ Object Storage | – | – | ✓ COS | ✓ OBS | – | ✓ broker / directory / S3 |
| `topic` | ✓ SNS | ✓ Pub/Sub | ✓ Service Bus | ✓ MNS | – | – | – | – | ✓ SMN | – | ✓ broker / Redis |

`nskit validate` reports an error for any trigger the selected provider can't support (`<Provider> does not support \`queue\` events in nskit (supported: ...)`), so nothing half-working gets deployed.

---

## `http`

```yaml
- http: GET /users/{id}          # shorthand "METHOD /path"
- http: /health                  # shorthand with only a path: method GET
- http:
    path: /users                 # default "/"
    method: POST                 # default GET
    cors: true                   # default false; or a mapping (below)
    auth: none                   # none | iam | jwt | key (default none)
    authorizer: {}               # provider-specific auth settings (AWS jwt)
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `path` | string | `/` | a leading `/` is added if missing |
| `method` | `GET` `POST` `PUT` `PATCH` `DELETE` `HEAD` `OPTIONS` `ANY` | `GET` | case-insensitive; `*` means `ANY` |
| `cors` | boolean or [mapping](#cors) | `false` | |
| `auth` | `none` \| `iam` \| `jwt` \| `key` | `none` | support varies by provider (below) |
| `authorizer` | mapping | `{}` | e.g. `{issuer, audience, identitySource, scopes}` for AWS `jwt` |

### Path templates

- `{name}` matches one segment and lands in `event.http.pathParams.name`.
- `{name+}` matches the rest of the path (greedy). It is only allowed as the last segment: `/files/{path+}`.
- Parameter names are identifiers: `{userId}` and `{user_id}` work, `{user-id}` does not.

Two functions can't declare the same `METHOD /path` (a trailing `/` counts as the same path).

The runtime matches routes itself as well, so path params, `405 Method Not Allowed` (with an `allow` header) and `HEAD` on `GET` routes behave the same on clouds without an API gateway (GCP, IBM, DigitalOcean, Cloudflare). Matching tolerates a prefix the platform adds (Azure `/api/...`) or strips (GCP serves `/users/{id}` at `https://.../<function>/7`). Exact matches win over tolerant ones.

### CORS

```yaml
cors:
  origins: ["https://app.example.com"]    # default ["*"]
  methods: [GET, POST]                     # default GET POST PUT PATCH DELETE OPTIONS
  headers: [Content-Type, Authorization]   # default Content-Type Authorization X-Requested-With
  exposeHeaders: []                        # default []
  allowCredentials: false                  # default false
  maxAge: 600                              # seconds, default 600
```

`cors: true` uses all defaults. The runtime answers `OPTIONS` preflights with `204` and adds `Access-Control-*` headers on every cloud. With `allowCredentials: true` (or an explicit `origins` list), the request's `Origin` is echoed back instead of `*` and `Vary: Origin` is set; origins not in the list get no CORS headers. Headers your handler already set are never overwritten. AWS also configures CORS on the HTTP API.

### Auth

| `auth` | Meaning | Supported on |
|---|---|---|
| `none` | public | all providers |
| `iam` | cloud IAM-signed requests | aws (`AWS_IAM`), others per [providers.md](providers.md) |
| `jwt` | JWT authorizer | aws: needs `authorizer.issuer` and `authorizer.audience`; optional `identitySource` (default `$request.header.Authorization`) and `scopes` |
| `key` | API / function key | not on AWS HTTP APIs (validation error); see [providers.md](providers.md) |

Where a provider can't enforce `auth`, validation fails rather than deploying a public endpoint.

---

## `schedule`

```yaml
- schedule: 5 minutes            # shorthand rate
- schedule: "0 3 * * *"          # shorthand cron (anything that isn't a rate)
- schedule:
    rate: 1 hour                 # "<n> minute(s)|hour(s)|day(s)"
    # cron: "30 8 * * 1-5"       # OR standard 5-field cron - exactly one of rate / cron
    input: {report: daily}       # becomes event.data
    timezone: Europe/Berlin      # default UTC
    enabled: true                # default true
    name: morning-report         # optional, used in the resource name
```

| Key | Type | Default |
|---|---|---|
| `rate` | `"<n> minute(s)\|hour(s)\|day(s)"` | – |
| `cron` | 5-field cron: `min hour day-of-month month day-of-week` | – |
| `input` | any JSON value | `null` |
| `enabled` | boolean | `true` |
| `timezone` | IANA zone | `UTC` |
| `name` | string | index of the event |

The handler gets `event.type === "schedule"` and `event.data` set to `input`.

nskit converts the portable syntax to each cloud's dialect (`src/providers/schedule.ts`):

| Dialect | Used for | Example |
|---|---|---|
| EventBridge Scheduler | aws | `rate(5 minutes)`, `cron(0 3 * * ? *)`. Day-of-week is shifted to 1-7 (Sun=1) and `?` inserted. Restricting both day-of-month and day-of-week is an error |
| 5-field cron | gcp, digitalocean, cloudflare | rates become cron: `5 minutes` -> `*/5 * * * *` |
| NCRONTAB (6 fields, seconds first) | azure | `0 */5 * * * *` |
| 6-field cron (seconds first) or `@every 5m` | alibaba, huawei | `0 0 3 * * *` |
| 7-field cron (seconds ... year) | tencent | `0 0 3 * * * *` |

A rate that can't be written as cron on cron-only clouds (for example `7 minutes`) fails: use a divisor of 60 minutes or 24 hours, or a whole number of days up to 31. Whether `timezone` is honoured depends on the cloud (AWS supports it); see [providers.md](providers.md).

---

## `queue`

```yaml
- queue: jobs                    # shorthand
- queue:
    name: jobs
    existing: false              # true = use an existing queue, don't create it
    batchSize: 10                # 1-10000
    batchWindow: 0               # seconds to wait to fill a batch, 0-300
    visibilityTimeout: 120       # seconds; AWS default max(30, 6 x function timeout)
    deadLetter: jobs-dlq         # queue receiving messages after maxReceive failed deliveries
    maxReceive: 5
    fifo: false
```

| Key | Type | Default |
|---|---|---|
| `name` | string, required | – |
| `existing` | boolean | `false` |
| `batchSize` | int 1-10000 | `10` |
| `batchWindow` | int 0-300 | `0` |
| `visibilityTimeout` | positive int | provider default |
| `deadLetter` | string | – |
| `maxReceive` | positive int | `5` |
| `fifo` | boolean | `false` |

The handler gets `event.type === "queue"` and `event.records`, one [`EventRecord`](handlers.md#eventrecord) per message. Return a [`BatchResult`](handlers.md#batchresult-and-processbatch) to retry only the failed messages: AWS reports them as `batchItemFailures`; on other clouds any failure fails the whole delivery so it is retried.

On AWS, `fifo: true` appends `.fifo` to the queue (and dead-letter queue) name and enables content-based deduplication. Options a provider can't apply are reported as warnings or errors; see [providers.md](providers.md).

---

## `storage`

```yaml
- storage: uploads-bucket        # shorthand
- storage:
    bucket: uploads-bucket
    existing: false              # true = the bucket already exists
    events: [created, deleted]   # default [created]
    prefix: incoming/
    suffix: .csv
```

| Key | Type | Default |
|---|---|---|
| `bucket` | string, required | – |
| `existing` | boolean | `false` |
| `events` | non-empty list of `created` \| `deleted` | `[created]` |
| `prefix` | string | – |
| `suffix` | string | – |

Each record has `bucket`, `key`, `size` and `action` (`"created"` or `"deleted"`). On AWS, created buckets block public access, and the filters are native S3 notification filters.

---

## `topic`

```yaml
- topic: order-events            # shorthand
- topic:
    name: order-events
    existing: false
    filter: {type: ["created"]}  # AWS SNS filter policy
```

| Key | Type | Default |
|---|---|---|
| `name` | string, required | – |
| `existing` | boolean | `false` |
| `filter` | mapping | – (AWS: SNS filter policy; elsewhere see [providers.md](providers.md)) |

The handler gets `event.type === "topic"` and one record per message.

---

## The `__nskit` envelope

Payloads nskit itself produces (schedule `input`, workflow task inputs and `invoke()` calls) are delivered as a small JSON envelope:

```json
{"__nskit": "schedule", "data": {"report": "daily"}}
```

The provider adapters unwrap it, so the handler simply sees the right `event.type` (`schedule`, `workflow` or `invoke`) and `event.data`, even on clouds where everything arrives as an HTTP request (GCP, IBM, DigitalOcean, Cloudflare, Oracle). You only need to know about it if you call a deployed function's URL yourself and want it treated as an invocation rather than an HTTP request.
