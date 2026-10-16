# 14 · Testing

Unit and integration tests for serverless handlers with Vitest, without any cloud access.

| Test file | Technique |
| --- | --- |
| `tests/http.test.ts` | `LocalRunner.http()` through the real dispatcher: routing, 400 for bad JSON, 405, error bodies |
| `tests/mocked.test.ts` | `vi.mock("../src/discounts.js")` - replace a dependency of the handler |
| `tests/events.test.ts` | `runner.queue()` partial failures; calling a handler directly with a hand-built `Event` / `EventRecord` / `Context` |
| `tests/workflow.test.ts` | `runner.workflow()` end to end; `WorkflowEngine` with stubbed tasks to test only the routing |

## `LocalRunner`

```ts
import { LocalRunner } from "node-serverless-kit/testing";

const runner = await LocalRunner.fromConfig("nskit.yml", { mode: "import" });
await runner.http("POST", "/price?code=VIP25", { json: { amount: 100 } });   // -> {status, headers, json(), text, cookies}
await runner.invoke("price-calculator", { ... });                             // invoke-only functions
await runner.queue("ingest", [{ id: 1 }, "garbage"]);                         // -> BatchResult {failed: ["2"]}
await runner.topic("shipped-only", [{ body: {...}, attributes: {...} }]);
await runner.storage("import", [{ key: "incoming/a.csv", size: 10 }]);
await runner.schedule("cleanup", { retentionDays: 30 });
await runner.workflow("scoring", { vip: true });                              // -> {output, history}
```

Two loading modes:

- `mode: "import"` loads handler modules inside the test process, so `vi.mock`, spies and
  coverage work. Use it for unit tests.
- `mode: "bundle"` builds the project with esbuild exactly like a deployment and runs the bundle.
  Use it as a smoke test that the code bundles (the repository's own `tests/examples.test.ts`
  runs every example this way).

## Plain handler tests

Handlers are ordinary functions. Construct the inputs yourself when you need full control:

```ts
import { Context, Event, EventRecord } from "node-serverless-kit/testing";

const event = new Event({ type: "topic", records: [new EventRecord({ id: "1", body: '{"orderId": 7}', attributes: { event_type: "order.shipped" } })] });
expect(await shippedOnly(event, new Context())).toEqual([7]);
```

## Run

```bash
npm install
npm test               # vitest run
npm run typecheck
npx nskit validate --provider gcp
```

`vitest.config.ts` sets `NSKIT_LOG_LEVEL=warn` to keep the output quiet.

## CI

`ci.github-workflow.yml` runs the tests on Node 20 and 22, then validates and packages the
service for AWS, GCP and Azure (no credentials needed) and uploads the generated Terraform for
review. Copy it to `.github/workflows/ci.yml`. Example 15 adds deployments.

## Deploy / switch clouds

```bash
npx nskit deploy
npx nskit deploy --provider gcp
```
