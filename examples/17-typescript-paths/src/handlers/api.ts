import { defineHandler } from "node_serverless_kit";
import { greeting, MAX_NAME_LENGTH } from "@lib/greeting";

/** GET /api/greeting?name=Ada - the same shared logic as JSON. */
export const greet = defineHandler((event) => ({
  greeting: greeting(event.http?.query.name),
  maxNameLength: MAX_NAME_LENGTH,
}));
