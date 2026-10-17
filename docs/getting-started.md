# Getting started

## 1. Install

```bash
npm install --save-dev node_serverless_kit    # CLI: npx nskit (alias: node_serverless_kit)
```

A global install (`npm install -g node_serverless_kit`) works too; the examples below write `nskit` for brevity, so prefix it with `npx` when it is installed per project.

Requirements:

- **Node.js >= 20.19** for the CLI.
- **Terraform >= 1.5** (<https://developer.hashicorp.com/terraform/install>) or **OpenTofu**, for `plan`, `deploy`, `remove` and `tf`. nskit finds `terraform` or `tofu` on `PATH`; to use a specific binary set `NSKIT_TERRAFORM_BIN` or `provider.terraform.binary`. See [HOW_TO_INSTALL_TERRAFORM.md](../deploy_docs/HOW_TO_INSTALL_TERRAFORM.md).
- Credentials for the cloud you deploy to (see [step 6](#6-configure-cloud-credentials)).

You don't need Terraform or credentials for local development, `nskit validate` or `nskit package`.

`node_serverless_kit` is both the CLI and the (zero-dependency) runtime library your handlers import. At deploy time esbuild bundles the runtime into your artifact, so the cloud never installs it.

## 2. Scaffold a project

```bash
nskit init my-api --provider aws --template http --lang ts   # templates: http | events | workflow | full; --lang ts | js
cd my-api
npm install
```

`init` writes an `nskit.yml`, handler code under `src/`, and a test that uses `LocalRunner`. Use `--force` to overwrite existing files.

## 3. Write a handler

A handler is any exported function `(event, context) => result`, sync or async:

```ts
// src/handlers.ts
import { defineHandler, HttpResponse, NotFound } from "node_serverless_kit";

export const hello = defineHandler(async (event, ctx) => {
  const name = event.http?.query.name ?? "world";
  ctx.logger.info("saying hello", { who: name });
  return { message: `Hello, ${name}!` };              // object -> JSON 200
});

export const getItem = defineHandler(async (event) => {
  const id = event.http!.pathParams.id;
  if (id !== "1") throw new NotFound(`item ${id} not found`); // -> JSON 404
  return HttpResponse.json({ id }, 200);
});
```

The same in JavaScript (ESM; CommonJS with `require`/`exports` works too):

```js
// src/handlers.js
import { NotFound } from "node_serverless_kit";

export async function hello(event) {
  return { message: `Hello, ${event.http?.query.name ?? "world"}!` };
}

export async function getItem(event) {
  if (event.http.pathParams.id !== "1") throw new NotFound("item not found");
  return { id: event.http.pathParams.id };
}
```

Wire them up in `nskit.yml`. A handler reference is `<module path relative to package.source>.<export>`, with or without the file extension:

```yaml
service: my-api
provider:
  name: aws
  region: us-east-1
functions:
  hello:
    handler: src/handlers.hello
    events:
      - http: GET /hello
  get-item:
    handler: src/handlers.getItem
    events:
      - http: GET /items/{id}
```

See the [handler API](handlers.md), [TypeScript and JavaScript](typescript-and-javascript.md) and the [configuration reference](configuration.md).

## 4. Run locally

```bash
nskit dev                                    # http://127.0.0.1:3000, reloads on change
curl "http://127.0.0.1:3000/hello?name=Ada"

nskit invoke -f hello --path "/hello?name=Ada"
nskit invoke -f get-item --path /items/1
```

More in [local development](local-development.md).

## 5. Validate and package

```bash
nskit validate                 # schema + provider capability checks + handler modules exist
nskit package --skip-install   # build .nskit/aws-dev/artifact.zip + main.tf.json without touching the cloud
nskit print --yaml             # the fully merged, interpolated config
```

## 6. Configure cloud credentials

nskit runs Terraform, so credentials come from each Terraform provider's standard sources. Set them up for the cloud you deploy to:

| Provider | Quickest setup |
|---|---|
| `aws` | `aws configure` or `aws sso login`, or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_PROFILE`. Optional `options.profile` / `options.assume_role_arn` |
| `gcp` | `gcloud auth application-default login`, or `GOOGLE_APPLICATION_CREDENTIALS=key.json` |
| `azure` | `az login` and `ARM_SUBSCRIPTION_ID` (or `options.subscription_id`). Service principals: `ARM_CLIENT_ID` / `ARM_CLIENT_SECRET` / `ARM_TENANT_ID` |
| `alibaba` | `ALICLOUD_ACCESS_KEY` / `ALICLOUD_SECRET_KEY` |
| `tencent` | `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` |
| `huawei` | `HW_ACCESS_KEY` / `HW_SECRET_KEY` (+ `HW_REGION_NAME`) |
| `oracle` | `~/.oci/config` (`oci setup config`) |
| `ibm` | `IC_API_KEY` |
| `digitalocean` | `doctl auth init` (`doctl` must be on `PATH`; nskit deploys through `doctl serverless`). `options.namespace` is required |
| `cloudflare` | `CLOUDFLARE_API_TOKEN` |
| `onprem` | none. `engine: process` (the default) needs Node.js and Terraform on the machine that runs `nskit deploy`. `engine: docker` also needs a Docker daemon |

Required provider options (project ids, account ids, namespaces, ...) are listed on each [provider page](providers.md).

## 7. Deploy

```bash
nskit deploy                     # package -> terraform init -> terraform apply
nskit deploy --stage prod        # another stage = a separate copy of every resource
nskit deploy --confirm           # show the plan, then apply exactly that plan
nskit plan                       # just the plan
```

After deploying, nskit prints endpoints and resource ids, writes `.nskit/<provider>-<stage>/deployment.json`, and regenerates the [dashboard](dashboard.md).

```bash
nskit info              # what is deployed (from the last deploy)
nskit info --refresh    # re-read terraform outputs
nskit dashboard --open  # HTML overview of every provider/stage
```

> Terraform state is stored locally in `.nskit/<provider>-<stage>/` by default. For team use, configure a remote backend (`provider.state`); see [configuration.md](configuration.md#state-remote-terraform-backend).

## 8. Switch cloud

The code doesn't change. Pick one of three ways:

```bash
nskit deploy --provider gcp           # 1. override on the command line
```

```yaml
# 2. per-provider overrides in the same nskit.yml, selected with --provider
providers:
  gcp:
    region: europe-west1
    options: {project: my-gcp-project}
```

```yaml
# 3. a small file per cloud
# nskit.gcp.yml
extends: nskit.yml
provider:
  name: gcp
  region: europe-west1
  options: {project: my-gcp-project}
```

```bash
nskit deploy -c nskit.gcp.yml
```

Check what the target cloud supports first with `nskit providers` and `nskit validate --provider gcp`. A full example is [`examples/08-multi-cloud`](../examples/08-multi-cloud).

## 9. Remove

```bash
nskit remove            # asks for confirmation; -y to skip
nskit remove --stage prod -y
```

## Next

- [Events](events.md): queues, schedules, storage and topics.
- [Workflows](workflows.md): Step Functions-style state machines that also run on other clouds.
- [Examples](../examples/)
