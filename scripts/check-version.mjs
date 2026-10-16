#!/usr/bin/env node
/**
 * Assert that package.json "version" equals `VERSION` in src/version.ts and,
 * optionally, a git tag.
 *
 * Usage:
 *
 *     node scripts/check-version.mjs                 # package.json == src/version.ts
 *     node scripts/check-version.mjs --tag v0.2.0    # ... and == the tag
 *     node scripts/check-version.mjs --tag           # tag taken from $GITHUB_REF_NAME
 *
 * In GitHub Actions tag builds (GITHUB_REF_TYPE=tag) the tag is checked even
 * without --tag. No dependencies.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`check-version: ${message}`);
  process.exit(1);
}

const pkgVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8")).version;
const versionTs = readFileSync(path.join(root, "src", "version.ts"), "utf-8");
const match = /export\s+const\s+VERSION\s*=\s*["']([^"']+)["']/.exec(versionTs);
if (!match) fail("could not find `export const VERSION = \"...\"` in src/version.ts");
const srcVersion = match[1];

if (pkgVersion !== srcVersion) {
  fail(`package.json version ${pkgVersion} != src/version.ts VERSION ${srcVersion}; set both to the same value`);
}

const args = process.argv.slice(2);
let tag;
const idx = args.indexOf("--tag");
if (idx >= 0) {
  const next = args[idx + 1];
  tag = next && !next.startsWith("--") ? next : process.env.GITHUB_REF_NAME;
  if (!tag) fail("--tag given without a value and GITHUB_REF_NAME is not set");
} else {
  const eq = args.find((a) => a.startsWith("--tag="));
  if (eq) tag = eq.slice("--tag=".length);
  else if (process.env.GITHUB_REF_TYPE === "tag") tag = process.env.GITHUB_REF_NAME;
}

if (tag !== undefined) {
  const tagVersion = tag.replace(/^refs\/tags\//, "").replace(/^v/, "");
  if (tagVersion !== pkgVersion) {
    fail(`tag ${tag} does not match package.json / src/version.ts version ${pkgVersion} (expected tag v${pkgVersion})`);
  }
}

console.log(`version ${pkgVersion} OK${tag !== undefined ? ` (tag ${tag})` : ""}`);
