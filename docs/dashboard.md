# Dashboard

`nskit deploy` regenerates a single self-contained HTML page listing everything this project has deployed, across all providers and stages:

```
.nskit/dashboard/index.html
```

```bash
nskit dashboard               # regenerate
nskit dashboard --open        # regenerate and open in the browser
nskit dashboard --serve       # serve on http://127.0.0.1:8765/index.html (Ctrl+C to stop)
nskit dashboard -o site/index.html
nskit dashboard ../other-project
nskit deploy --no-dashboard   # deploy without regenerating it
```

## What it shows

- **Summary cards:** deployments, functions, workflows, providers.
- **One section per deployment** (`service · stage`): provider and tier, status (`deployed`, `removed`, `local`), region, last update, artifact hash, API endpoint, nskit version.
- **Functions table:**
  - name and the cloud resource name;
  - kind (`http`, `scheduled`, `event-driven`, `http+event`, `invoke-only`; generated workflow orchestrators are flagged);
  - triggers (e.g. `GET /items/{id}`, `cron(0 2 * * *)`, `queue jobs (batch 10)`, `bucket uploads [created] suffix=.csv`);
  - runtime, architecture, memory, timeout;
  - clickable endpoint URLs;
  - resource id/ARN with a copy button, and a console link where the provider has one;
  - expandable details: handler, description, environment variable **names** (never values).
- **Workflows table:** engine (`native` / `embedded`), states, task functions, state machine id and console link.
- A filter box, provider and stage selectors, and a light/dark theme toggle (follows the system setting by default).

The page has no external scripts, fonts or network calls, so it works from `file://`, any static host, or a CI artifact.

## Where the data comes from

Each deploy writes `.nskit/<provider>-<stage>/deployment.json`, built from the config plus the `nskit` Terraform output (see [architecture.md](architecture.md#the-nskit-terraform-output)). The dashboard reads all of these files: deploy `aws` and `gcp`, `dev` and `prod`, and they all appear on one page. `nskit info --json` prints the same record for one provider and stage.

`nskit dev` serves a local view of the configured functions at `http://127.0.0.1:3000/__nskit/`.

Because `.nskit/` is git-ignored and local, CI runs and other machines each have their own records. To share a dashboard:

- upload `.nskit/dashboard/index.html` as a CI artifact; [`examples/15-ci-cd-deploy`](../examples/15-ci-cd-deploy) shows how;
- or publish it to a private static site or bucket.

The page contains resource names, URLs and ids, so treat it as internal.
