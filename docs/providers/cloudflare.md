# cloudflare (Cloudflare Workers)

| | |
|---|---|
| **Tier** | beta: `terraform validate` passes against `cloudflare/cloudflare` 5.28, and the built `worker.mjs` is tested locally (`fetch`, `scheduled`, `queue`). It hasn't been deployed to a real account yet. |
| **Terraform provider** | `cloudflare/cloudflare >= 5.28, < 6.0` |
| **Credentials** | `CLOUDFLARE_API_TOKEN`. The token needs *Workers Scripts: Edit*, plus *Workers Routes: Edit* when you use routes or custom domains and *Queues: Edit* when you use queues. |
| **Triggers** | `http`, `schedule`, `queue` |
| **Workflows** | embedded engine: the `<workflow>-orchestrator` Worker runs the task handlers in-process, because every Worker carries the whole bundle |
| **Runtime** | workerd V8 isolates (not Node.js). Node APIs come from the `nodejs_compat` flag. `runtime:` is accepted and ignored. |

JavaScript is native on Workers, so nskit uploads one esbuild bundle as an ES module Worker. There's no shim and no container.

## Example `nskit.yml`

```yaml
service: shop
provider:
  name: cloudflare
  options:
    account_id: 0123456789abcdef0123456789abcdef   # required
    workers_subdomain: my-team        # your <name>.workers.dev, used for URLs in `nskit info`
    workers_dev: true                 # default true: HTTP functions get <script>.<subdomain>.workers.dev
    zone_id: abcdef0123456789abcdef0123456789      # needed for routes / custom domains
    compatibility_date: "2026-01-15"  # default shown
    compatibility_flags: [nodejs_compat]           # default; [] disables Node.js APIs
    observability: true               # Workers Logs (optional)
  environment:
    LOG_LEVEL: info
functions:
  api:
    handler: src/api.handler
    events:
      - http: GET /orders/{id}
      - http: POST /orders
    options:
      route: api.example.com/orders*   # or `routes: [...]`; needs zone_id
      custom_domain: shop.example.com  # optional Workers custom domain
      limits: {cpu_ms: 50}             # any other key is merged into cloudflare_workers_script
      bindings:                        # appended to the generated bindings
        - {name: CACHE, type: kv_namespace, namespace_id: "<kv id>"}
  nightly:
    handler: src/jobs.nightly
    events:
      - schedule: {cron: "0 3 * * 1-5", input: {mode: full}}
  orders-worker:
    handler: src/jobs.consume
    events:
      - queue: {name: orders, batchSize: 50, batchWindow: 5, deadLetter: orders-dlq, maxReceive: 4}
```

YAML keys are camelCase (snake_case is also accepted). Keys under `options:` are snake_case, the same as py-serverless-kit.

## Options

| `provider.options` | Default | Meaning |
|---|---|---|
| `account_id` | required | Cloudflare account ID |
| `workers_subdomain` | none | The account's `workers.dev` subdomain. Terraform can't look it up, so without it the outputs don't include `workers.dev` URLs (you get a warning). |
| `workers_dev` | `true` | Turn on the `workers.dev` URL for HTTP functions. Non-HTTP functions always get it switched off. |
| `zone_id` | none | Zone for `route` / `routes` and `custom_domain` |
| `compatibility_date` | `2026-01-15` | Workers compatibility date |
| `compatibility_flags` | `["nodejs_compat"]` | Workers compatibility flags. If `nodejs_compat` is missing, Node built-ins are bundled as ordinary imports, so esbuild fails at build time. |
| `observability` | `false` | Sets `observability.enabled` (Workers Logs) |

| `functions.<fn>.options` | Meaning |
|---|---|
| `route` / `routes` | Zone route pattern(s), e.g. `api.example.com/*` (needs `zone_id`) |
| `custom_domain` | Hostname served by this Worker (`cloudflare_workers_custom_domain`) |
| `bindings` | Extra Worker bindings (KV, R2, D1, queue producers, ...), appended to the generated ones |
| `invokes` | Names of functions this one calls. Each becomes a `service` binding `NSKIT_BINDING_<NAME>` (Worker-to-Worker, no public URL needed). |
| anything else | Merged into `cloudflare_workers_script`, e.g. `limits`, `placement`, `logpush`, `tail_consumers` |

## Resources

- `cloudflare_workers_script`: one per function, all built from the same `build/worker.mjs` (`content_file` + `content_sha256 = filesha256(...)`, `main_module = "worker.mjs"`). The `NSKIT_FUNCTION` plain-text binding picks the function. Environment variables become `plain_text` bindings, and empty values are skipped.
- `cloudflare_workers_script_subdomain`: `workers.dev` on for HTTP functions, off for everything else.
- `cloudflare_workers_route` and `cloudflare_workers_custom_domain`: optional.
- `cloudflare_workers_cron_trigger`: one per function with schedules.
- `cloudflare_queue`, `cloudflare_queue_consumer`: `existing: true` queues are looked up by name via `data.cloudflare_queues`.
- `functions.<fn>.options.invokes: [other]` adds a `service` binding `NSKIT_BINDING_<OTHER>` to that function's Worker.

The `nskit` output contains `id` (script name), `console` (dashboard link), and `url` / `base_url` for HTTP functions. The URL comes from `workers.dev` when `workers_subdomain` is set, else from the custom domain, else from the first route.

## Trigger mapping

| nskit | Workers | Handler sees |
|---|---|---|
| `http` | `fetch(request, env, ctx)` | `event.http` (body read asynchronously, `sourceIp` from `cf-connecting-ip`, `ctx.requestId` = `cf-ray`). Routing, CORS and 405 come from the nskit dispatcher. |
| `schedule` | Cron Trigger -> `scheduled(controller, env, ctx)` | `event.type = "schedule"`. `event.data` is the schedule's `input`, found by matching `controller.cron` against this function's configured crons. `event.source` is the cron. |
| `queue` | Queues consumer -> `queue(batch, env, ctx)` | One `EventRecord` per message (`id`, `body`, `attributes.attempts`, `attributes.timestamp`). If you return a `BatchResult`, only the failed messages are retried and the rest are acked. If you throw, the whole batch is retried. |
| `invoke()` / workflow task | `fetch` with a JSON `{"__nskit": ...}` body | `event.type = "invoke"` / `"workflow"`. The result comes back as JSON 200, and failures as JSON 500. |

Schedules use Cloudflare's cron dialect, and numeric weekdays are rewritten to `SUN`..`SAT`, because Cloudflare numbers weekdays from `1 = Sunday`. A `rate` is converted to cron. Cron Triggers always run in UTC, so a non-UTC `timezone` is an error. Disabled schedules aren't deployed.

Queue settings map like this: `batchSize` -> `batch_size` (max 100), `batchWindow` -> `max_wait_time_ms` (max 60 s), `maxReceive` -> `max_retries = maxReceive - 1`, and `deadLetter` -> `dead_letter_queue`, which nskit creates unless the queue is `existing`. `fifo` is rejected. `visibilityTimeout` is ignored, with a warning. A queue can have only one Worker consumer.

## Runtime details

- String bindings are installed as environment variables, so `getEnv("X")`, `ctx.env.X` and `process.env.X` (with `nodejs_compat`) all work. Other bindings, such as KV, R2, D1 and services, are on `ctx.raw.env`, for example `await (ctx.raw as any).env.CACHE.get("k")`.
- `ctx.waitUntil(promise)` maps to the Workers `ctx.waitUntil`, so the work keeps running after the response is sent.
- Bundle: ESM, esbuild `platform: browser`, conditions `workerd`, `worker`, `browser`. With `nodejs_compat`, `node:*` and the bare Node built-ins stay external, so workerd provides them.

## Limits

- **CPU time:** 10 ms per request on the Free plan. On paid plans the default is 30 s, configurable up to 5 min with `options.limits.cpu_ms`. Wall-clock time isn't limited while the client stays connected. Cron Triggers may run up to 15 min. nskit caps `timeout` at 900 s, and the embedded workflow engine runs inside one orchestrator invocation, so long workflows are bounded by these limits.
- **Memory:** 128 MB per isolate. A `memory` setting is ignored, with a warning.
- **Bundle size:** 3 MB compressed (Free) or 10 MB (paid) per Worker. Only `worker.mjs` is uploaded. `package.include` assets aren't available at run time (you get a warning), and `package.external` is rejected because there's no `node_modules`. Source maps aren't uploaded.
- **Node.js compatibility:** many `node:*` modules work under `nodejs_compat` (crypto, buffer, stream, events, util, async_hooks, ...). Some are stubs, like `fs` (virtual), `child_process` and `net` (limited). Native addons never work.
- **Auth:** HTTP `auth` must be `none`. Validate tokens in your handler or put Cloudflare Access in front.
- **`invoke()`:** set `NSKIT_ENDPOINT_<NAME>` to the target's URL, the same as on other HTTP-only clouds. Workflows don't need this. To call a function without exposing it publicly, list it in `options.invokes` and call `invokeViaBinding(name, payload)` from `runtime/adapters/cloudflare.ts`. `invoke()` uses the binding automatically once the runtime wires it in.
