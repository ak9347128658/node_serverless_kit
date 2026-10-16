# Contributing

The full contributor guide lives in [deploy_docs/CONTRIBUTING.md](deploy_docs/CONTRIBUTING.md). It covers the project layout, dev setup, how to add providers, config options and event types, and how to verify the generated Terraform.

Maintainers releasing to npm: see [deploy_docs/How_to_deploy.md](deploy_docs/How_to_deploy.md) (checklist) and [deploy_docs/PUBLISHING_TO_NPM.md](deploy_docs/PUBLISHING_TO_NPM.md) (step by step).

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Quick start (Node.js >= 20.19):

```bash
git clone https://github.com/ak9347128658/node_serverless_kit.git
cd node_serverless_kit
npm ci
npm run check        # typecheck + lint + tests + build
```

Before opening a pull request:

- use [Conventional Commits](https://www.conventionalcommits.org/) (`feat(gcp): ...`, `fix(runtime): ...`);
- add an entry under **Unreleased** in [CHANGELOG.md](CHANGELOG.md);
- for provider changes, run `npm run validate:terraform -- --provider <name>` (needs Terraform, no cloud credentials).

Security issues: don't open a public issue. Follow [SECURITY.md](SECURITY.md).
