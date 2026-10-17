# 18 · On-premises

One Node.js process serves every function. HTTP is that process. Schedules are timers in it.
Queues, topics and object storage use a broker that deploys with the service, unless `nskit.yml`
names a service you already run.

```bash
npm install
npx nskit validate
npx nskit deploy                  # engine: process (default). Needs Node.js and Terraform.
curl http://127.0.0.1:8080/health
curl -X POST http://127.0.0.1:8080/jobs -H "content-type: application/json" -d "{\"kind\":\"email\"}"
npx nskit remove
```

`nskit dev` runs the handlers locally without Terraform. `POST /jobs` accepts the message on an
in-memory bus. The deployed process delivers that message to `worker`.

## Use a service you already have

```yaml
provider:
  name: onprem
  options:
    queue: redis://127.0.0.1:6379
    topic: http://127.0.0.1:7700     # `node node_modules/node_serverless_kit/src/onprem/broker.mjs`
    storage: dir:./data/objects      # or storage_endpoint: http://127.0.0.1:9000
    storage_access_key: nskit
    storage_secret_key: change-me
```

`redis` and `minio` (the words, not URLs) mean "start a container". That needs `engine: docker`
and a Docker daemon. `builtin` (the default when a trigger needs it) keeps the data next to the
Terraform state, under `.nskit/onprem-<stage>/onprem/data`.

## What the deploy starts

| Trigger | Nothing named in options | You name a service | `engine: docker` |
|---|---|---|---|
| http | the Node process | — | the same process in a container |
| schedule | a timer in that process | — | the same timer |
| queue | built-in broker | `redis://` or `http://` | `queue: redis` starts Redis |
| topic | built-in broker | `redis://` or `http://` | `topic: redis` shares that Redis |
| storage | built-in broker | `dir:`, `file://`, or `storage_endpoint` | `storage: minio` starts MinIO |
| workflow | embedded engine in the process | — | the same engine |
| invoke() | in-process, unless `NSKIT_ENDPOINT_<NAME>` is set | — | the same |

Handlers publish with `sendMessage`, `publishEvent`, `putObject` and `deleteObject`. On this
provider those calls hit the broker in the same process. Set `NSKIT_QUEUE_URL`, `NSKIT_TOPIC_URL`
or `NSKIT_STORAGE_URL` when the broker is on another machine.
