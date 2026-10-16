# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

> The function runtime is bundled into every deployment. After upgrading `node-serverless-kit`, run `nskit deploy` again to pick up runtime fixes.

## [Unreleased]

### Fixed

- Dependabot no longer opens a major upgrade of `vitest` or `@vitest/coverage-v8` on its own. Those packages must be the same version (`@vitest/coverage-v8@5.0.4` peers `vitest@5.0.4`), and a split bump makes `npm ci` fail with `ERESOLVE` in the test job and in `terraform validate`. Vitest 5 also requires Node.js >= 22.12, while CI still runs Node 20.

## [0.1.0] - 2026-10-15

Initial release: the Node.js sibling of [py-serverless-kit](https://github.com/ak9347128658/serverless_kit).

### Added

- Portable handler API (`node-serverless-kit`): `Event`, `HttpRequest`, `Headers`, `EventRecord`, `Context`, `HttpResponse`, HTTP error classes (`BadRequest`, `NotFound`, ...), `BatchResult` / `processBatch`, `invoke()`, structured logging (`getLogger`), `env` / `getEnv`, `defineHandler`. Zero dependencies; runs on Node.js 18+ and in V8 isolates (Cloudflare Workers).
- Handlers in TypeScript or JavaScript, ESM or CommonJS (`.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx`), bundled with esbuild. Handler results may also be AWS-Lambda-proxy objects or WHATWG `Response`s.
- `nskit.yml` configuration with `extends:`, `providers:` and `stages:` overrides and `${env:}`, `${opt:}`, `${self:}`, `${file()}` and `${tf:}` variables. Keys are camelCase; snake_case spellings are accepted for py-serverless-kit parity.
- Providers: AWS Lambda (stable, including Step Functions), Google Cloud Functions, Azure Functions, Alibaba Function Compute, Tencent SCF, Huawei FunctionGraph, Oracle Functions, IBM Code Engine, DigitalOcean Functions and Cloudflare Workers. Third-party providers via `registerProvider` / `loadProviderPlugins`.
- Triggers: HTTP (path params, CORS, auth), schedule (rate/cron), queue, storage and topic.
- Workflows: AWS Step Functions and Google Cloud Workflows compilers, plus an embedded engine for the other providers and for local runs.
- Deterministic artifacts (sorted zip entries, fixed timestamps) and Terraform JSON generation; works with Terraform >= 1.5 or OpenTofu.
- CLI `nskit`: `init`, `validate`, `package`, `plan`, `deploy`, `remove`, `info`, `dashboard`, `dev`, `invoke`, `workflow run|show`, `providers`, `print`, `tf`.
- Programmatic API (`node-serverless-kit/api`) and testing helpers (`node-serverless-kit/testing`, `LocalRunner`).
- Self-contained HTML deployment dashboard.
- `scripts/validate-all-providers.mjs` (`npm run validate:terraform`) runs `terraform validate` for every provider; `scripts/check-version.mjs` keeps `package.json` and `src/version.ts` in sync.

[Unreleased]: https://github.com/ak9347128658/node_serverless_kit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ak9347128658/node_serverless_kit/releases/tag/v0.1.0
