# 09 · Function invoke

`quote` (HTTP) calls two internal functions with `invoke()`:

```ts
const price = await invoke<Price>("price-calculator", { items, country });          // request/response
await invoke("audit-log", { action: "quote", total: price.total }, { async: true }); // fire and forget
```

`price-calculator` and `audit-log` have no events: they are *invoke-only* and get no public URL
on clouds that can call functions directly. The target sees `event.type === "invoke"` and
`event.data === payload`.

## How each cloud resolves the target

| Where | Mechanism | Config needed |
| --- | --- | --- |
| local (`nskit dev`, tests) | in-process call through the dispatcher | none |
| AWS | `lambda:InvokeFunction` on `<service>-<stage>-<function>` (SDK from the Lambda runtime) | the IAM statement in `nskit.yml` |
| GCP | authenticated HTTPS call with an ID token from the metadata server | none |
| any cloud | HTTP POST to `NSKIT_ENDPOINT_<NAME>` when that variable is set | the target's URL (give it an `http` event) |

On Azure (and the other clouds without a direct invoke API) set `NSKIT_ENDPOINT_PRICE_CALCULATOR`
and `NSKIT_ENDPOINT_AUDIT_LOG` in the caller's `environment`, as `providers.azure` does, from
`nskit info` after the first deploy. Give the targets an `http` event there.

## Run locally

```bash
npm install
npx nskit dev
curl -X POST localhost:3000/quote -d '{"country": "DE", "items": [{"sku": "a", "qty": 2, "unitPrice": 10}]}'
# {"quote": {"subtotal": 20, "tax": 3.8, "total": 23.8, "taxRate": 0.19}, "requestId": "..."}
npx nskit invoke -f price-calculator -d '{"country": "FR", "items": [{"sku": "a", "qty": 1, "unitPrice": 5}]}'
```

## Deploy

```bash
npx nskit deploy
```

## Switch clouds

```bash
npx nskit deploy --provider gcp
PRICE_CALCULATOR_URL=https://... AUDIT_LOG_URL=https://... npx nskit deploy --provider azure
```
