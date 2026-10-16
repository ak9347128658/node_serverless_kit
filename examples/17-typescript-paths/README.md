# 17 · TypeScript path aliases, shared modules and assets

A larger TypeScript layout: handlers in `src/handlers/`, shared code in `src/lib/` imported through a
`tsconfig.json` path alias, and an HTML template bundled into the code.

```
src/
  handlers/pages.ts    import { greeting } from "@lib/greeting";  import page from "@templates/page.html";
  handlers/api.ts      import { greeting } from "@lib/greeting";
  lib/greeting.ts      shared business logic
  lib/render.ts        {{name}} templating with HTML escaping
  types/assets.d.ts    declare module "*.html"
templates/page.html
```

## Path aliases

```jsonc
// tsconfig.json
"paths": { "@lib/*": ["./src/lib/*"], "@templates/*": ["./templates/*"] }
```

nskit hands this tsconfig to esbuild (`package.tsconfig`, the default when `tsconfig.json`
exists), which resolves the aliases while bundling. No `tsc-alias`, no runtime module loader.
Handler references use the file path: `src/handlers/pages.page`.

## Assets

Two ways to ship a non-code file:

1. **Embed it** (used here). `package.esbuild.loader: {".html": "text"}` makes
   `import pageTemplate from "@templates/page.html"` a string inside the bundle. No file system
   access at runtime, so it also works on Cloudflare Workers, and no path guessing
   (`__dirname` does not exist in ES modules, and the working directory differs per cloud).
2. **Copy it** next to the bundle with `package.include: [templates/**]`. Useful for libraries that
   insist on reading files; read them relative to the deployment root
   (`process.env.LAMBDA_TASK_ROOT` on AWS, the working directory on most other clouds).

Any other esbuild option can go under `package.esbuild` (`define`, `banner`, more loaders, ...).

The page is served at `/page` rather than `/` because Azure Functions cannot route the root path
to a function (`nskit validate --provider azure` reports it).

## Run locally

```bash
npm install
npx nskit dev
open http://localhost:3000/greet/Ada
curl "localhost:3000/api/greeting?name=Ada"
npx tsc --noEmit            # the aliases type-check too
```

## Deploy / switch clouds

```bash
npx nskit deploy
npx nskit deploy --provider gcp
npx nskit deploy --provider cloudflare
```
