# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

> The function runtime is bundled into every deployment. After upgrading `node_serverless_kit`, run `nskit deploy` again to pick up runtime fixes.

## [Unreleased]

## [0.1.1] - 2026-10-17

### Changed

- The npm package name is `node_serverless_kit`. npm will not accept `node-serverless-kit` because `node_serverless_kit@0.1.0` is already published on this account and the registry treats the hyphen and underscore forms as the same name. Install and import `node_serverless_kit` (`/api`, `/testing`, `/runtime/…`). The CLI is still `nskit`.
- Author credit is Asif Khan.

### Fixed

- `nskit dev` hot reload serves the rebuilt handlers when the project path is a symlink. Node caches `require`d bundles by their real path, so deleting the unresolved key was a no-op on macOS CI (`/var/folders` → `/private/var/folders`) and the server kept returning the previous build. The watcher also follows that real path and polls source mtimes, because FSEvents can drop the change event.
- Packaging a project that does not sit on the same filesystem path as the installed kit no longer fails esbuild. macOS CI temp dirs under `/var/folders` (a symlink to `/private/var/folders`) used to resolve `../` to `/private/Users/...`; Windows CI temp dirs on `C:` against a repo on `D:` used an absolute `D:/a/...` import that the entrySource test rejected. The generated entry now imports kit runtime modules as `node_serverless_kit/runtime/<module>` and the bundler alias plugin maps that to the real source.
- Dependabot no longer opens a major upgrade of `vitest` or `@vitest/coverage-v8` on its own. Those packages must be the same version (`@vitest/coverage-v8@5.0.4` peers `vitest@5.0.4`), and a split bump makes `npm ci` fail with `ERESOLVE` in the test job and in `terraform validate`. Vitest 5 also requires Node.js >= 22.12, while CI still runs Node 20.

## [0.1.0] - 2026-10-15

Initial release: the Node.js sibling of [py-serverless-kit](https://github.com/ak9347128658/serverless_kit).

### Added

- Portable handler API (`node_serverless_kit`): `Event`, `HttpRequest`, `Headers`, `EventRecord`, `Context`, `HttpResponse`, HTTP error classes (`BadRequest`, `NotFound`, ...), `BatchResult` / `processBatch`, `invoke()`, structured logging (`getLogger`), `env` / `getEnv`, `defineHandler`. Zero dependencies; runs on Node.js 18+ and in V8 isolates (Cloudflare Workers).
- Handlers in TypeScript or JavaScript, ESM or CommonJS (`.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx`), bundled with esbuild. Handler results may also be AWS-Lambda-proxy objects or WHATWG `Response`s.
- `nskit.yml` configuration with `extends:`, `providers:` and `stages:` overrides and `${env:}`, `${opt:}`, `${self:}`, `${file()}` and `${tf:}` variables. Keys are camelCase; snake_case spellings are accepted for py-serverless-kit parity.
- Providers: AWS Lambda (stable, including Step Functions), Google Cloud Functions, Azure Functions, Alibaba Function Compute, Tencent SCF, Huawei FunctionGraph, Oracle Functions, IBM Code Engine, DigitalOcean Functions and Cloudflare Workers. Third-party providers via `registerProvider` / `loadProviderPlugins`.
- Triggers: HTTP (path params, CORS, auth), schedule (rate/cron), queue, storage and topic.
- Workflows: AWS Step Functions and Google Cloud Workflows compilers, plus an embedded engine for the other providers and for local runs.
- Deterministic artifacts (sorted zip entries, fixed timestamps) and Terraform JSON generation; works with Terraform >= 1.5 or OpenTofu.
- CLI `nskit`: `init`, `validate`, `package`, `plan`, `deploy`, `remove`, `info`, `dashboard`, `dev`, `invoke`, `workflow run|show`, `providers`, `print`, `tf`.
- Programmatic API (`node_serverless_kit/api`) and testing helpers (`node_serverless_kit/testing`, `LocalRunner`).
- Self-contained HTML deployment dashboard.
- `scripts/validate-all-providers.mjs` (`npm run validate:terraform`) runs `terraform validate` for every provider; `scripts/check-version.mjs` keeps `package.json` and `src/version.ts` in sync.

[Unreleased]: https://github.com/ak9347128658/node_serverless_kit/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/ak9347128658/node_serverless_kit/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ak9347128658/node_serverless_kit/releases/tag/v0.1.0
