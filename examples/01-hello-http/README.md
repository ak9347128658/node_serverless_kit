# 01 · Hello HTTP

The minimum: one TypeScript handler, one HTTP function, deployable to any cloud.

## Files

| File | Purpose |
| --- | --- |
| `src/handlers.ts` | the handler - plain TypeScript, no cloud SDK |
| `nskit.yml` | service name, target cloud, function + triggers |
| `package.json` / `tsconfig.json` | a normal Node.js project (`"type": "module"`) |

## The YAML

```yaml
functions:
  hello:
    handler: src/handlers.hello   # module path (no extension) + export name
    events:
      - http: GET /hello          # method + path
      - http: GET /hello/{name}   # path parameter
```

`providers:` holds per-cloud overrides (region, project id, ...). They only apply when that
cloud is selected, so one file serves every target.

## The handler

```ts
export const hello = defineHandler(async (event, ctx) => {
  const name = event.http?.pathParams.name ?? event.http?.query.name ?? "world";
  if (name.length > 64) throw new BadRequest("name is too long");   // -> 400
  return HttpResponse.json({ message: `Hello, ${name}!`, provider: event.provider });
});
```

`defineHandler` only adds types. A plain `export async function hello(event, ctx)` works too.

## Run locally

```bash
npm install
npx nskit dev                                  # http://127.0.0.1:3000/hello?name=Ada
npx nskit invoke -f hello --path "/hello/Ada"
```

Expected body: `{"message": "Hello, Ada!", "provider": "local", "stage": "dev"}`.

## Deploy

```bash
npx nskit deploy                      # AWS Lambda + API Gateway HTTP API
npx nskit info                        # URLs and resource ids
npx nskit remove                      # tear it down again
```

## Switch clouds

```bash
npx nskit deploy --provider gcp          # Cloud Functions (needs GOOGLE_CLOUD_PROJECT)
npx nskit deploy --provider azure        # Azure Functions (needs ARM_SUBSCRIPTION_ID)
npx nskit deploy --provider cloudflare   # Workers (needs CLOUDFLARE_ACCOUNT_ID)
```

The handler does not change; `event.provider` simply reports where it runs.
