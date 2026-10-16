# Migrating from py-serverless-kit

node-serverless-kit (`nskit`) is the Node.js sibling of [py-serverless-kit](https://github.com/ak9347128658/serverless_kit) (`pskit`). The architecture, the YAML shape, the providers and the Terraform output are the same, so most of a migration is renaming. The handler code has to be rewritten in TypeScript or JavaScript, but the API maps one to one.

## Files and commands

| py-serverless-kit | node-serverless-kit |
|---|---|
| `pip install py-serverless-kit` | `npm install node-serverless-kit` |
| CLI `pskit` (alias `py-serverless-kit`) | CLI `nskit` (alias `node-serverless-kit`) |
| `pskit.yml`, `pskit.yaml`, `serverless_kit.yml`, `serverless_kit.yaml` | `nskit.yml`, `nskit.yaml`, `serverless-kit.yml`, `serverless-kit.yaml` |
| `.pskit/<provider>-<stage>/` | `.nskit/<provider>-<stage>/` |
| `requirements.txt`, `package.requirements`, `pip_args`, `vendor` | `package.json` dependencies, bundled by esbuild; native modules in `package.external`; extra files in `package.include`; build tweaks in `package.esbuild` (see [typescript-and-javascript.md](typescript-and-javascript.md)) |
| `pskit package --skip-deps` | `nskit package --skip-install` (same for `plan` / `deploy`) |
| `pskit invoke -t queue` | `nskit invoke -e queue` |
| `pskit dashboard -d ./project` | `nskit dashboard ./project` (positional directory) |
| `pskit tf -- state list` | `nskit tf state list` |
| `pytest` + `py_serverless_kit.local.LocalRunner` | Vitest/Jest + `LocalRunner` from `node-serverless-kit/testing` (see [local-development.md](local-development.md)) |

## `nskit.yml`

The schema is the same, with **camelCase** keys as the canonical spelling. snake_case keys are still accepted everywhere (`batch_size`, `start_at`, `result_path`, `log_retention_days`, `expose_headers`, choice operators `not_equals` / `is_null` / `is_present`), so you can rename the file and keep the contents while you migrate.

Things that do change:

| pskit | nskit |
|---|---|
| `handler: app.handlers.get_order` (dotted Python module + function) | `handler: src/handlers.getOrder` (file path relative to `package.source`, no extension, then the export name) |
| `runtime: python3.12` | `runtime: nodejs22` (`22`, `node22` and `nodejs22.x` are accepted too) |
| hooks `before_deploy`, `after_package`, ... | `beforeDeploy`, `afterPackage`, ... (snake_case still accepted) |
| `package.include` defaults to every file | `package.include` defaults to nothing: code is bundled from imports, only extra assets need listing |
| workflow retry/catch `errors: [ValueError]` (Python exception class) | the JavaScript error name: `errors: [ValidationError]` (see [workflows.md](workflows.md#retry-and-catch)) |

Unchanged: provider `options:` keys stay snake_case (`subscription_id`, `artifact_bucket`, `apig_instance_id`) for parity, as do keys passed into Terraform resources through `functions.<fn>.options`. `extends:`, `providers:`, `stages:`, `${env:}`, `${opt:}`, `${self:}`, `${file()}` and `${tf:}` work the same way.

## Environment variables

Every `PSKIT_*` variable becomes `NSKIT_*`:

| pskit | nskit |
|---|---|
| `PSKIT_TERRAFORM_BIN` | `NSKIT_TERRAFORM_BIN` |
| `PSKIT_LOG_FORMAT`, `PSKIT_LOG_LEVEL` | `NSKIT_LOG_FORMAT`, `NSKIT_LOG_LEVEL` (`LOG_LEVEL` still works) |
| `PSKIT_DEBUG` | `NSKIT_DEBUG` |
| `PSKIT_PROVIDER`, `PSKIT_SERVICE`, `PSKIT_STAGE`, `PSKIT_REGION`, `PSKIT_FUNCTION`, `PSKIT_HANDLER` | `NSKIT_PROVIDER`, `NSKIT_SERVICE`, ... |
| hook env `PSKIT_WORK_DIR` | `NSKIT_WORK_DIR` |

The internal payload envelope is `{"__nskit": ..., "data": ...}` instead of `{"__pskit": ...}`. A pskit and an nskit deployment therefore can't `invoke()` each other through the envelope.

## Handler API

```python
# py-serverless-kit
from py_serverless_kit import Event, Context, NotFound

def get_order(event: Event, ctx: Context):
    order = ORDERS.get(event.http.path_params["id"])
    if order is None:
        raise NotFound("no such order")
    ctx.logger.info("found", extra={"id": order["id"]})
    return order
```

```ts
// node-serverless-kit
import { defineHandler, NotFound } from "node-serverless-kit";

export const getOrder = defineHandler((event, ctx) => {
  const order = ORDERS[event.http!.pathParams.id];
  if (!order) throw new NotFound("no such order");
  ctx.logger.info("found", { id: order.id });
  return order;
});
```

| Python | Node.js |
|---|---|
| `event.http.path_params` | `event.http.pathParams` |
| `event.http.multi_query` | `event.http.multiQuery` |
| `event.http.json(default={})` | `event.http.json({})` |
| `event.http.body` (bytes) | `event.http.body` (`Uint8Array`) |
| `Record` | `EventRecord` |
| `Response`, `Response.json(...)` | `HttpResponse`, `HttpResponse.json(data, status)` |
| `ctx.request_id` | `ctx.requestId` |
| `ctx.remaining_time_ms()` | `ctx.remainingTimeMs()` |
| `ctx.logger.info(msg, extra={...})` | `ctx.logger.info(msg, {...})` |
| `raise BadRequest(...)` | `throw new BadRequest(...)` |
| `BatchResult()`, `result.fail(record)` | `new BatchResult()`, `result.fail(record)`; also `processBatch()` |
| `invoke("fn", payload)` | `await invoke("fn", payload)` |
| `def handler(event)` or `(event, ctx)` | `(event, context)`, sync or `async` |
| `py_serverless_kit.local.LocalRunner(project).invoke(...)` | `(await LocalRunner.fromConfig()).http(...)` / `.invoke(...)` |

Return values map the same way (dict -> JSON, str -> text, `None` -> 204). nskit additionally accepts Lambda-proxy objects and WHATWG `Response`. Full reference: [handlers.md](handlers.md).

## Suggested order

1. Copy `pskit.yml` to `nskit.yml`; change `handler:` references and `runtime:` (or drop `runtime:` to let nskit pick).
2. Port the handlers, keeping function names and routes.
3. Port tests to `LocalRunner` and run `nskit validate` and `nskit workflow run` locally.
4. `nskit deploy --stage migration` next to the pskit stack, compare with `nskit info`, switch traffic, then `pskit remove`.
