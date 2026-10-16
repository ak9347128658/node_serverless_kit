# 02 · REST API

A CRUD API for books in TypeScript that uses every HTTP feature of the portable runtime:
path and query parameters, JSON validation with proper status codes, CORS, cookies, binary
responses, redirects, and JWT verification that also works on Cloudflare Workers.

## Routes

| Route | Function | Responses |
| --- | --- | --- |
| `GET /books?author=&limit=` | `list-books` | 200, 400 (bad limit) |
| `GET /books/{id}` | `get-book` | 200, 404 |
| `POST /books` | `create-book` | 201 + `location`, 400 (not JSON / not an object), 409 (duplicate ISBN), 422 (field errors) |
| `PUT /books/{id}` | `update-book` | 200, 400, 404, 422 |
| `DELETE /books/{id}` | `delete-book` | 204, 404 |
| `GET /books/{id}/cover` | `cover` | 200 `image/png` (binary, base64-encoded for gateways automatically) |
| `GET /docs` | `docs` | 302 redirect |
| `POST /session` | `session` | 200 + `Set-Cookie: session=...; HttpOnly; Secure; SameSite=Lax` |
| `GET /stats/admin` | `admin-stats` | 200 with a valid HS256 bearer token, 401 / 403 otherwise (not `/admin/...`: the Azure Functions host reserves `/admin`) |

## Highlights

- **Errors are exceptions.** `throw new NotFound(...)`, `Conflict`, `UnprocessableEntity(msg, {details})`
  become `{"error": ..., "status": ..., "details": ...}` with the right status on every cloud.
  `event.http.json()` throws a 400 for malformed JSON on its own.
- **CORS** is declared once under `custom.cors` and reused with `${self:custom.cors}`.
  Preflight `OPTIONS` requests are answered by the runtime (with `access-control-allow-credentials`
  because `allowCredentials: true`).
- **Cookies**: `HttpResponse.json(...).setCookie(name, value, {maxAge})`; read them with
  `event.http.cookies`.
- **JWT** (`src/auth.ts`): HS256 verification with WebCrypto `crypto.subtle`, which exists on
  Node.js and in V8 isolates, so the same code runs on Lambda, Cloud Functions, Azure and Workers.
  On AWS you can instead let API Gateway validate tokens (`auth: jwt`, see the comment in `nskit.yml`).
- `src/store.ts` is an in-memory map to stay dependency-free. Use a real database in production:
  instances do not share memory.

## Run locally

```bash
npm install
npx nskit dev
curl localhost:3000/books?author=gibson
curl -i -X POST localhost:3000/books -H 'content-type: application/json' \
     -d '{"title": "Snow Crash", "author": "Neal Stephenson", "year": 1992, "isbn": "9780553380958"}'
curl -i -X POST localhost:3000/books -d '{"title": 1}'            # 422 with per-field details
curl -i -X OPTIONS localhost:3000/books -H 'origin: http://localhost:5173'
curl -o cover.png localhost:3000/books/b1/cover
```

For `/stats/admin` create a token signed with `JWT_SECRET` (default `dev-secret-change-me`), issuer
`https://auth.example.com/`, audience `books-api` and a `role: admin` claim, e.g. on jwt.io.

## Deploy

```bash
JWT_SECRET=$(openssl rand -hex 32) npx nskit deploy
```

## Switch clouds

```bash
npx nskit deploy --provider gcp
npx nskit deploy --provider azure
npx nskit deploy --provider cloudflare     # same code: WebCrypto + web APIs only
```
