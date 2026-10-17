import { defineHandler } from "node_serverless_kit";
import { getSettings } from "./settings.js";

/** GET /config - shows which settings the current stage resolved to. */
export const config = defineHandler((_event, ctx) => {
  const s = getSettings();
  return {
    stage: s.stage,
    table: s.tableName,
    logLevel: s.logLevel,
    newCheckout: s.featureNewCheckout,
    apiBaseUrl: s.apiBaseUrl,
    paymentApiKeyConfigured: s.paymentApiKeySet,
    memoryMb: ctx.memoryMb ?? null,
  };
});
