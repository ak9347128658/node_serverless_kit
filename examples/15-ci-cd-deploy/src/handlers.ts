import { defineHandler } from "node-serverless-kit";

/** GET /health - used by the pipeline's post-deploy smoke test. */
export const health = defineHandler((_event, ctx) => ({
  status: "ok",
  stage: ctx.stage,
  version: ctx.env.APP_VERSION ?? "unknown", // git SHA injected by CI
}));
