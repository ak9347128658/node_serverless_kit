# TypeScript and JavaScript

nskit bundles your code with [esbuild](https://esbuild.github.io/), so TypeScript and JavaScript, ES modules and CommonJS all work without a separate build step. Handler code never changes between clouds; only the bundle's output format does, and nskit picks that per provider.

## Support matrix

| Source | Extensions | Supported | Notes |
|---|---|:-:|---|
| TypeScript, ESM | `.ts`, `.mts` | ✅ | recommended |
| TypeScript, CommonJS | `.cts` | ✅ | |
| TSX | `.tsx` | ✅ | JSX settings come from `tsconfig.json` |
| JavaScript, ESM | `.mjs`, or `.js` in a `"type": "module"` package | ✅ | |
| JavaScript, CommonJS | `.cjs`, or `.js` without `"type": "module"` | ✅ | `exports.fn = ...` or `module.exports = fn` |
| JSX | `.jsx` | ✅ | |
| Mixed (ESM importing CJS and the reverse) | any | ✅ | esbuild handles the interop |

`handler: src/orders.getOrder` is resolved by trying `src/orders` + each extension above, then `src/orders/index.*`. See [handlers.md](handlers.md#handler-references).

## How bundling works

For each deployment, nskit:

1. generates an entry module that installs the bundle manifest and maps every handler reference to a lazy `import()` of your module;
2. runs esbuild with `bundle: true` and the provider's module format (`cjs` or `esm`) and platform (`node`, or `neutral`/`browser` for V8 isolates), targeting the function's Node.js version (`node22` for `nodejs22`);
3. writes one entry file (`index.js`, or the provider's entry name) plus a `.map` source map into `.nskit/<provider>-<stage>/build/`, then zips it deterministically.

Your dependencies from `node_modules` are bundled into that one file. Each handler module is evaluated only when its function is first invoked.

Imports of `node-serverless-kit` in your code are aliased to the installed package's `src/index.ts`, so your code and the nskit dispatcher share **one** copy of the runtime (`instanceof HttpError`, `BatchResult` and module state behave as expected). Install `node-serverless-kit` as a regular dependency or a dev dependency; both work.

Fixed esbuild settings worth knowing: `keepNames: true` (error class names survive for workflow `retry`/`catch`), `legalComments: "none"`, `process.env.NODE_ENV` defined as `"production"`, and for Node ESM output a `createRequire` banner so bundled CommonJS dependencies can still call `require`.

**esbuild does not type-check.** Run `tsc --noEmit` (or `npm run typecheck`) yourself, for example in CI before `nskit deploy`.

## `tsconfig.json`

nskit passes `tsconfig.json` from the project root (next to `nskit.yml`) to esbuild when it exists. Use `package.tsconfig` to point at another file:

```yaml
package:
  tsconfig: tsconfig.build.json
```

esbuild reads from it:

- **`paths` / `baseUrl`** aliases: `import { db } from "@lib/db"` works in the bundle with `"paths": {"@lib/*": ["src/lib/*"]}`. See [`examples/17-typescript-paths`](../examples/17-typescript-paths).
- **Decorators**: `experimentalDecorators` enables legacy TypeScript decorators; without it, standard (TC39) decorators are used. `emitDecoratorMetadata` is **not** supported by esbuild, so libraries that rely on `reflect-metadata` type information need explicit tokens.
- `jsx`, `jsxFactory`, `jsxImportSource`, `useDefineForClassFields`, `importsNotUsedAsValues`/`verbatimModuleSyntax`.

Settings such as `target`, `module` or `outDir` are ignored: the provider decides the output.

## Externals and native modules

Packages that can't be bundled (native addons such as `sharp`, `bcrypt`, `better-sqlite3`, or packages that read their own files at runtime) go in `package.external`:

```yaml
package:
  external: [sharp]
```

nskit then leaves them out of the bundle and installs them into the artifact's `node_modules`:

- the version is the one installed in your project's `node_modules` (falling back to the range in your `package.json`);
- installation runs `npm install --omit=dev --os=linux --cpu=<x64|arm64> --libc=glibc` in the build directory, so you get **Linux** binaries for the function's `architecture` even when you build on Windows or macOS;
- `nskit package --skip-install` skips the install (useful to review the Terraform quickly).

If a native package has no prebuilt Linux binary, the install fails; build the artifact on Linux (CI or Docker). Wildcards such as `@aws-sdk/*` are kept external but never installed.

On **AWS**, `@aws-sdk/*` is external by default because the Lambda Node.js runtime ships AWS SDK v3. Set `provider.options.bundle_aws_sdk: true` to bundle your own pinned SDK instead.

Some providers add npm dependencies of their own to the artifact (for example a platform SDK); see each page under [providers/](providers.md).

## `package` options for bundling

| Key | Default | |
|---|---|---|
| `external` | `[]` | not bundled; installed into `node_modules` (above) |
| `minify` | `false` | minify the bundle |
| `sourcemap` | `true` | write a linked `.map`. On Node runtimes nskit also sets `NODE_OPTIONS=--enable-source-maps`, so stack traces point at your TypeScript |
| `tsconfig` | `tsconfig.json` if present | |
| `esbuild` | `{}` | raw [esbuild build options](https://esbuild.github.io/api/#build), merged **last** (they override nskit's and the provider's settings) |
| `include` / `exclude` | `[]` | extra non-code files copied next to the bundle (templates, data) |

```yaml
package:
  esbuild:
    define: {"process.env.FEATURE_X": '"on"'}
    loader: {".sql": text, ".png": binary}
    banner: {js: "// built by nskit"}
    mainFields: [module, main]
```

Use `package.esbuild` with care: changing `format`, `platform`, `outfile` or `entryPoints` breaks the deployment.

## Module format caveats

- **Top-level `await`** is only valid in ESM output. Providers that bundle to CommonJS (AWS and most Node providers) fail the build if your handler module uses it. Move the work into the handler, or cache a promise: `const ready = init(); export const h = async (e) => { await ready; ... }`.
- `__dirname` / `__filename` are available in CommonJS output only; in ESM output use `import.meta.url`. Files your code reads at runtime must be listed in `package.include`, and they live next to the bundle, not in your source tree.
- `require()` of a computed path can't be bundled; esbuild leaves it in place and it fails at runtime unless the module is in `package.external`.

## Cloudflare Workers (V8 isolates)

Cloudflare runs your code in a V8 isolate, not Node.js. `node:*` built-ins (`fs`, `child_process`, ...) are unavailable unless the platform's Node.js compatibility is enabled, and packages that depend on them won't work. The nskit runtime itself (`node-serverless-kit`) is isolate-safe; use `getEnv()` / `ctx.env` instead of `process.env`. Details: [providers/cloudflare.md](providers/cloudflare.md).

## Examples

- [`examples/16-javascript-commonjs`](../examples/16-javascript-commonjs): plain JavaScript with `require` / `module.exports`.
- [`examples/17-typescript-paths`](../examples/17-typescript-paths): `tsconfig` path aliases and decorators.
