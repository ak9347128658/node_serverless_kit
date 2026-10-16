"use strict";

const { BadRequest, HttpResponse, NotFound } = require("node-serverless-kit");
const store = require("./lib/store");

function mustGet(id) {
  const todo = store.get(id);
  if (!todo) throw new NotFound(`todo ${id} not found`);
  return todo;
}

/** GET /todos */
exports.list = async () => ({ items: store.list() });

/** POST /todos {"title": "..."} -> 201 */
exports.create = async (event) => {
  const body = event.http.json();
  if (!body || typeof body.title !== "string" || !body.title.trim()) throw new BadRequest("`title` is required");
  const todo = store.add(body.title.trim());
  return HttpResponse.json(todo, 201, { location: `/todos/${todo.id}` });
};

/** GET /todos/{id} */
exports.get = async (event) => mustGet(event.http.pathParams.id);

/** PATCH /todos/{id} - flip `done` */
exports.toggle = async (event) => {
  const todo = mustGet(event.http.pathParams.id);
  todo.done = !todo.done;
  return todo;
};
