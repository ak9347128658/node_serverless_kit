# Workflows (state machines)

A workflow chains functions with branching, retries, error handling, waits, parallel branches and fan-out. You define it once in `nskit.yml` and nskit runs it:

- **natively**, as AWS Step Functions (ASL) or Google Cloud Workflows;
- on the **embedded engine** on every other cloud, inside an auto-generated orchestrator function;
- **locally** with `nskit workflow run` or `LocalRunner.workflow()`, using the same engine.

```yaml
functions:
  validate: {handler: src/orders.validate}
  charge:   {handler: src/orders.charge}
  notify:   {handler: src/orders.notify}

workflows:
  order-pipeline:
    description: Validate, charge and notify
    startAt: Validate
    states:
      Validate:
        type: task
        function: validate
        retry: [{errors: [TimeoutError], maxAttempts: 3, intervalSeconds: 2, backoffRate: 2}]
        catch: [{errors: [ValidationError], next: Rejected}]
        next: Route
      Route:
        type: choice
        choices:
          - {variable: "$.amount", gt: 1000, next: ManualReview}
        default: Charge
      ManualReview: {type: wait, seconds: 3600, next: Charge}
      Charge:       {type: task, function: charge, resultPath: "$.payment", next: Notify}
      Notify:       {type: task, function: notify, resultPath: null, end: true}
      Rejected:     {type: fail, error: OrderRejected, cause: validation failed}
```

Keys are camelCase. snake_case spellings (`start_at`, `result_path`, `max_attempts`, `not_equals`, `is_present`, ...) are accepted too.

Task handlers receive `event.type === "workflow"` and the state input in `event.data`. Whatever they return is the task result:

```ts
import { defineHandler } from "node_serverless_kit";

class ValidationError extends Error {
  override name = "ValidationError";                   // matched by catch: errors: [ValidationError]
}

export const validate = defineHandler((event) => {
  const order = event.data as { amount?: number };
  if (!order.amount || order.amount <= 0) throw new ValidationError("amount must be positive");
  return { ...order, valid: true };
});
```

Full example: [`examples/07-workflow-orders`](../examples/07-workflow-orders).

## Workflow keys

| Key | Default | Notes |
|---|---|---|
| `startAt` | – | required; must name a state |
| `states` | – | map of state name -> state |
| `description` | `""` | |
| `engine` | `auto` | `auto`: native where supported (aws, gcp), embedded elsewhere. `native`: validation error on clouds without a native engine. `embedded`: force the engine everywhere |
| `timeout` | – | seconds. AWS `TimeoutSeconds`; for the embedded orchestrator, its function timeout (capped at the provider's max) |
| `options.type` | `STANDARD` | AWS only: `STANDARD` or `EXPRESS` |
| `options.http` | `true` | embedded only: `false` removes the orchestrator's HTTP trigger |

Every `next`, `default`, `catch[].next` and choice-rule `next` must name an existing state, and every `function` must be defined under `functions`.

## State types

| `type` | Fields | Behaviour |
|---|---|---|
| `task` | `function`, `next`/`end`, `inputPath`, `resultPath`, `retry`, `catch`, `timeoutSeconds` | call a function |
| `choice` | `choices` (rules with `next`), `default` | branch; no match and no default fails the run with `States.NoChoiceMatched` |
| `wait` | `seconds` or `secondsPath`, `next`/`end` | sleep |
| `pass` | `result`, `resultPath`, `next`/`end` | inject a value, or pass the input through |
| `parallel` | `branches` (each `{startAt, states}`), `resultPath`, `next`/`end` | run branches concurrently; result is an array, one item per branch |
| `map` | `itemsPath`, `iterator` (`{startAt, states}`), `maxConcurrency`, `resultPath`, `next`/`end` | run the iterator for each item; result is an array |
| `succeed` | – | finish successfully with the current data |
| `fail` | `error`, `cause` | finish with an error |

`task`, `wait`, `pass`, `parallel` and `map` without `next` are treated as `end: true`. Every state may have a `comment`. `timeoutSeconds` is compiled into native engines (ASL `TimeoutSeconds`); the embedded engine does not enforce it, only the orchestrator's function timeout. Without `maxConcurrency`, the embedded engine runs up to 32 map items at once.

### Data flow

JSON paths use `$`, `$.a.b`, `$.items[0]`, `$['key']`.

- `inputPath` selects the part of the state's data passed to the task (default: all of it).
- `resultPath` says where the result goes:
  - `$` (default) replaces the data with the result;
  - `$.payment` stores the result under that key and keeps the rest;
  - `null` discards the result and passes the input through.

### Choice rules

```yaml
choices:
  - {variable: "$.status", equals: "paid", next: Ship}
  - {variable: "$.amount", gte: 100, next: Review}
  - and:
      - {variable: "$.country", in: [IN, US]}
      - not: {variable: "$.vip", equals: true}
    next: Standard
  - or: [{variable: "$.email", isPresent: false}, {variable: "$.email", isNull: true}]
    next: AskEmail
```

| Operator | Meaning |
|---|---|
| `equals`, `notEquals` | deep equality, any JSON type (`equals: null` checks for null) |
| `gt`, `gte`, `lt`, `lte` | numeric or string comparison |
| `in` | value is one of a list |
| `contains` | substring, or array membership |
| `matches` | glob pattern (`*`, `?`) |
| `isNull` | `true` / `false` |
| `isPresent` | the path exists (`true` / `false`) |
| `and`, `or`, `not` | combinators, nestable |

`variable` defaults to `$`. A rule whose variable is missing or of the wrong type evaluates to false instead of failing.

### Retry and catch

```yaml
retry:
  - errors: [TimeoutError, FetchError]   # error names; "*" or "States.ALL" = any
    maxAttempts: 3                        # default 3
    intervalSeconds: 1                    # default 1
    backoffRate: 2                        # default 2
    maxDelaySeconds: 60                   # optional cap
catch:
  - errors: ["*"]                         # default ["*"]
    next: HandleError
    resultPath: "$.error"                 # default; stores {error, cause}
```

**Error names** are taken from the thrown value: its `error` property if it is a non-empty string, otherwise its `name` (when not plain `"Error"`), otherwise its constructor name. So a class `class PaymentDeclined extends Error {}` matches `PaymentDeclined` once you set `name` (or rely on the constructor name), and a plain `new Error()` only matches `Error` or `*`. Set `name` explicitly if your code is minified with `keepNames` off (nskit bundles with `keepNames: true`).

The first retrier whose `errors` match is used. Delays grow as `intervalSeconds * backoffRate^attempt`; the embedded engine caps a single delay at `maxDelaySeconds` (300 s when unset). When retries are exhausted, the first matching catcher routes to its `next` state with `{error, cause}` written at its `resultPath`. Without a match the run fails.

## Engines

| Provider | Engine | What gets deployed |
|---|---|---|
| aws | native | `aws_sfn_state_machine` (ASL) and an IAM role that can invoke the task functions |
| gcp | native | Google Cloud Workflows; see [providers/gcp.md](providers/gcp.md) |
| all others (or `engine: embedded`) | embedded | an extra function `<workflow>-orchestrator` that runs the state machine and calls task handlers **in-process** (same bundle) |

### Embedded orchestrator

- Invoke it with `POST /workflows/<workflow>` and the JSON input as the body (when the provider supports HTTP and `options.http` isn't `false`), or invoke it directly. An empty HTTP body uses the query parameters as input.
- Success: `{"workflow": "...", "status": "SUCCEEDED", "output": ..., "durationMs": 123}`.
- Failure: HTTP 500 `{"workflow": "...", "status": "FAILED", "error": "...", "cause": "..."}` (non-HTTP invocations throw `WorkflowFailed`).
- The **whole run must fit in one function invocation**: total time is capped by the provider's max timeout (900 s on AWS). Long `wait` states don't fit; use a native engine or split the workflow. `nskit validate` warns about this.
- The HTTP route is public when the provider's HTTP is public. Set `options.http: false` for sensitive workflows.

### Compiler notes

- **AWS (ASL):** `intervalSeconds` is rounded to a whole number of at least 1. `map` compiles to an inline `ItemProcessor`. `contains` compiles to `StringMatches: "*x*"`, `matches` to `StringMatches`.
- **GCP:** see [providers/gcp.md](providers/gcp.md) for what Cloud Workflows can and can't express.

## Commands

```bash
nskit workflow run order-pipeline -i '{"amount": 50}'               # local, embedded engine; waits skipped
nskit workflow run order-pipeline -i @events/order.json --sleep --history
nskit workflow show order-pipeline                                  # compiled for the current provider
nskit workflow show order-pipeline --format asl                     # auto | asl | gcp | json
```

`run` executes locally with the embedded engine; `wait` states are skipped unless `--sleep` is given, and `--history` prints every state transition. `show --format auto` picks ASL on AWS, Cloud Workflows on GCP, and the portable JSON elsewhere. See [cli.md](cli.md).

In tests:

```ts
import { LocalRunner } from "node_serverless_kit/testing";

const runner = await LocalRunner.fromConfig("nskit.yml");
const { output, history } = await runner.workflow("order-pipeline", { amount: 50 });
```

## Migrating Step Functions ASL

| ASL | nskit |
|---|---|
| `"Type": "Task"`, `"Resource": "arn:...:function:x"` | `type: task`, `function: x` |
| `Choice` with `NumericGreaterThan` / `StringEquals` / `BooleanEquals` / `IsPresent` / `IsNull` / `StringMatches` | `gt` / `equals` / `equals` / `isPresent` / `isNull` / `matches` |
| `And` / `Or` / `Not` | `and` / `or` / `not` |
| `Wait` `Seconds` / `SecondsPath` | `seconds` / `secondsPath` |
| `Pass` `Result` | `pass` `result` |
| `Parallel` `Branches` | `parallel` `branches` |
| `Map` `ItemsPath` + `Iterator`/`ItemProcessor` + `MaxConcurrency` | `map` `itemsPath` + `iterator` + `maxConcurrency` |
| `Retry` `ErrorEquals` / `MaxAttempts` / `IntervalSeconds` / `BackoffRate` / `MaxDelaySeconds` | `retry` `errors` / `maxAttempts` / `intervalSeconds` / `backoffRate` / `maxDelaySeconds` |
| `Catch` `ErrorEquals` / `Next` / `ResultPath` | `catch` `errors` / `next` / `resultPath` |
| `States.ALL` | `"*"` (or `States.ALL`) |
| `InputPath` / `ResultPath` | `inputPath` / `resultPath` |
| `TimeoutSeconds` (state / machine) | `timeoutSeconds` / workflow `timeout` |
| `Succeed` / `Fail` (`Error`, `Cause`) | `succeed` / `fail` (`error`, `cause`) |

Not supported: `Parameters`, `ResultSelector`, `OutputPath`, intrinsic functions, `.sync` / callback service integrations and timestamp waits. Do that shaping in a small task function instead. Walkthrough: [migrating-from-aws.md](migrating-from-aws.md).
