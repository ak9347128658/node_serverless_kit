/** Locate files that ship inside the node_serverless_kit package itself. */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/** Root directory of the installed node_serverless_kit package (contains package.json and src/). */
export function packageRoot(): string {
  if (cached) return cached;
  const here = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (;;) {
    const pkg = path.join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, "utf-8")).name === "node_serverless_kit") return (cached = dir);
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`cannot locate the node_serverless_kit package root from ${here}`);
    dir = parent;
  }
}

/** Absolute path of a runtime module source, e.g. `runtimeSource("adapters/aws")`. */
export function runtimeSource(module: string): string {
  return path.join(packageRoot(), "src", "runtime", `${module}.ts`);
}

/** Absolute path of the runtime public API source (aliased as `node_serverless_kit` in bundles). */
export function publicApiSource(): string {
  return path.join(packageRoot(), "src", "index.ts");
}

/**
 * Stable import specifier for a kit runtime module (`node_serverless_kit/runtime/manifest`).
 *
 * The generated entry lives under the user's `.nskit/` directory, which is often a different
 * filesystem tree than the installed kit (temp-dir tests, a global install). A `path.relative`
 * import then walks to `/` and back; on macOS `/var` is a symlink to `/private/var`, so esbuild
 * realpath's the importer and the `../` chain lands on `/private/Users/...` instead of the kit.
 * The bundler's alias plugin maps this specifier to {@link runtimeSource}.
 */
export const RUNTIME_IMPORT_PREFIX = "node_serverless_kit/runtime/";

export function runtimeSpecifier(module: string): string {
  return RUNTIME_IMPORT_PREFIX + module;
}

/** POSIX relative import specifier from `fromDir` to `target` (always starts with `./` or `../`). */
export function importSpecifier(fromDir: string, target: string): string {
  const relative = path.relative(fromDir, target);
  // Different drive on Windows: fall back to an absolute path.
  if (path.isAbsolute(relative)) return relative.split(path.sep).join("/");
  let rel = relative.split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}
