# 12 · Async handlers and the context

| Function | Shows |
| --- | --- |
| `aggregate` (`GET /aggregate`) | `Promise.all` fan-out, `ctx.logger`, `ctx.waitUntil` for background work |
| `inspect` (`POST /inspect`) | everything in `Event` and `Context`, request headers |
| `metrics` (invoke-only) | reads what the background tasks recorded |
| `batch-job` (every 15 minutes) | `ctx.remainingTimeMs()` to stop before the timeout |

## The context

| Member | Meaning |
| --- | --- |
| `ctx.requestId` | platform request id (or a UUID); put it in error messages |
| `ctx.functionName`, `ctx.service`, `ctx.stage`, `ctx.region`, `ctx.provider` | where this runs |
| `ctx.memoryMb` | configured memory when the platform reports it |
| `ctx.remainingTimeMs()` | milliseconds until the platform stops the invocation, `undefined` if unknown |
| `ctx.env` | environment variables (Workers bindings on Cloudflare) |
| `ctx.logger` | structured JSON logger bound to the function and request |
| `ctx.waitUntil(promise)` | finish work after the response (Cloudflare); awaited before returning elsewhere |
| `ctx.raw` | the native context object, for provider-specific needs |

## Logging

```ts
ctx.logger.info("aggregated", { sources: 3, elapsedMs });
// {"ts":"...","level":"INFO","logger":"nskit.function","message":"aggregated","function":"aggregate",
//  "requestId":"...","provider":"aws","sources":3,"elapsedMs":81}
```

Outside handlers use `getLogger("name", {fields})`. `NSKIT_LOG_LEVEL` (or `LOG_LEVEL`) sets the
threshold, `NSKIT_LOG_FORMAT=text` prints human-readable lines.

## `waitUntil`

On Cloudflare Workers the response is sent immediately and the promise keeps running. On
Lambda, Cloud Functions, Azure, ... a frozen instance would lose the work, so nskit awaits pending
promises before it returns: same code, safe everywhere. Failures are logged, never thrown.

## Run locally

```bash
npm install
npx nskit dev
curl localhost:3000/aggregate
curl -X POST localhost:3000/inspect -H 'x-trace-id: abc' -d '{}'
npx nskit invoke -f metrics
npx nskit invoke -f batch-job
```

## Deploy / switch clouds

```bash
npx nskit deploy
npx nskit deploy --provider gcp
npx nskit deploy --provider cloudflare     # waitUntil runs after the response here
```
