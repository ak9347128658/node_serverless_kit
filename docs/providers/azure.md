# azure (Azure Functions)

| | |
|---|---|
| Provider name | `azure` |
| Tier | **beta**: `terraform validate` passes against `hashicorp/azurerm` 4.81 and 5.10 for the Consumption, Flex Consumption and Premium layouts. The built bundle has been loaded with the real `@azure/functions` 4.16 and with a fake `app` (registrations plus HTTP, workflow and timer round trips). It hasn't been deployed to a real subscription yet. |
| Terraform | `hashicorp/azurerm >= 4.9` (override with `provider.terraform.providerVersion`) |
| Default region | `eastus` |
| Runtimes | `nodejs20` → `20` (end of support 2026-04-30; nskit warns), `nodejs22` → `22` (default), `nodejs24` → `24` (Flex Consumption or Premium/Dedicated only) |
| Max timeout | 600 s (`host.json` `functionTimeout`, shared by the whole app) |
| Triggers | http, schedule, queue, storage, topic |
| Workflows | embedded engine (`<workflow>-orchestrator` function, `POST /workflows/<name>`) |
| Bundle | CommonJS, Node platform, entry `index.js`; `@azure/functions` ^4.16 is installed into `node_modules` and kept external |
| Credentials | `az login` + `ARM_SUBSCRIPTION_ID`, or a service principal / OIDC: `ARM_CLIENT_ID`, `ARM_CLIENT_SECRET` (or `ARM_USE_OIDC=true`), `ARM_TENANT_ID`, `ARM_SUBSCRIPTION_ID` |

## Example `nskit.yml`

```yaml
service: orders
provider:
  name: azure
  region: westeurope
  runtime: nodejs22
  options:
    subscription_id: ${env:ARM_SUBSCRIPTION_ID}   # required by azurerm >= 4 (or set the env var itself)
    resource_group: existing-rg                   # optional: use an existing resource group
    plan_sku: Y1                                  # Y1 (Linux Consumption, default) | FC1 (Flex Consumption) | EP1, B1, P1v3, ...
    app_insights: true                            # default true: Application Insights + Log Analytics workspace
    storage_connection: OTHER_STORAGE             # app setting name, for `existing` queues/containers in another account
    servicebus_namespace_id: /subscriptions/.../namespaces/my-sb   # for `existing` topics
    servicebus_connection: SB_CONNECTION                          # app setting holding its connection string
    # Flex Consumption (plan_sku: FC1) only:
    # instance_memory_in_mb: 2048                 # 512 | 2048 | 4096; default fits the largest `memory`
    # maximum_instance_count: 100
  environment:
    LOG_LEVEL: info
functions:
  api:
    handler: src/orders.api
    events:
      - http: GET /orders/{id}
      - http: {path: "/files/{path+}", method: ANY, auth: key}
  nightly:
    handler: src/jobs.nightly
    events:
      - schedule: {cron: "0 2 * * *", input: {report: daily}}
  worker:
    handler: src/jobs.work
    events:
      - queue: jobs
      - topic: order-events
  ingest:
    handler: src/jobs.ingest
    events:
      - storage: {bucket: uploads, prefix: in/, suffix: .csv}
```

## How it works

Each service and stage gets one Linux Function App. It uses the Node.js v4 programming model:

- The artifact's `package.json` has `"main": "index.js"`. Importing that bundle registers every trigger. The generated entry runs `register(require("@azure/functions").app, [...])` from `runtime/adapters/azure.ts`. The runtime itself never imports `@azure/functions`, so it stays dependency-free.
- Each trigger becomes one Azure function named `<function>_<type>_<index>`, for example `api_http_0` or `worker_queue_0`. Invoke-only functions are named `<function>_invoke`. The handler dispatches to the logical nskit function by name, because app settings are shared and `NSKIT_FUNCTION` can't be used.
- `host.json` loads extension bundle `[4.*, 5.0.0)` and sets `extensions.http.routePrefix` to `""`. Your paths are served exactly as configured, without `/api`. `{path+}` becomes Azure's `{*path}`.
- `application_stack.node_version` also sets `FUNCTIONS_WORKER_RUNTIME=node` and `WEBSITE_NODE_DEFAULT_VERSION`.

| Trigger | Implementation |
|---|---|
| http | `app.http`. `auth: none` → `anonymous`, `auth: key` → `function` (send `?code=` or `x-functions-key`). `ANY` registers all seven methods. CORS uses the platform CORS in `site_config.cors`. |
| schedule | `app.timer` with NCRONTAB (`0 */5 * * * *`), UTC. `input` arrives as `event.data`. `enabled: false` adds `AzureWebJobs.<name>.Disabled=true`. |
| queue | `app.storageQueue` on a Storage Queue in the app's storage account. One message per invocation. Poison messages go to `<queue>-poison` after `maxReceive` attempts (`host.json` `maxDequeueCount`, app-wide). |
| storage | `app.storageBlob` on a container in the app's storage account, path `<container>/<prefix>{name}<suffix>`. Created/updated blobs only. The blob content is on `record.raw` (a Buffer). |
| topic | `app.serviceBusTopic`. nskit creates a Standard Service Bus namespace and the topic, plus one subscription per function (`max_delivery_count: 10`). The connection string is in app setting `NSKIT_SERVICEBUS`. |

Queue, topic and blob invocations carry one record. A `BatchResult` with failures fails the invocation, and the host retries it.

## Plans and deployment

| `plan_sku` | Resource | Node.js | Deployment |
|---|---|---|---|
| `Y1` (default) | `azurerm_linux_function_app` on Linux Consumption | 20, 22 | `zip_deploy_file` + `SCM_DO_BUILD_DURING_DEPLOYMENT=true` (remote build; Linux Consumption doesn't support `WEBSITE_RUN_FROM_PACKAGE=1`) |
| `FC1` | `azurerm_function_app_flex_consumption` | 20, 22, 24 | `zip_deploy_file` into a `nskit-deployments` blob container |
| `EP1`-`EP3`, `B1`, `S1`, `P1v3`, ... | `azurerm_linux_function_app` | 20, 22, 24 | `zip_deploy_file` + `WEBSITE_RUN_FROM_PACKAGE=1` |

Microsoft is retiring Linux Consumption on 2028-09-30, and it gets no new Node.js versions, so Node 22 is the last one there. Use `FC1` for new services where Flex Consumption is available in your region.

**Resources:** `azurerm_resource_group` (unless `resource_group` is set), `azurerm_storage_account`, `azurerm_service_plan`, `azurerm_linux_function_app` or `azurerm_function_app_flex_consumption`, `azurerm_log_analytics_workspace` + `azurerm_application_insights` (when `app_insights` is on), `azurerm_storage_queue`, `azurerm_storage_container`, `azurerm_servicebus_namespace` / `_topic` / `_subscription`.

**`nskit` output:** `functions.<name>` has `id` (`<app>/<function>`), `console` (portal link), and `base_url`/`url` for HTTP functions. `endpoint` is `https://<app>.azurewebsites.net`.

## Limits

- `auth: iam` and `auth: jwt` aren't supported. Use `key`, or put API Management or Easy Auth in front.
- The root path `/` can't be routed to a function, and paths under `/admin` are reserved by the host. Both are validation errors.
- `environment`, Node.js version, `timeout` and scaling are app-wide. nskit warns when functions set different values for the same variable. `functions.*.runtime` is an error, and `concurrency` is ignored with a warning.
- Timers always run in UTC, so `timezone` is ignored with a warning.
- Blob triggers can't fire on `deleted`. On Flex Consumption, `storage` events are an error: Flex only supports Event Grid blob triggers, which nskit doesn't provision.
- `queue.fifo`, `queue.deadLetter`, `queue.batchSize` and `topic.filter` aren't applied (warnings for the first, second and fourth). Storage Queue triggers expect base64-encoded messages by default.
- `iam.statements` are ignored. Grant access with Azure RBAC on the app's identity, or use connection strings in `environment`.
- Invoke-only functions get `POST /_nskit/invoke/<name>` with a function key. `invoke()` from another function needs `NSKIT_ENDPOINT_<NAME>` set to that URL, including `?code=<key>`. Workflow tasks run in-process and don't need it.
