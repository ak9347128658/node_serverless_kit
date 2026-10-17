# On-premises

| | |
|---|---|
| Provider name | `onprem` |
| Tier | beta |
| Terraform | `process` (default): built-in `terraform_data` + `local-exec`. `docker`: `kreuzwerker/docker` ~> 3.0 |
| Default region | `local` |
| Runtimes | `nodejs18`, `nodejs20`, `nodejs22` (default), `nodejs24`. One process, so one Node.js version |
| Max timeout | 3600 s |
| Triggers | http, schedule, queue, storage, topic |
| Workflows | embedded engine (`<workflow>-orchestrator` in the same process) |
| Bundle | CommonJS, Node platform, entry `index.js` |
| Credentials | none. Docker engine needs a local Docker daemon |

`nskit deploy --provider onprem` starts every function in one Node.js process on the machine where Terraform runs. HTTP is that process. Schedules are timers in it. A queue, topic or object store that the config does not already name is a broker inside the same process, with its data under `.nskit/onprem-<stage>/onprem/data`. `nskit remove` stops the process. It does not delete that data directory.

## Example

```yaml
service: orders
provider:
  name: onprem
  region: local
  options:
    http_port: 8080          # default
    publish: 127.0.0.1       # address printed as the public URL
functions:
  api:
    handler: src/api.handler
    events:
      - http: POST /orders
  worker:
    handler: src/worker.handle
    events:
      - queue: {name: jobs, batchSize: 10, deadLetter: jobs-dlq, maxReceive: 5}
  hourly:
    handler: src/jobs.hourly
    events:
      - schedule: {cron: "0 9 * * 1-5", timezone: Europe/Berlin, input: {kind: report}}
```

Publish from a handler with the runtime helpers (they call the in-process broker):

```ts
import { publishEvent, putObject, sendMessage } from "node_serverless_kit";

await sendMessage("jobs", { kind: "email" });
await publishEvent("events", { id: "a" }, { type: "created" });
await putObject("uploads", "in/note.txt", "hello");
```

`nskit dev` and unit tests (`NSKIT_PROVIDER=local`) keep those calls on an in-memory bus. On any other provider, call that cloud's SDK instead.

## Options

### `provider.options`

| Option | Default | Effect |
|---|---|---|
| `engine` | `process` | `process` runs Node on this machine. `docker` runs the same supervisor in a container and can start Redis or MinIO |
| `http_port` | `8080` | port the process listens on |
| `http_host` | `0.0.0.0` | bind address inside the process |
| `publish` | `127.0.0.1` | host written into URLs (`http://<publish>:<http_port>`) |
| `queue` | `builtin` when a function has a queue | `builtin`, `redis` (deploy a container; docker only), `redis://` or `rediss://` (you already run it), or `http://` (an nskit broker) |
| `topic` | `builtin` when a function has a topic | same values as `queue` |
| `storage` | `builtin` when a function has storage | `builtin`, `minio` (docker only), `dir:<path>`, `file://<path>`, or an `http://` broker |
| `storage_endpoint` | — | existing S3 or MinIO URL. Requires `storage_access_key` and `storage_secret_key` |
| `storage_region` | `us-east-1` | SigV4 region for that endpoint |
| `minio_user` / `minio_password` | `nskit` / a default that warns | root user for a MinIO container nskit starts |
| `node_image` | `node:22-bookworm-slim` | image for `engine: docker` |
| `redis_image` | `redis:7-alpine` | image when `queue` or `topic` is `redis` |
| `minio_image` | a pinned `minio/minio` release | image when `storage` is `minio` |
| `docker_host` | the daemon's default | `host` for the Docker Terraform provider |
| `api_key` | — | shared secret for `auth: key` (`x-api-key`) and for `POST /__nskit/*` |
| `poll_ms` | `1000` | how often consumers look for work |
| `drop_terraform_extra` | false | skip `terraform.extra` (use this when an AWS-only extra block should not be applied on-premises) |

`redis` and `minio` are deployed only when a function actually uses that trigger.

### Backing services

| Value | Queue / topic | Storage |
|---|---|---|
| omitted or `builtin` | in-process broker, saved as `broker.json` | same broker, objects included |
| `redis` | container `redis`, URL `redis://redis:6379` | rejected |
| `redis://host:port` | your Redis (lists + pub/sub) | rejected |
| `minio` | rejected | container `minio` at `http://minio:9000` |
| `http://host:port` | HTTP broker (`node src/onprem/broker.mjs`) | same |
| `dir:<path>` or `file://` | — | a directory. The first scan is a baseline; later changes are created/deleted events |
| `storage_endpoint` | — | path-style S3. The first list is a baseline |

Set `NSKIT_QUEUE_URL`, `NSKIT_TOPIC_URL` or `NSKIT_STORAGE_URL` when a handler in another process should call that HTTP broker. The deployed process prefers the in-process bus.

## Triggers

| Trigger | Implementation |
|---|---|
| http | the process matches routes. `auth: key` checks `x-api-key` against `options.api_key` or `authorizer.key`. `iam` and `jwt` are errors: check tokens in the handler |
| schedule | `rate(...)` is a timer. Cron is checked once a second and fires once per minute. `timezone` is an IANA name. Disabled schedules are left out |
| queue | built-in, Redis (`BRPOPLPUSH` plus a visibility sweeper) or the HTTP broker. `BatchResult` retries only the failed records. `fifo` is accepted and ignored (order is per queue, not exactly-once) |
| topic | fan-out with the same attribute filter as the other providers. Redis uses `PUBLISH` / `SUBSCRIBE` and filters in the process |
| storage | created and deleted. `existing: true` does not create or delete the bucket |

`invoke()` calls the other function in-process. `NSKIT_ENDPOINT_<NAME>` still wins and performs an HTTP call.

`POST /__nskit/workflows/<name>` and `POST /__nskit/functions/<name>` run a workflow or a direct invoke. `GET /__nskit/health` is open. The two POSTs require `x-api-key` when `api_key` is set.

## Resources

Process engine: one `terraform_data.onprem` resource. Create runs `node onprem/launch.mjs` (detached). Destroy runs `node onprem/stop.mjs`. The artifact hash and `platform.json` hash are `triggers_replace`.

Docker engine: a `docker_network`, a `docker_image` and a `docker_container` for the supervisor, plus Redis and MinIO containers when the options ask for them. The platform hash is an environment variable, so a config change recreates the container. Do not set `network_mode` yourself; the container joins the nskit network, where the names `redis` and `minio` resolve.

## Limits

- One process (or one container) for the whole service. Per-function environment is applied per call, not via `process.env`.
- `functions.<name>.options` is ignored (warning). There is no separate cloud resource to merge it into.
- Partial batch failure works the same way as AWS SQS: return a `BatchResult`.
- A rate that is not a whole number of minutes (for example `7 minutes`) is a timer only. It is not also registered as cron.
