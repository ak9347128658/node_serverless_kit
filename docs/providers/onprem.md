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
| Credentials | none. `deploy: ssh` uses your SSH key. Docker needs a daemon on the machine that runs the containers |

`nskit deploy --provider onprem` runs every function in one Node.js process. HTTP is that process. Schedules are timers in it. A queue, topic or object store that the config does not already name is a broker inside the same process. `nskit remove` stops the process. It does not delete the data directory.

`deploy` chooses where that process is started. The default, `local`, is the machine where Terraform runs. `ssh` copies the build to a server. `bundle` writes a folder you copy yourself. See [How the code gets onto the server](#how-the-code-gets-onto-the-server).

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
| `deploy` | `local` | `local` starts here. `ssh` copies to `host` and starts there. `bundle` writes `.nskit/onprem-<stage>/onprem/bundle/` and does not connect |
| `runtime` | `system` on a local process, `docker` when `engine` is docker, otherwise `auto` | `auto` tries `runtime/node`, then Node.js 18+ on PATH, then Docker. `system` requires Node on PATH. `bundled` copies `node_binary`. `docker` runs the image |
| `node_binary` | — | path to a Node.js 18+ executable, or a directory that contains `bin/node` or `node.exe`. nskit does not download Node. Required for `runtime: bundled` |
| `host` | — | `hostname` or `user@hostname`. Required for `deploy: ssh`. With no `publish`, the URL uses this host |
| `ssh_user` | the user in `host` | SSH account |
| `ssh_port` | `22` | SSH port |
| `ssh_key` | the client's default key | path to a private key. The key text is not copied into Terraform. A leading `~` is expanded |
| `ssh_strict` | false | `true` refuses unknown host keys. The default accepts a new key once (`StrictHostKeyChecking=accept-new`) and never prompts (`BatchMode=yes`) |
| `remote_dir` | `$HOME/nskit/<service>-<stage>` | directory on the server. Absolute, or relative to the SSH user's home. Forward slashes, no spaces |
| `target_os` | `linux` | `windows` runs `start.ps1` over OpenSSH. Set `remote_dir` to `C:/nskit/<service>` when you do not want the profile directory |
| `service` | `process` | `systemd` installs a unit on Linux (`deploy: ssh` or `bundle` only) |
| `systemd_scope` | `user` | `system` copies the unit with passwordless `sudo`. `user` needs a lingering user when SSH has no session (`loginctl enable-linger`) |
| `engine` | `process` | `process` runs Node on this machine. `docker` runs the same supervisor in a container on this machine and can start Redis or MinIO. For Docker on the server, use `runtime: docker` instead |
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

`redis` and `minio` are deployed only when a function actually uses that trigger. On `deploy: ssh` or `bundle` they need `runtime: docker`, because the containers start on the server.

## How the code gets onto the server

The deploy machine is the one that runs `nskit`. It already has Node.js, because the CLI requires it. The server is wherever the process should stay. Pick `deploy` and `runtime` from what that server has.

| Server has | Config |
|---|---|
| Node.js 18+ and you deploy on that same machine | `deploy: local` (default), `engine: process` |
| Docker, and you deploy on that same machine | `engine: docker` |
| Node.js 18+, reached over SSH | `deploy: ssh`, `runtime: system` |
| nothing: no Node.js, no npm, no Python, no Docker | `deploy: ssh` or `bundle`, `runtime: bundled`, `node_binary` set to a binary built for that OS and CPU |
| Docker, but no Node.js | `deploy: ssh` or `bundle`, `runtime: docker` |
| you will carry the files yourself (air gap, USB, an artifact store) | `deploy: bundle` |

`runtime: auto` (the default for `ssh` and `bundle`) tries those in order: the shipped binary, Node.js 18+ on PATH, then Docker. Python is never invoked. npm does not run on the server. esbuild has already bundled the handlers.

`nskit package` writes `onprem/start.sh`, `onprem/start.ps1` and, for `deploy: bundle`, the folder `onprem/bundle/`. `nskit deploy` runs Terraform, which uploads or packs that folder. `NSKIT_FOREGROUND=1 sh platform/start.sh` keeps the process in the terminal.

### SSH

```yaml
provider:
  name: onprem
  options:
    deploy: ssh
    host: ops@10.0.0.8
    ssh_port: 22
    ssh_key: /home/ci/.ssh/id_ed25519
    remote_dir: /opt/nskit/orders
    runtime: system
    publish: 10.0.0.8
```

This machine needs the OpenSSH client (`ssh`) and `tar`. The server needs `tar` and a POSIX shell (`sh`). The copy is a tar stream over SSH, then `sh platform/start.sh`. `nskit remove` runs `platform/stop.sh`. The remote directory and its broker data stay.

### No runtime on the server

```yaml
provider:
  name: onprem
  options:
    deploy: ssh
    host: ops@10.0.0.8
    runtime: bundled
    node_binary: ./third_party/node-v22-linux-x64/bin/node
```

Download the official Node.js archive on a machine that has a network, extract it, and point `node_binary` at `bin/node` (Linux, macOS) or `node.exe` (Windows, with `target_os: windows`). nskit copies that file to `runtime/node` and does not fetch anything during deploy. A binary for the wrong OS or CPU fails at start with a message that says so, and `runtime: auto` then tries Node on PATH and Docker.

### Docker on the server

```yaml
provider:
  name: onprem
  options:
    deploy: ssh
    host: ops@10.0.0.8
    runtime: docker
    node_image: node:22-bookworm-slim
    queue: redis
    storage: minio
    minio_password: choose-a-password
```

The start script creates a Docker network, runs Redis or MinIO when the config asks, and runs the supervisor with the app mounted in. If the image is not loaded it pulls it. An air-gapped server must already have the image, or use `runtime: bundled`. `engine: docker` is a different switch: it starts containers on the machine running Terraform, and it is rejected together with `deploy: ssh`.

### The folder, with no connection

```yaml
provider:
  name: onprem
  options:
    deploy: bundle
    runtime: auto
    publish: app.internal
```

```text
onprem/bundle/
  START.txt
  app/index.js
  platform/start.sh
  platform/start.ps1
  platform/stop.sh
  platform/launch.env
  platform/platform.json
  runtime/node          # only when node_binary is set
```

On the server: `sh platform/start.sh`. On Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File platform/start.ps1`. `nskit remove` deletes this local folder. It cannot stop a process on a server it never connected to.

### systemd

```yaml
provider:
  name: onprem
  options:
    deploy: ssh
    host: ops@10.0.0.8
    runtime: system
    service: systemd
    systemd_scope: user
```

The unit's `ExecStart` is the Node binary the probe selected. Docker is not a systemd service here. `systemd_scope: system` needs passwordless `sudo` for `systemctl`. `user` over SSH needs `loginctl enable-linger` for that account, or the bus is not there and the start script says so.

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

Process engine (`deploy: local`): one `terraform_data.onprem` resource. Create runs `node onprem/launch.mjs` (detached). Destroy runs `node onprem/stop.mjs`. The artifact hash and `platform.json` hash are `triggers_replace`.

`deploy: ssh` uses the same `terraform_data` resource. Create runs `node onprem/push.mjs`, which shells out to `ssh` and `tar`. Destroy runs `push.mjs` with `NSKIT_ACTION=stop`. No SSH Terraform provider is required.

`deploy: bundle` uses `terraform_data` to run `node onprem/pack.mjs`. Render also writes the folder, so `nskit package` produces it before apply.

Docker engine: a `docker_network`, a `docker_image` and a `docker_container` for the supervisor, plus Redis and MinIO containers when the options ask for them. The platform hash is an environment variable, so a config change recreates the container. Do not set `network_mode` yourself; the container joins the nskit network, where the names `redis` and `minio` resolve. `runtime: docker` on a remote server starts the same containers from `start.sh` instead of from the Docker provider.

## Limits

- One process (or one container) for the whole service. Per-function environment is applied per call, not via `process.env`.
- `functions.<name>.options` is ignored (warning). There is no separate cloud resource to merge it into.
- Partial batch failure works the same way as AWS SQS: return a `BatchResult`.
- A rate that is not a whole number of minutes (for example `7 minutes`) is a timer only. It is not also registered as cron.
- `deploy: ssh` does not prompt for a password and does not copy the private key into the bundle. The server needs `tar` and, on Linux, `sh`.
- A bundled Node binary has to match the server. nskit will not download one, and it will not fall back to Python.
- `runtime: auto` does not mount a `dir:` store into Docker. Set `runtime: docker` or `runtime: system` when the only copy of the files is a directory on the host.
- `service: systemd` does not survive on Windows. The Windows start script backgrounds the process and records its pid.
