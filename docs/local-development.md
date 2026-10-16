# Local development

None of this needs cloud credentials or Terraform. Locally, handlers run through the **same dispatcher** as in the cloud (routing, CORS, `405`, error mapping, `BatchResult`); only the provider adapter is skipped.

## `nskit dev`: local HTTP server

```bash
nskit dev                                  # http://127.0.0.1:3000
nskit dev --port 8080 --host 0.0.0.0 --env-file .env.local
nskit dev --no-watch                       # no reload on file changes
```

| Flag | Default | |
|---|---|---|
| `--host` | `127.0.0.1` | interface to bind |
| `--port` | `3000` | |
| `--env-file` | `.env` | variables loaded into every invocation |
| `--no-watch` | | don't reload when source files change |

On startup it prints every route:

```
  GET     http://127.0.0.1:3000/hello  -> hello
  GET     http://127.0.0.1:3000/items/{id}  -> get-item
  POST    http://127.0.0.1:3000/__nskit/invoke/<function>?type=invoke|schedule|queue|topic|storage
  POST    http://127.0.0.1:3000/__nskit/workflows/<workflow>
  GET     http://127.0.0.1:3000/__nskit/  (dashboard)
```

| Endpoint | What it does |
|---|---|
| your `http` routes | matched like an API gateway: `{id}` and `{path+}` templates, static segments win over parameters. A known path with the wrong method returns `405`; an unknown path returns `404 {"error": "Not Found", "status": 404, "routes": ["GET /hello", ...]}` |
| `POST /__nskit/invoke/<function>?type=...` | invoke any function with the JSON body as payload. `type` is `invoke` (default; body = `event.data`), `schedule` (body = input; an empty body uses the first schedule's configured `input`), `queue` / `topic` (body = one message or an array of messages), `storage` (body = `{bucket?, key, size?, action?}`, a key string, or an array; empty = `example.txt`). Response `200 {"result": ...}`: an `HttpResponse` is shown as `{status, headers, body}`, a `BatchResult` as `{"batchItemFailures": [{"itemIdentifier": "2"}]}`. A thrown error gives `500 {"errorType", "cause"}`; an unknown function `404 {"error"}` |
| `POST /__nskit/workflows/<workflow>` | run a workflow on the embedded engine; the body is the input. `200 {"status": "SUCCEEDED", "output", "history"}`, or `500 {"status": "FAILED", "error", "cause", "history"}` |
| `GET /__nskit/` | the [dashboard](dashboard.md) for this project (local view) |
| `GET /__nskit/routes` | the routes as JSON: `[{"functionName", "method", "path"}]` |

```bash
curl "http://127.0.0.1:3000/hello?name=Ada"
curl -X POST "http://127.0.0.1:3000/__nskit/invoke/worker?type=queue" -d '[{"job": 1}, {"job": 2}]'
curl -X POST http://127.0.0.1:3000/__nskit/workflows/order-pipeline -d '{"amount": 50}'
```

**Hot reload:** unless `--no-watch` is given, the server watches `package.source` (ignoring `node_modules`, `.nskit`, `.git`, `dist`, `coverage` and other dot directories) and rebuilds the bundle after a change. Requests wait for the rebuild; if it fails, the previous build keeps serving and the error is printed. Changes to the env file at the source root also trigger a reload.

The dev server bundles your project like a deployment (`bundle` mode, see below). Invocations run one at a time, because handlers share `process.env`.

**`.env` format:** `KEY=value` lines, optional `export ` prefix, `# comments` (also trailing ` # comment` on unquoted values), single or double quotes (double quotes expand `\n`, `\r`, `\t`, `\"`). A missing file is ignored.

The common flags (`-c`, `-p`, `-s`, `-r`) select the config, provider and stage as usual; see [cli.md](cli.md).

## `nskit invoke`

Invoke one function locally with a synthetic event.

```bash
nskit invoke -f hello --path "/hello?name=Ada"
nskit invoke -f create-item -d '{"name": "lamp"}'                   # POST route, JSON body
nskit invoke -f create-item -d @events/item.json -H "Authorization: Bearer x"
nskit invoke -f worker -e queue -d '[{"id": 1}, {"id": 2}]'         # two records
nskit invoke -f on-upload -e storage -d '{"bucket": "b", "key": "in/a.csv"}'
nskit invoke -f nightly -e schedule
```

| Flag | |
|---|---|
| `-f <fn>` | function name (required) |
| `-e <type>` | `http`, `invoke`, `schedule`, `queue`, `topic` or `storage` |
| `-d <json\|@file>` | payload: inline JSON or `@path/to/file.json` |
| `--method`, `--path` | HTTP method and path (with query string) |
| `-H` | header `"Name: value"`, repeatable |
| `--env-file` | variables file |

See [cli.md](cli.md#nskit-invoke) for defaults and output format.

## `nskit workflow run`

```bash
nskit workflow run order-pipeline -i '{"amount": 50}' --history
nskit workflow run order-pipeline -i @events/big-order.json --sleep
```

Runs the workflow on the embedded engine with task functions in-process. See [workflows.md](workflows.md#commands).

## Environment

Local runs set:

| Variable | Value |
|---|---|
| `NSKIT_PROVIDER` | `local` |
| `NSKIT_SERVICE`, `NSKIT_STAGE` | from the config |
| `NSKIT_REGION` | the provider's region (configured or default) |
| `NSKIT_FUNCTION`, `NSKIT_HANDLER` | the function being invoked |

On top of these come `provider.environment`, the function's `environment`, and the `--env-file` (default `.env`). Keep `.env` out of git; it is also excluded from deployment artifacts.

`invoke()` between functions runs in-process locally. Logs use the readable `text` format by default (`NSKIT_LOG_FORMAT=json` switches back).

## Testing with `LocalRunner`

`node-serverless-kit/testing` exports `LocalRunner`, which loads `nskit.yml` and drives your handlers in-process:

```ts
// tests/handlers.test.ts
import { describe, expect, it } from "vitest";
import { LocalRunner } from "node-serverless-kit/testing";

const runner = await LocalRunner.fromConfig("nskit.yml");

describe("api", () => {
  it("says hello", async () => {
    const res = await runner.http("GET", "/hello?name=Ada");
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ message: "Hello, Ada!" });
  });

  it("validates input", async () => {
    const res = await runner.http("POST", "/items", { json: { name: "" } });
    expect(res.status).toBe(400);
  });

  it("reports failed queue records", async () => {
    const result = await runner.queue<{ failed: string[] }>("worker", [{ ok: 1 }, "not-json"]);
    expect(result.failed).toEqual(["2"]);
  });

  it("runs the workflow", async () => {
    const { output } = await runner.workflow("order-pipeline", { amount: 5 });
    expect(output).toMatchObject({ charged: true });
  });
});
```

### `LocalRunner.fromConfig(configPath?, options?)`

| Option | Default | |
|---|---|---|
| `mode` | `"import"` | how handler modules are loaded (below) |
| `env` | `{}` | extra environment variables for every invocation |
| `sleep` | no-op | replaces real waiting in workflow `wait` states and retries |
| `provider`, `stage`, `region` | from the config | same as `-p`, `-s`, `-r` |
| `cwd` | `process.cwd()` | where to look for `nskit.yml` when no path is given |

**Loading modes**

- `import` (the default for `LocalRunner`): handler modules are loaded with `import()` in the current process. Under Vitest or Jest your TypeScript is transformed by the test runner and **mocks apply** (`vi.mock`, `jest.mock`). Under plain Node it works for JavaScript projects.
- `bundle` (what the CLI uses): the project is bundled with esbuild exactly like a deployment into `.nskit/local/`, and the bundle's own copy of the runtime is used. Closest to production; mocks don't apply.

### Methods

| Method | Returns |
|---|---|
| `http(method, url, {headers, query, body, json, sourceIp})` | `LocalHttpResponse`: `{status, headers, cookies, body, text, json(), functionName}`. `json` sets the body and `content-type`; `url` may include a query string. Unmatched routes return `404`/`405` without calling a handler |
| `invoke(name, data?)` | the handler's result for an `invoke` event |
| `schedule(name, input?)` | result for a `schedule` event with `event.data = input` |
| `queue(name, messages)` / `topic(name, messages)` | result for a batch. Messages are strings, objects (JSON-encoded) or `{id, body, attributes}`; ids default to `"1"`, `"2"`, ... |
| `storage(name, [{bucket?, key, size?, action?}])` | result for storage records (`bucket` defaults to `local-bucket`, `action` to `created`) |
| `workflow(name, input?)` | `{output, history}`; throws `WorkflowFailed` on failure |
| `routes()` | every HTTP route `{functionName, method, path}`, static routes first |
| `matchRoute(method, path)` | `{route?, pathMatched}` |
| `reload()` | re-load handler code after source changes |

Non-HTTP methods reject when the handler throws, just like the platform would retry.

### Mocking dependencies with Vitest

```ts
import { beforeEach, expect, it, vi } from "vitest";
import { LocalRunner } from "node-serverless-kit/testing";

vi.mock("../src/db.js", () => ({ getOrder: vi.fn(async (id: string) => (id === "1" ? { id } : undefined)) }));

let runner: LocalRunner;
beforeEach(async () => {
  runner = await LocalRunner.fromConfig("nskit.yml", { env: { TABLE_NAME: "test" } });
});

it("returns 404 for unknown orders", async () => {
  expect((await runner.http("GET", "/orders/9")).status).toBe(404);
});
```

`vi.mock` only affects modules loaded through Vitest, so keep the default `mode: "import"`. If your project's `vitest.config.ts` doesn't resolve `node-serverless-kit`, install it as a dev dependency.

### Testing a workflow with stub tasks

Use `WorkflowEngine` directly to test the state machine without real handlers:

```ts
import { WorkflowEngine } from "node-serverless-kit/testing";
import { definitionData, loadConfig } from "node-serverless-kit/api";

const { config } = loadConfig("nskit.yml");
const engine = new WorkflowEngine(definitionData(config.workflows["order-pipeline"]), async (fn, input) => {
  if (fn === "charge") throw Object.assign(new Error("declined"), { name: "PaymentDeclined" });
  return input;
});
await expect(engine.run({ amount: 5 })).rejects.toThrow("PaymentDeclined");
console.log(engine.history);
```

### Other helpers

| Export | |
|---|---|
| `setLogSink((line, level) => ...)` | capture log lines; returns the previous sink |
| `setEnv(values)` / `setEnv(undefined)` | overlay environment variables for `getEnv()` / `ctx.env`, or clear the overlay |
| `Event`, `EventRecord`, `EventType`, `HttpRequest`, `Context` | build events by hand |
| `installBundle`, `execute` | low-level: install a manifest and handler table, then dispatch an event |

A complete project with tests and a CI workflow: [`examples/14-testing`](../examples/14-testing).
