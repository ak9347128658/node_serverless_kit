# Handler API

A handler is a function `(event, context) => result`, synchronous or `async`. Everything it needs comes from `node-serverless-kit`, which has no dependencies and runs on Node.js and in V8 isolates (Cloudflare Workers). The same code runs unchanged on every provider.

```ts
// src/orders.ts
import { defineHandler, NotFound, HttpResponse, type Event, type Context } from "node-serverless-kit";

const ORDERS: Record<string, { id: string; amount: number }> = { "1": { id: "1", amount: 42 } };

export const getOrder = defineHandler(async (event, ctx) => {
  const id = event.http!.pathParams.id;
  const order = ORDERS[id];
  if (!order) throw new NotFound(`order ${id} not found`);   // -> 404 JSON
  ctx.logger.info("order loaded", { id });
  return order;                                               // -> 200 JSON
});

export async function createOrder(event: Event, ctx: Context) {
  const body = event.http!.json<{ amount: number }>();       // 400 on invalid JSON
  return HttpResponse.json({ id: "2", ...body }, 201);
}
```

```yaml
functions:
  get-order:
    handler: src/orders.getOrder
    events: [{http: GET /orders/{id}}]
```

## Handler references

`handler:` is `<module path>.<export>`. The module path is relative to `package.source` (default: the directory of `nskit.yml`) and has no extension.

| Reference | Loads |
|---|---|
| `src/orders.getOrder` | named export `getOrder` of `src/orders.ts` (or `.mts .cts .tsx .js .mjs .cjs .jsx`) |
| `src/index.default` | the default export |
| `src/api.default` with `module.exports = fn` | the CommonJS function itself |
| `lib/api.handlers.list` | `handlers.list` from `lib/api` (nested export path) |
| `src/orders` directory + `src/orders.getOrder` | `src/orders/index.ts` |
| `src/orders.service.list` | `list` from `src/orders.service.ts` (dots in file names work; the longest existing module path wins) |

Each handler module is imported lazily the first time its function is invoked, so a shared bundle only pays for the modules it uses.

## TypeScript, JavaScript, ESM and CommonJS

Any of these works; esbuild bundles them all (see [typescript-and-javascript.md](typescript-and-javascript.md)).

```ts
// TypeScript, ESM
import type { Event, Context } from "node-serverless-kit";
export async function hello(event: Event, ctx: Context) {
  return { message: `Hello, ${event.http?.query.name ?? "world"}!` };
}
```

```js
// JavaScript, ESM (src/hello.mjs, or .js in a "type": "module" package)
import { BadRequest } from "node-serverless-kit";
export const hello = async (event) => {
  if (!event.http.query.name) throw new BadRequest("name is required");
  return { message: `Hello, ${event.http.query.name}!` };
};
```

```js
// JavaScript, CommonJS (src/hello.cjs, or .js without "type": "module")
const { HttpResponse } = require("node-serverless-kit");
exports.hello = async (event, ctx) => HttpResponse.text("hi");
// or: module.exports = async (event) => "hi";   -> handler: src/hello.default
```

### `defineHandler` and `Handler`

```ts
type Handler<TResult = HandlerResult> = (event: Event, context: Context) => TResult | Promise<TResult>;
function defineHandler<TResult>(fn: Handler<TResult>): Handler<TResult>;   // identity; gives full type inference
```

`HandlerResult` is `HttpResponse | BatchResult | string | Uint8Array | object | number | boolean | null | void`.

---

## `Event`

| Field | Type | Notes |
|---|---|---|
| `type` | `EventType` | `"http"` `"schedule"` `"queue"` `"storage"` `"topic"` `"invoke"` `"workflow"` |
| `provider` | string | `aws`, `gcp`, ... or `local` |
| `functionName` | string | logical function name from `nskit.yml` |
| `http` | `HttpRequest \| undefined` | set for HTTP events |
| `records` | `EventRecord[]` | queue / topic / storage messages (`[]` otherwise) |
| `data` | `unknown` | schedule `input`, workflow state input, `invoke()` payload |
| `time` | `Date` | event time (now if unknown) |
| `source` | `string \| undefined` | e.g. `aws.scheduler`, `local:queue` |
| `raw` | `unknown` | untouched native payload, for provider-specific needs |

| Member | |
|---|---|
| `isHttp` | `type === "http"` |
| `isBatch` | `type` is `queue`, `topic` or `storage` |
| `json<T>(fallback?)` | HTTP: parsed body; batch: first record's body; otherwise `data` |
| `for (const r of event)` | iterates `records` |
| `toJSON()` | short summary for logging |

`EventType` is also an object: `EventType.HTTP`, `EventType.QUEUE`, ...

### `HttpRequest`

| Field / member | Type | Notes |
|---|---|---|
| `method` | string | upper case |
| `path` | string | request path, without query string |
| `headers` | `Headers` | case-insensitive |
| `query` | `Record<string, string>` | last value wins for repeated keys |
| `multiQuery` | `Record<string, string[]>` | every value |
| `pathParams` | `Record<string, string>` | from `{name}` / `{name+}` templates |
| `body` | `Uint8Array` | raw bytes (base64 already decoded) |
| `sourceIp` | `string \| undefined` | |
| `route` | `string \| undefined` | the matched pattern, e.g. `/orders/{id}` |
| `contentType` | string | lower-case media type without parameters |
| `cookies` | `Record<string, string>` | parsed `Cookie` header |
| `text()` | string | body as UTF-8 |
| `json<T>(fallback?)` | `T` | throws `BadRequest` (400) on empty or invalid JSON unless `fallback` is given |
| `form()` | `Record<string, string>` | `application/x-www-form-urlencoded` body |

### `Headers`

A read-only, case-insensitive map. Multi-value headers are joined with `", "`. Methods: `get(name, fallback?)`, `has(name)`, `size`, `keys()`, `entries()`, iteration, `toObject()`, `toJSON()`.

### `EventRecord`

| Field / member | Notes |
|---|---|
| `id` | message id; what `BatchResult.fail()` reports |
| `body` | message body (string, bytes or already-parsed object) |
| `attributes` | message attributes / metadata |
| `source` | e.g. queue or topic identifier |
| `bucket`, `key`, `size`, `action` | storage events only; `action` is `"created"` or `"deleted"` |
| `raw` | native record |
| `text()` | body as text (objects are JSON-encoded) |
| `json<T>(fallback?)` | parsed body; throws `BadRequest` on invalid JSON unless `fallback` is given |

---

## `Context`

| Field / member | Notes |
|---|---|
| `requestId` | platform request id (random UUID if none) |
| `functionName`, `provider`, `service`, `stage`, `region` | |
| `memoryMb` | when the platform reports it |
| `deadline` | epoch ms when the platform stops the invocation, if known |
| `remainingTimeMs()` | ms left, or `undefined` when unknown |
| `env` | environment variables (`process.env` on Node, bindings on Cloudflare) |
| `logger` | structured logger bound to `function`, `requestId`, `provider` |
| `waitUntil(promise)` | keep work running after the response (see below) |
| `raw` | untouched native context |

**`waitUntil`**: on platforms with native support (Cloudflare Workers) the promise is handed to the platform and the response is sent immediately. Everywhere else the promise is awaited *before* the invocation finishes, so the work is never cut off when the function freezes. Rejections are logged, not thrown.

```ts
export const track = defineHandler(async (event, ctx) => {
  ctx.waitUntil(fetch("https://analytics.example.com/hit", { method: "POST" }));
  return { ok: true };
});
```

---

## Return values

For HTTP events, whatever the handler returns is converted to a response:

| Return value | Response |
|---|---|
| `HttpResponse` | as is |
| `undefined` / `null` | `204 No Content` |
| `string` | `200`, `text/plain; charset=utf-8` |
| `Uint8Array` / `ArrayBuffer` | `200`, `application/octet-stream` |
| `{statusCode, body?, headers?, multiValueHeaders?, isBase64Encoded?, cookies?}` (only these keys, `statusCode` a number) | that response, AWS Lambda proxy style, to ease migration. A non-string `body` is JSON-encoded |
| WHATWG `Response` (`new Response(...)`, `Response.json(...)`) | status, headers, `Set-Cookie` and body copied |
| anything else (object, array, number, boolean) | `200`, `application/json` |

JSON encoding also handles `bigint` (number when safe, else string), `Map` (object), `Set` (array) and `Uint8Array` (UTF-8 text, or base64 when not valid UTF-8).

For non-HTTP events the raw result is returned to the platform (and to `invoke()` callers or workflows).

### `HttpResponse`

```ts
new HttpResponse(status = 200, body?, headers = {}, cookies = [])

HttpResponse.json(data, status = 200, headers = {})
HttpResponse.text(text, status = 200, headers = {})
HttpResponse.html(html, status = 200, headers = {})
HttpResponse.binary(bytes, contentType = "application/octet-stream", status = 200, headers = {})
HttpResponse.redirect(location, status = 302)
HttpResponse.noContent()                       // 204

resp.setHeader(name, value)                    // chainable; name is lower-cased
resp.setCookie(name, value, options?)          // chainable
```

`setCookie` options (`CookieOptions`): `maxAge`, `expires`, `path` (default `/`), `domain`, `httpOnly` (default `true`), `secure` (default `true`), `sameSite` (`Strict` | `Lax` | `None`, default `Lax`). The value is URL-encoded.

```ts
return HttpResponse.json({ ok: true }).setHeader("cache-control", "no-store").setCookie("session", token, { maxAge: 3600 });
```

---

## Errors

Throw an `HttpError` subclass to return a JSON error response:

| Class | Status |
|---|---|
| `BadRequest` | 400 |
| `Unauthorized` | 401 |
| `Forbidden` | 403 |
| `NotFound` | 404 |
| `MethodNotAllowed` | 405 |
| `Conflict` | 409 |
| `UnprocessableEntity` | 422 |
| `TooManyRequests` | 429 |
| `ServiceUnavailable` | 503 |
| `HttpError` | 500, or any `status` |

```ts
throw new UnprocessableEntity("invalid order", { details: { field: "amount" } });
// -> 422 {"error": "invalid order", "status": 422, "details": {"field": "amount"}}

throw new HttpError("payment required", { status: 402, headers: { "retry-after": "60" } });
```

`HttpErrorOptions`: `status`, `details` (added to the body), `headers` (added to the response), `cause`. The message defaults to the status text (`"Not Found"`). The body is `err.toBody()`: `{error, status, details?}`.

Any other thrown value becomes `500 {"error": "Internal Server Error", "status": 500, "requestId": "..."}` and is logged with its stack trace. Clients never see exception details unless `NSKIT_DEBUG=1` is set, which adds `detail: "<name>: <message>"`.

For **non-HTTP events** errors propagate unchanged, so the platform's retry and dead-letter behaviour applies.

`isHttpError(value)` is an `instanceof` check that also works when two copies of the library are loaded. `NskitError` is the base of errors raised by nskit itself; `HandlerNotFound` means the configured handler is not in the bundle.

---

## `BatchResult` and `processBatch`

Queue, topic and storage events can carry many records. Return a `BatchResult` to report which ones failed:

```ts
import { BatchResult, defineHandler } from "node-serverless-kit";

export const worker = defineHandler(async (event) => {
  const result = new BatchResult();
  for (const record of event.records) {
    try {
      await handle(record.json());
    } catch {
      result.fail(record);           // or result.fail(record.id)
    }
  }
  return result;
});
```

Or let `processBatch` run the loop, optionally concurrently:

```ts
import { processBatch } from "node-serverless-kit";

export const worker = defineHandler((event, ctx) =>
  processBatch(event.records, (r) => handle(r.json()), {
    concurrency: 5,
    onError: (r, err) => ctx.logger.warn("record failed", { id: r.id, error: err }),
  }),
);
```

| Provider | Behaviour |
|---|---|
| aws | partial failure: becomes `batchItemFailures`, only failed SQS messages are retried |
| local (`nskit invoke`, `LocalRunner`) | the `BatchResult` is returned so you can inspect `failed` |
| every other provider | any failure throws `BatchFailure` (with `failedIds`), so the whole delivery is retried |

`BatchResult` members: `fail(recordOrId)`, `BatchResult.of(iterable)`, `failed` (ids), `ok`, `throwIfFailed()`, `toJSON()`.

---

## `invoke()`

Call another function of the same service and get its result, on any cloud:

```ts
import { invoke } from "node-serverless-kit";

const invoice = await invoke<{ id: string }>("billing", { orderId: 1 });
await invoke("audit", { orderId: 1 }, { async: true });   // fire and forget
```

`InvokeOptions`: `async` (resolve immediately with `undefined`), `timeoutMs` (HTTP invocations, default 30000), `headers` (HTTP invocations). The target receives `event.type === "invoke"` and `event.data`.

How the call is made, in order:

| Condition | Mechanism |
|---|---|
| `NSKIT_ENDPOINT_<NAME>` is set in the caller's environment | HTTP `POST` to that URL (any provider). `<NAME>` is the function name upper-cased with non-alphanumerics as `_`: `billing-v2` -> `NSKIT_ENDPOINT_BILLING_V2` |
| local (`nskit dev`, `nskit invoke`, `LocalRunner`) | in-process through the dispatcher |
| aws | `lambda:InvokeFunction` with `@aws-sdk/client-lambda` from the Lambda runtime (grant the permission with `iam.statements`) |
| gcp | authenticated HTTPS call with an ID token from the metadata server |
| any other provider | throws `InvokeError`: give the target an `http` event and set `NSKIT_ENDPOINT_<NAME>` to its URL (from `nskit info`) |

Failures (non-2xx, timeouts, a failed Lambda) reject with `InvokeError`.

---

## Logging

```ts
ctx.logger.info("order created", { orderId, amount });
ctx.logger.error("charge failed", { error: err });       // Error objects are serialized with stack

import { getLogger } from "node-serverless-kit";
const log = getLogger("billing").child({ tenant: "acme" });
log.debug("cache miss");
```

`Logger` has `debug`, `info`, `warn`, `error` (each `(message, fields?)`) and `child(fields)`. Logging never throws.

Output is one JSON line per call, on `console.log` / `console.warn` / `console.error`, which every platform's log pipeline captures:

```json
{"ts":"2026-10-15T08:00:00.000Z","level":"INFO","logger":"nskit.function","message":"order created","function":"create-order","requestId":"...","provider":"aws","orderId":"7","amount":42}
```

| Variable | Effect |
|---|---|
| `NSKIT_LOG_LEVEL` (or `LOG_LEVEL`) | `debug`, `info` (default), `warn`, `error` |
| `NSKIT_LOG_FORMAT` | `json` (default) or `text` (human readable; the local CLI uses this) |

The dispatcher logs one `request` line per HTTP request (method, path, status, duration) and logs handler failures.

## Environment

```ts
import { env, getEnv } from "node-serverless-kit";

const table = getEnv("TABLE_NAME", "orders-dev");   // fallback when unset or empty
const all = env();                                  // same object as ctx.env
```

Use these instead of `process.env` in code that should also run on Cloudflare Workers, where variables are per-request bindings. Every deployed function also gets `NSKIT_PROVIDER`, `NSKIT_SERVICE`, `NSKIT_STAGE`, `NSKIT_REGION`, `NSKIT_FUNCTION` and `NSKIT_HANDLER`.

## Other exports

| Export | |
|---|---|
| `VERSION`, `AUTHOR` | library version and author |
| `WorkflowFailed` | thrown by the embedded workflow engine (`error`, `cause`, `history`); see [workflows.md](workflows.md) |
| `HandlerNotFound`, `NskitError` | see [Errors](#errors) |
| `BatchFailure`, `InvokeError` | see above |

Testing helpers (`LocalRunner`, `WorkflowEngine`, `setLogSink`, `setEnv`) live in `node-serverless-kit/testing`; see [local-development.md](local-development.md).
