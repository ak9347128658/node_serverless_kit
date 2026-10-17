# Providers

Run `nskit providers` (or `nskit providers --json`) to print this matrix from the installed version; it is the authoritative source. The table below reflects the current release.

| Provider | Tier | http | schedule | queue | storage | topic | workflows | Runtimes | Max timeout |
|---|---|:-:|:-:|:-:|:-:|:-:|---|---|---|
| [`aws`](providers/aws.md) AWS Lambda | stable | ✅ API Gateway | ✅ EventBridge Scheduler | ✅ SQS | ✅ S3 | ✅ SNS | native (Step Functions) | nodejs20, 22, 24 | 900 s |
| [`gcp`](providers/gcp.md) Google Cloud Functions | beta | ✅ | ✅ Cloud Scheduler | ✅ Pub/Sub | ✅ GCS | ✅ Pub/Sub | native (Cloud Workflows) | nodejs20, 22, 24 | 3600 s |
| [`azure`](providers/azure.md) Azure Functions | beta | ✅ | ✅ timer | ✅ Storage Queue | ✅ Blob | ✅ Service Bus | embedded | nodejs20, 22, 24 | 600 s |
| [`alibaba`](providers/alibaba.md) Function Compute | beta | ✅ | ✅ timer | – | ✅ OSS | ✅ MNS | embedded | nodejs18, 20 | 3600 s |
| [`tencent`](providers/tencent.md) Tencent SCF | beta | ✅ API Gateway | ✅ timer | – | ✅ COS | – | embedded | nodejs18, 20 | 900 s |
| [`huawei`](providers/huawei.md) FunctionGraph | beta | ✅ APIG | ✅ timer | – | ✅ OBS | ✅ SMN | embedded | nodejs18, 20 | 900 s |
| [`oracle`](providers/oracle.md) OCI Functions | experimental | ✅ API Gateway | – | – | ✅ Object Storage | – | embedded | nodejs20, 22, 24 | 300 s |
| [`ibm`](providers/ibm.md) IBM Code Engine | beta | ✅ | – | – | – | – | embedded | nodejs22, 24 | 120 s |
| [`digitalocean`](providers/digitalocean.md) DigitalOcean Functions | beta | ✅ | ✅ | – | – | – | embedded | nodejs18, 22, 24 | 900 s |
| [`cloudflare`](providers/cloudflare.md) Cloudflare Workers | beta | ✅ workers.dev / routes | ✅ Cron Triggers | ✅ Queues | – | – | embedded | V8 isolate | 900 s |
| [`onprem`](providers/onprem.md) On-premises | beta | ✅ | ✅ timers | ✅ built-in, Redis or HTTP | ✅ built-in, directory, S3/MinIO | ✅ built-in, Redis or HTTP | embedded | nodejs18, 20, 22, 24 | 3600 s |

Each provider page lists its options, credentials, Terraform resources, artifact layout and limits.

**Tiers**

- **stable:** deployed for real, full trigger set; the generated Terraform is validated against the real provider plugin.
- **beta:** validated with `terraform validate`; event payload formats follow vendor documentation. Try on a non-production account first.
- **experimental:** works with notable constraints (container images, extra infrastructure); read the provider page first.

**Common to all providers**

- Every provider gets `provider.region` (or its default region), `provider.options` (see its page) and `functions.<fn>.options`, which is merged into that provider's function resource as an escape hatch.
- Resources are tagged or labelled with `nskit-service`, `nskit-stage` and `managed-by: node_serverless_kit` where the cloud supports tags.
- With no pinned `runtime`, nskit picks nodejs22, or the newest supported version below it (nodejs20 on Alibaba, Tencent and Huawei). See [configuration.md](configuration.md#default-runtime).
- Each function receives `NSKIT_PROVIDER`, `NSKIT_SERVICE`, `NSKIT_STAGE`, `NSKIT_REGION`, `NSKIT_FUNCTION` and `NSKIT_HANDLER`.
- If a config uses a trigger, auth mode or option the provider can't honour, `nskit validate` fails with a clear message (or warns when ignoring it is harmless).
- Workflows run natively on AWS and GCP; elsewhere an embedded `<workflow>-orchestrator` function runs them, capped by the provider's max timeout (see [workflows.md](workflows.md)).

Every generated configuration passes `terraform validate`; the repository's `scripts/validate-all-providers.mjs` (`npm run validate:terraform`) re-checks this for all providers in CI.

## Provider pages

| Page | Terraform provider |
|---|---|
| [aws](providers/aws.md) | `hashicorp/aws` |
| [gcp](providers/gcp.md) | `hashicorp/google` |
| [azure](providers/azure.md) | `hashicorp/azurerm` |
| [alibaba](providers/alibaba.md) | `aliyun/alicloud` |
| [tencent](providers/tencent.md) | `tencentcloudstack/tencentcloud` |
| [huawei](providers/huawei.md) | `huaweicloud/huaweicloud` |
| [oracle](providers/oracle.md) | `oracle/oci` |
| [ibm](providers/ibm.md) | `IBM-Cloud/ibm` |
| [digitalocean](providers/digitalocean.md) | built-in `terraform_data` (deploys with `doctl`) |
| [cloudflare](providers/cloudflare.md) | `cloudflare/cloudflare` |
| [onprem](providers/onprem.md) | built-in `terraform_data` (local, ssh and bundle) or `kreuzwerker/docker` |

## Writing your own provider

Third-party providers are npm packages registered with `registerProvider` / `loadProviderPlugins` or `NSKIT_PROVIDER_PLUGINS`; see [architecture.md](architecture.md#third-party-providers). Built-in providers follow the checklist in [`deploy_docs/CONTRIBUTING.md`](../deploy_docs/CONTRIBUTING.md).
