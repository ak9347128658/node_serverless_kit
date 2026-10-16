# Security Policy

## Supported versions

Security fixes go into the latest minor release line (currently `0.1.x`). The function runtime is bundled into every deployment artifact, so after upgrading `node-serverless-kit` you must **redeploy** (`nskit deploy`) to pick up a runtime fix.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Report them privately through GitHub's **Security → Report a vulnerability** (private advisory) at <https://github.com/ak9347128658/node_serverless_kit/security/advisories/new>. Include:

- the affected version (`nskit --version`), Node.js version and provider;
- a description of the issue and its impact;
- steps to reproduce or a proof of concept, if you have one.

We aim to acknowledge reports within 3 business days and to ship a fix or mitigation within 30 days for high-severity issues. We credit reporters in the advisory unless they prefer to stay anonymous.

## Supply chain

- Releases are published from GitHub Actions with [npm provenance](https://docs.npmjs.com/generating-provenance-statements). Check it with `npm audit signatures` or on the package page on npmjs.com.
- The runtime that ships inside your functions (`src/runtime/`, `src/index.ts`) has **zero dependencies**.

## Security-relevant defaults

- HTTP 500 responses contain only `{"error", "status", "requestId"}`. Exception details are added only when `NSKIT_DEBUG=1` is set.
- `.env`, `.env.*`, Terraform state files and `nskit*.yml` are excluded from `package.include` asset copies by default.
- `.nskit/` (which holds local Terraform state and build output) gets its own `.gitignore`. Use a remote, encrypted state backend (`provider.state`) for team work.
- Buckets created on AWS (code artifacts and storage triggers) block public access.
- `auth: none` HTTP routes are public. Use `auth: iam` or `auth: jwt` where the provider supports them.
- Embedded workflow orchestrators get a public `POST /workflows/<name>` route on providers with HTTP support. Set `workflows.<name>.options.http: false` to make them invoke-only.
- The dashboard lists environment variable **names**, never values. It does contain resource names, URLs and ids, so treat it as internal.
