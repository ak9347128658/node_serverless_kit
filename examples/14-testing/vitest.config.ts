import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Inside the node-serverless-kit repository the example runs against the sources;
// in your own project the installed package is used and this block does nothing.
const repoSrc = fileURLToPath(new URL("../../src/", import.meta.url));
const alias = existsSync(repoSrc + "index.ts")
  ? [
      { find: /^node-serverless-kit$/, replacement: repoSrc + "index.ts" },
      { find: /^node-serverless-kit\/testing$/, replacement: repoSrc + "testing.ts" },
    ]
  : [];

export default defineConfig({
  resolve: { alias },
  test: {
    include: ["tests/**/*.test.ts"],
    env: { NSKIT_LOG_LEVEL: "warn" },
  },
});
