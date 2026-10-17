import { defineHandler } from "node_serverless_kit";

/**
 * GET /health. The handler is the same on every deploy target.
 * `deploy` and `runtime` only change how the process is copied and started.
 */
export const health = defineHandler((event) => ({
  ok: true,
  provider: event.provider,
}));
