/**
 * A small REST API showing every HTTP feature of the portable runtime.
 *
 *   GET    /books               list, optional ?author= filter and ?limit=
 *   GET    /books/{id}          fetch one              -> 404 if missing
 *   POST   /books               create (JSON body)     -> 201, 400, 409, 422
 *   PUT    /books/{id}          replace                -> 200, 400, 404, 422
 *   DELETE /books/{id}          delete                 -> 204, 404
 *   GET    /books/{id}/cover    binary image/png
 *   GET    /docs                302 redirect
 *   POST   /session             sets an HttpOnly cookie
 *   GET    /stats/admin         needs `Authorization: Bearer <HS256 JWT>`
 */

import {
  BadRequest,
  Conflict,
  defineHandler,
  Forbidden,
  getEnv,
  HttpResponse,
  NotFound,
  UnprocessableEntity,
  type HttpRequest,
} from "node-serverless-kit";
import { bearerToken, verifyHs256 } from "./auth.js";
import * as store from "./store.js";
import type { Book } from "./store.js";

// 1x1 transparent PNG, so the example needs no image files.
const PIXEL = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="),
  (c) => c.charCodeAt(0),
);

const FIELDS = { title: "string", author: "string", year: "number", isbn: "string" } as const;

/** The request of an HTTP-triggered function (always set for `http` events). */
function req(http: HttpRequest | undefined): HttpRequest {
  if (!http) throw new BadRequest("this function only handles HTTP requests");
  return http;
}

/**
 * Validate a book payload.
 * - not JSON / not an object       -> 400 Bad Request
 * - wrong or missing fields         -> 422 Unprocessable Entity with per-field details
 */
function validate(body: unknown): Omit<Book, "id"> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("body must be a JSON object");
  const data = body as Record<string, unknown>;
  const errors: Record<string, string> = {};
  for (const [field, kind] of Object.entries(FIELDS)) {
    const value = data[field];
    if (value === undefined || value === null) errors[field] = "required";
    else if (typeof value !== kind) errors[field] = `must be a ${kind}`;
  }
  if (typeof data.year === "number" && (!Number.isInteger(data.year) || data.year > new Date().getUTCFullYear())) {
    errors.year = "must be a past year";
  }
  if (typeof data.isbn === "string" && ![10, 13].includes(data.isbn.replace(/-/g, "").length)) {
    errors.isbn = "must have 10 or 13 digits";
  }
  if (Object.keys(errors).length) throw new UnprocessableEntity("validation failed", { details: errors });
  return { title: data.title as string, author: data.author as string, year: data.year as number, isbn: data.isbn as string };
}

function mustGet(id: string): Book {
  const book = store.getBook(id);
  if (!book) throw new NotFound(`book ${id} not found`);
  return book;
}

export const listBooks = defineHandler((event) => {
  const { query } = req(event.http);
  const limit = Number(query.limit ?? "50");
  if (!Number.isInteger(limit)) throw new BadRequest("limit must be an integer");
  const items = store.listBooks(query.author).slice(0, Math.max(1, Math.min(limit, 100)));
  return { items, count: items.length }; // plain objects become JSON 200
});

export const getBook = defineHandler((event) => mustGet(req(event.http).pathParams.id));

export const createBook = defineHandler((event) => {
  const book = validate(req(event.http).json()); // malformed JSON -> automatic 400
  if (store.findByIsbn(book.isbn)) throw new Conflict(`a book with isbn ${book.isbn} already exists`);
  const created = store.putBook(book);
  return HttpResponse.json(created, 201, { location: `/books/${created.id}` });
});

export const updateBook = defineHandler((event) => {
  const http = req(event.http);
  const id = http.pathParams.id;
  mustGet(id);
  return store.putBook({ ...validate(http.json()), id });
});

export const deleteBook = defineHandler((event) => {
  const id = req(event.http).pathParams.id;
  if (!store.deleteBook(id)) throw new NotFound(`book ${id} not found`);
  return HttpResponse.noContent();
});

export const cover = defineHandler((event) => {
  mustGet(req(event.http).pathParams.id); // 404 for unknown ids
  // Binary bodies are base64-encoded for API gateways automatically.
  return HttpResponse.binary(PIXEL, "image/png", 200, { "cache-control": "public, max-age=86400" });
});

export const docs = defineHandler(() => HttpResponse.redirect("https://github.com/ak9347128658/node_serverless_kit#readme"));

export const createSession = defineHandler((event, ctx) => {
  const body = req(event.http).json<Record<string, unknown> | null>(null);
  const user = body && typeof body.user === "string" ? body.user : undefined;
  if (!user) throw new BadRequest("`user` is required");
  // Secure + HttpOnly + SameSite=Lax by default.
  return HttpResponse.json({ user, requestId: ctx.requestId }).setCookie("session", `demo-${user}`, { maxAge: 3600 });
});

export const adminStats = defineHandler(async (event) => {
  const http = req(event.http);
  const claims = await verifyHs256(bearerToken(http.headers.get("authorization")), getEnv("JWT_SECRET", "")!, {
    issuer: getEnv("JWT_ISSUER"),
    audience: getEnv("JWT_AUDIENCE"),
  });
  if (claims.role !== "admin") throw new Forbidden("admin role required");
  return { books: store.count(), user: claims.sub, sessionCookie: http.cookies.session ?? null };
});
