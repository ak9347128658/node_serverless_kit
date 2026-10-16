# gcp - Google Cloud Functions (2nd gen)

| | |
|---|---|
| Tier | **beta** (Terraform validated against `hashicorp/google` 6.11 and 8.7; the bundle was run under the real Functions Framework; not yet deployed end to end) |
| Terraform provider | `hashicorp/google >= 6.11` |
| Capabilities | http, schedule, queue, storage, topic, native workflows (Cloud Workflows) |
| Node.js runtimes | `nodejs20` (deprecated by Google 2026-04-30, decommissioned 2026-10-30; nskit warns), `nodejs22` (default), `nodejs24` |
| Max timeout | 3600 s for HTTP functions, 540 s for event-triggered functions |
| Bundle | CommonJS / node, `index.js`; `@google-cloud/functions-framework` is installed by Cloud Build |

## Credentials

Terraform's Google provider uses Application Default Credentials:

```bash
gcloud auth application-default login
# or, for CI / service accounts
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
```

The identity needs permission to manage Cloud Functions, Cloud Run IAM, Cloud Storage, Pub/Sub, Cloud Scheduler,
Workflows, service accounts and project IAM bindings (for example `roles/owner` on a sandbox project, or a matching set
of admin roles).

## Example `nskit.yml`

```yaml
service: orders
provider:
  name: gcp
  region: europe-west1
  runtime: nodejs22
  options:
    project: my-gcp-project                                          # required
    service_account: runtime@my-gcp-project.iam.gserviceaccount.com  # optional runtime identity
    enable_apis: true                                                # optional: manage google_project_service
functions:
  api:
    handler: src/orders.api
    events:
      - http: GET /orders/{id}
      - http: {path: /orders, method: POST, auth: iam}
  worker:
    handler: src/orders.worker
    events:
      - queue: {name: order-jobs, batchSize: 10}
      - storage: {bucket: my-orders-uploads, events: [created], prefix: incoming/, suffix: .csv}
      - schedule: 15 minutes
  nightly:
    handler: src/orders.nightly
    events:
      - schedule: {cron: "0 2 * * *", timezone: Europe/Berlin, input: {full: true}}
workflows:
  fulfil:
    startAt: Charge
    states:
      Charge: {type: task, function: api, retry: [{errors: ["*"], maxAttempts: 3}], end: true}
```

## Provider options (`provider.options`, snake_case)

| Option | Default | Description |
|---|---|---|
| `project` | - (required) | GCP project id; set on the provider block and on every resource. |
| `service_account` | Compute Engine default SA | Runtime identity of every function. `iam.role` (provider or function level) overrides it. |
| `build_service_account` | Google's default | Service account Cloud Build uses (`build_config.service_account`). An email or a full `projects/<p>/serviceAccounts/<email>` name. Useful in projects created after 2024 where the default build account has no permissions. |
| `artifact_bucket` | created | Existing bucket for source uploads instead of `<service>-<stage>-src-<hash>`. |
| `enable_apis` | `false` | Create `google_project_service` for Cloud Functions, Cloud Run, Cloud Build, Artifact Registry, Eventarc, Pub/Sub, Cloud Scheduler, Storage and Workflows (`disable_on_destroy = false`). |
| `ingress` | `ALLOW_ALL` | `ALLOW_ALL`, `ALLOW_INTERNAL_ONLY` or `ALLOW_INTERNAL_AND_GCLB`. |

Per-function `options:` are merged into the `google_cloudfunctions2_function` resource (for example `kms_key_name`). When
you set `service_config` or `build_config` this way, they replace the generated blocks entirely.

## How it is deployed

### Source and build

`nskit package` bundles the code with esbuild into `index.js` and writes a `package.json` with
`"main": "index.js"` and the dependency `@google-cloud/functions-framework` (plus anything in
`package.external`). The zip is uploaded to Cloud Storage (`google_storage_bucket_object`, with the artifact
hash in its name so code changes redeploy). Each function refers to it through
`build_config.source.storage_source`, and Cloud Build installs the dependencies with the Node.js buildpack. Nothing is
installed locally.

### Entry points

The bundle exports and registers two entry points:

- `nskit_http`: an HTTP function `(req, res)`. It reads `req.rawBody`, the URL, the headers and
  `x-forwarded-for`, and writes the response with `res.statusCode`, `setHeader` and `end`.
- `nskit_event`: a CloudEvent function for Pub/Sub and Cloud Storage events.

The generated entry module `require`s `@google-cloud/functions-framework` and registers both names with
`http()` and `cloudEvent()`, so the framework picks the right signature type. The same functions are also plain
exports, so the bundle loads locally even when the framework is not installed.

### One logical function to several Cloud Functions

A Cloud Function (2nd gen) can have only one event trigger, and an event-triggered function cannot serve HTTP. nskit
therefore splits each logical function into:

- `<name>`: the HTTP deployment (`nskit_http`). It is created when the function has `http` events, has no
  triggers at all, is a workflow task (Cloud Workflows calls URLs), or has schedules but no Pub/Sub trigger.
- `<name>-<kind><i>`: one deployment per trigger (`nskit_event`), for example `worker-queue0` or
  `worker-storage0`. A storage event that lists both `created` and `deleted` becomes two deployments. A function
  with exactly one trigger and no HTTP deployment keeps the plain `<name>`.

All deployments share the source and handler, and `NSKIT_FUNCTION` holds the logical name in every one of them.
When a function is split, nskit prints a warning that lists the Cloud Functions it creates. The `nskit` output reports
the first deployment as `id` and the others under `extra`.

### Trigger mapping

| nskit event | GCP implementation |
|---|---|
| `http` | Function URL (`url` / `base_url` in the output). `auth: none` adds an `allUsers` `roles/run.invoker` binding; `auth: iam` requires an identity token. `jwt` / `key` are rejected. The URL serves the function at its root, so the path you see is relative (`/42`), and routes such as `/orders/{id}` still match because route matching tolerates the missing static prefix. |
| `schedule` | `google_cloud_scheduler_job`. It POSTs the `{"__nskit":"schedule","data":<input>}` envelope to the HTTP deployment with an OIDC token from the invoker service account. If the function has no HTTP deployment, it publishes the envelope to the function's first Pub/Sub topic instead. `rate` is converted to cron; `timezone` and `enabled` are supported. |
| `queue` | A Pub/Sub topic (or `existing: true` through a data source), connected by an Eventarc `messagePublished` trigger. GCP has no pull queue with push delivery like SQS, so a queue is a topic. The records are `event.type === "queue"`. |
| `topic` | The same as `queue`, but `event.type === "topic"`. |
| `storage` | A Cloud Storage bucket (or `existing: true`) with an Eventarc `object.v1.finalized` / `object.v1.deleted` trigger. Eventarc does not support `prefix` / `suffix`, so the runtime applies them: non-matching objects are acknowledged and skipped. |
| workflows | `google_workflows_workflow` (native engine). Task states call the function URLs with `http.post` and OIDC auth, sending the `__nskit` workflow envelope. Failures come back as a 500 `{"errorType","cause"}`, which `retry` / `catch` match against. `engine: embedded` uses the `<workflow>-orchestrator` function instead. |

Event deliveries use `RETRY_POLICY_RETRY`: a handler that throws, or a `BatchResult` with failures, makes Eventarc
redeliver the event.

### Resources created

- `google_storage_bucket` (source bucket, plus buckets for non-existing storage events), `google_storage_bucket_object`
- `google_service_account` "invoker": Cloud Scheduler, Eventarc and Cloud Workflows authenticate with it
- `google_cloudfunctions2_function` for each deployment
- `google_cloud_run_service_iam_member`: `roles/run.invoker` for the invoker on every deployment, plus `allUsers` for `auth: none`
- `google_project_iam_member`: `roles/eventarc.eventReceiver` for the invoker, and `roles/pubsub.publisher` for the Cloud Storage service agent (storage events)
- `google_pubsub_topic`, `google_cloud_scheduler_job`, `google_workflows_workflow` (`deletion_protection = false` so `nskit remove` works)
- `google_project_service` for each required API, when `enable_apis: true`
- output `nskit`: `{functions: {name: {id, url?, base_url?, console, extra?}}, workflows: {name: {id, console}}, endpoint: null}`

## Limits and differences

- Event-triggered functions may run for 540 s at most (HTTP functions 3600 s). A longer `timeout` on a function with
  queue, topic or storage events is a validation error.
- Settings that don't apply on GCP produce warnings: `queue.deadLetter` and `queue.fifo` (Eventarc manages the
  subscription) and `topic.filter`. `queue.batchSize` / `batchWindow` have no effect either, because each Pub/Sub
  message is delivered as its own event with one record.
- `iam.statements` are AWS-style and ignored, with a warning. Grant roles to the runtime service account
  (`options.service_account` or `iam.role`) instead.
- A batch with failures fails the whole delivery, since GCP has no partial batch responses.
- Each Cloud Function exposes one URL. There is no shared API gateway, so `endpoint` is `null`, and each HTTP function
  has its own `url`.
- Cloud Workflows applies only the first `retry` rule of a task (with a warning). `retry` / `catch` on `parallel` and
  `map` states are ignored, also with a warning.
- Labels are derived from `tags`: they are lowercased, and characters other than `[a-z0-9_-]` become `_`.
