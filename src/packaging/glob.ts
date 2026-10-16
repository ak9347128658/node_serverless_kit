/** gitignore-like glob matching (`**` = any depth) and source collection. */

import { readdirSync } from "node:fs";
import path from "node:path";

export const DEFAULT_EXCLUDES = [
  ".git/**",
  ".hg/**",
  ".nskit/**",
  ".terraform/**",
  "node_modules/**",
  "coverage/**",
  ".idea/**",
  ".vscode/**",
  "**/.DS_Store",
  ".env",
  ".env.*",
  "**/*.tfstate",
  "**/*.tfstate.*",
  "nskit*.yml",
  "nskit*.yaml",
  "serverless-kit*.yml",
];

function escapeRe(c: string): string {
  return /[.+^${}()|[\]\\]/.test(c) ? "\\" + c : c;
}

/** Translate a gitignore-like glob into a RegExp over POSIX relative paths. */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.replace(/\\/g, "/");
  if (p.startsWith("./")) p = p.slice(2);
  if (p.endsWith("/")) p += "**";
  let out = "";
  for (let i = 0; i < p.length; ) {
    const c = p[i];
    if (c === "*") {
      if (p.startsWith("**/", i)) {
        out += "(?:.*/)?";
        i += 3;
        continue;
      }
      if (p.startsWith("**", i)) {
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += escapeRe(c);
    }
    i++;
  }
  return new RegExp(`^${out}$`);
}

function matchesAny(rel: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(rel));
}

/** Files under `source` matching `include` and not `exclude` (+ defaults), sorted. */
export function collectFiles(source: string, include: string[], exclude: string[] = []): string[] {
  if (!include.length) return [];
  const inc = include.map(globToRegExp);
  const exc = [...DEFAULT_EXCLUDES, ...exclude].map(globToRegExp);
  const files: string[] = [];
  const walk = (dir: string, relDir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const rel = relDir + entry.name;
      if (entry.isDirectory()) {
        // prune excluded directories early (fast on big node_modules)
        if (!matchesAny(`${rel}/x`, exc)) walk(path.join(dir, entry.name), `${rel}/`);
      } else if (entry.isFile() && matchesAny(rel, inc) && !matchesAny(rel, exc)) {
        files.push(path.join(dir, entry.name));
      }
    }
  };
  walk(source, "");
  return files;
}
