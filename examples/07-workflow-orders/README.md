# 07 · Order workflow (every state type)

A Step Functions-style state machine defined once in `nskit.yml` and run on AWS Step Functions,
Google Cloud Workflows, or the embedded engine on every other cloud (and locally).

```
Validate ─► Route ─┬─(total > 1000 and not VIP)──► ManualReview (wait) ─► Reserve (map) ─► Charge ─► Fulfil (parallel) ─► Done
                   ├─(channel b2b or CHF)────────► Invoice (pass) ─────────────────────────────────► Fulfil
                   └─(default)───────────────────► Reserve
Validate  ─ValidationError─► Rejected (fail)       Reserve ─OutOfStock─► Rejected
Charge    ─PaymentGatewayTimeout─► retry x3 (2 s, 4 s, 8 s)      ─PaymentDeclined─► Declined (fail)
```

| State type | Used by | Notes |
| --- | --- | --- |
| `task` | Validate, Charge, ReserveItem, Confirm, Ship | `function:` is the logical function name |
| `choice` | Route | `and` / `or` / `not`, `gt`, `equals`; `default` |
| `wait` | ManualReview | `seconds` or `secondsPath` |
| `pass` | Invoice | injects `result` at `resultPath` |
| `map` | Reserve | `itemsPath`, `maxConcurrency`, `iterator` |
| `parallel` | Fulfil | `branches`, results as an array |
| `succeed` / `fail` | Done / Declined, Rejected | `error` + `cause` |

## Errors, retry and catch

Errors are matched by `error.name`. Give custom errors an explicit name
(`class PaymentDeclined extends Error { override name = "PaymentDeclined" }`) so the match
survives minification. `"*"` (or `States.ALL`) matches everything.

## Inputs

`events/*.json` are ready-made inputs:

| File | Path through the workflow | Result |
| --- | --- | --- |
| `happy.json` | Reserve -> Charge (first attempt times out, retry succeeds) -> Fulfil | SUCCEEDED |
| `b2b.json` | Invoice -> Fulfil | SUCCEEDED |
| `large.json` | ManualReview -> Reserve -> Charge -> Fulfil | SUCCEEDED |
| `declined.json` | Charge -> Declined | FAILED `PaymentDeclined` |
| `invalid.json` | Validate -> Rejected | FAILED `OrderRejected` |
| `out-of-stock.json` | Reserve -> Rejected | FAILED `OrderRejected` |

## Run locally

```bash
npm install
npx nskit workflow run order-pipeline -i events/happy.json
npx nskit workflow run order-pipeline -i events/declined.json     # FAILED PaymentDeclined
npx nskit workflow show order-pipeline --format asl              # the generated Step Functions ASL
```

## Deploy

```bash
npx nskit deploy           # 5 Lambdas + a Step Functions state machine
```

## Switch clouds

```bash
npx nskit deploy --provider gcp      # Cloud Workflows (native)
npx nskit deploy --provider azure    # embedded engine: an extra `order-pipeline-orchestrator`
                                     # function, started with POST /workflows/order-pipeline
```

With the embedded engine the whole run happens inside one function invocation, so it is capped by
that function's timeout; `nskit validate` warns about it. Set `engine: embedded` to use it on
AWS/GCP too, or `engine: native` to fail validation on clouds without a native engine.
