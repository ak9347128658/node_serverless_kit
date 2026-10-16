import { defineConfig } from "tsup";

export default defineConfig([
  {
    // Public library entry points: dual ESM + CJS with type declarations.
    entry: {
      index: "src/index.ts",
      testing: "src/testing.ts",
      api: "src/api.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node20",
    platform: "node",
    // Shared chunks: index/testing/api use one copy of the runtime modules.
    splitting: true,
    shims: true,
  },
  {
    // The CLI. Shipped as ESM; bin/nskit.js imports it.
    entry: { cli: "src/cli/main.ts" },
    format: ["esm"],
    dts: false,
    sourcemap: true,
    clean: false,
    target: "node20",
    platform: "node",
    splitting: false,
    shims: true,
  },
]);
