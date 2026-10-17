# 16 · Plain JavaScript (CommonJS)

Not every code base is TypeScript or ES modules. This service is classic Node.js:
`"type": "commonjs"`, `require()` and `module.exports`.

```js
// src/hello.js
const { HttpResponse } = require("node_serverless_kit");
async function handler(event, ctx) { ... }
module.exports = { handler };            // handler: src/hello.handler

// src/todos.js
exports.list = async () => ({ ... });    // handler: src/todos.list
exports.create = async (event) => { ... };
```

The handler reference is always `<module path>.<export name>`; the module may be `.js`, `.cjs`,
`.mjs` or TypeScript. nskit bundles CommonJS and ES modules alike with esbuild into the format
each cloud loads, so nothing else is needed: no transpiler config, no `exports.handler` wrapper per
cloud.

## Routes

| Route | Function |
| --- | --- |
| `GET /hello?name=` | `hello` |
| `GET /todos` | `list-todos` |
| `POST /todos` | `create-todo` (201, 400 without a title) |
| `GET /todos/{id}` | `get-todo` (404 when unknown) |
| `PATCH /todos/{id}` | `toggle-todo` |

## Run locally

```bash
npm install
npx nskit dev
curl -X POST localhost:3000/todos -d '{"title": "write docs"}'
curl localhost:3000/todos
```

## Deploy / switch clouds

```bash
npx nskit deploy
npx nskit deploy --provider gcp
npx nskit deploy --provider azure
```
