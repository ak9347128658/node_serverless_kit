/**
 * Read configuration from environment variables, validated once per cold start.
 *
 * Values come from `provider.environment` + `functions.<fn>.environment` in nskit.yml
 * (resolved per stage). `getEnv` reads `process.env` on Node and the bindings on
 * Cloudflare Workers, so this module is portable.
 */

import { getEnv } from "node_serverless_kit";

export interface Settings {
  stage: string;
  tableName: string;
  logLevel: string;
  featureNewCheckout: boolean;
  apiBaseUrl: string;
  /** Never expose the secret itself. */
  paymentApiKeySet: boolean;
}

function bool(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

function required(name: string): string {
  const value = getEnv(name);
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

let cached: Settings | undefined;

export function getSettings(): Settings {
  cached ??= {
    stage: getEnv("NSKIT_STAGE", "local")!,
    tableName: required("TABLE_NAME"),
    logLevel: getEnv("LOG_LEVEL", "info")!,
    featureNewCheckout: bool(getEnv("FEATURE_NEW_CHECKOUT")),
    apiBaseUrl: getEnv("API_BASE_URL", "")!,
    paymentApiKeySet: Boolean(getEnv("PAYMENT_API_KEY")),
  };
  return cached;
}

/** For tests. */
export function resetSettings(): void {
  cached = undefined;
}
