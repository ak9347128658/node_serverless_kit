# node_serverless_kit documentation

Write a Node.js function once (TypeScript or JavaScript, ESM or CommonJS), describe its triggers in `nskit.yml`, and deploy it to any of 10 clouds with esbuild and Terraform. Moving to another cloud means changing `provider.name`. The handler code stays the same.

| Page | What it covers |
|---|---|
| [Getting started](getting-started.md) | Install, scaffold a project, run it locally, set up cloud credentials, deploy, inspect, remove |
| [Configuration reference](configuration.md) | Every `nskit.yml` key, `extends:`, `providers:`/`stages:` overrides, variables, escape hatches |
| [Events (triggers)](events.md) | `http`, `schedule`, `queue`, `storage`, `topic`, with shorthand forms and per-provider support |
| [Handler API](handlers.md) | `Event`, `HttpRequest`, `EventRecord`, `Context`, `HttpResponse`, errors, `BatchResult`, `invoke()`, logging |
| [TypeScript and JavaScript](typescript-and-javascript.md) | TS/JS, ESM/CJS, tsconfig `paths`, decorators, externals and native modules, `package.esbuild` |
| [Workflows](workflows.md) | State machines: native AWS Step Functions / GCP Cloud Workflows, or the embedded engine anywhere |
| [Providers](providers.md) | Capability matrix and links to one page per cloud: options, credentials, resources, limits |
| [CLI reference](cli.md) | Every `nskit` command and flag |
| [Local development](local-development.md) | `nskit dev`, `nskit invoke`, `.env`, testing with `LocalRunner` and Vitest |
| [Dashboard](dashboard.md) | The generated HTML index of everything you deployed |
| [Architecture](architecture.md) | Bundling pipeline, artifact layout, runtime dispatch, third-party providers |
| [Migrating from AWS](migrating-from-aws.md) | Moving existing Lambda functions and Step Functions to nskit, then to other clouds |
| [Migrating from py-serverless-kit](migrating-from-py-serverless-kit.md) | Differences between `pskit` and `nskit` |
| [Troubleshooting & FAQ](troubleshooting.md) | Common errors, provider gotchas, security notes |

Per-provider pages: [aws](providers/aws.md) · [azure](providers/azure.md) · [gcp](providers/gcp.md) · [alibaba](providers/alibaba.md) · [tencent](providers/tencent.md) · [huawei](providers/huawei.md) · [oracle](providers/oracle.md) · [ibm](providers/ibm.md) · [digitalocean](providers/digitalocean.md) · [cloudflare](providers/cloudflare.md)

Runnable examples for every scenario live in [`../examples`](../examples/).

Maintainers: see [`../deploy_docs/CONTRIBUTING.md`](../deploy_docs/CONTRIBUTING.md) and [`../deploy_docs/PUBLISHING_TO_NPM.md`](../deploy_docs/PUBLISHING_TO_NPM.md).
