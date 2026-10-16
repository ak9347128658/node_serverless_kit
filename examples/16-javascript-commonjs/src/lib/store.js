"use strict";

// In-memory store shared by the todo handlers. Use a database in production:
// instances do not share memory and are recycled at any time.
const todos = new Map();
let nextId = 1;

function list() {
  return [...todos.values()];
}

function add(title) {
  const todo = { id: String(nextId++), title, done: false };
  todos.set(todo.id, todo);
  return todo;
}

function get(id) {
  return todos.get(id);
}

module.exports = { list, add, get };
