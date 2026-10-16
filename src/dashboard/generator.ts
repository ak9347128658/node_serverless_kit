/**
 * Generate the deployment dashboard: one self-contained `index.html`.
 *
 * The page lists every deployment found under `.nskit/*\/deployment.json` (all
 * providers and stages of the project) with functions, triggers, endpoints,
 * resource identifiers and workflows. It has no external dependencies, so it
 * can be opened from disk, served by `nskit dashboard --serve`, or uploaded to
 * any static host.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { buildRecord, RECORD_FILE, type DeploymentRecord } from "../core/describe.js";
import { WORK_DIR, type Project } from "../core/project.js";
import { VERSION } from "../version.js";
import { DASHBOARD_TEMPLATE } from "./template.js";

/** A deployment record as read from disk (any schema version, possibly partial). */
export type DashboardRecord = Partial<Omit<DeploymentRecord, "status">> & { status?: string };

/** Read every `.nskit/<provider>-<stage>/deployment.json` under `root`, skipping unreadable files. */
export function collectRecords(root: string): DashboardRecord[] {
  const base = path.join(root, WORK_DIR);
  if (!existsSync(base) || !statSync(base).isDirectory()) return [];
  const records: DashboardRecord[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const file = path.join(base, entry.name, RECORD_FILE);
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, "utf-8")) as unknown;
      if (data && typeof data === "object" && !Array.isArray(data)) records.push(data as DashboardRecord);
    } catch {
      /* broken file: skip it */
    }
  }
  const key = (r: DashboardRecord) => [r.service ?? "", r.provider ?? "", r.stage ?? ""].join("\0");
  return records.sort((a, b) => key(a).localeCompare(key(b)));
}

/** A record built from the config only (nothing deployed yet / `nskit dev`). */
export function localRecord(project: Project, status = "local"): DashboardRecord {
  return { ...buildRecord(project, {}, {}, "packaged"), status };
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** JSON that is safe inside a `<script>` element (no `</script>`, `<!--`, or line separators can break out). */
const LINE_SEP = new RegExp("\u2028", "g");
const PARA_SEP = new RegExp("\u2029", "g");

export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(LINE_SEP, "\\u2028")
    .replace(PARA_SEP, "\\u2029");
}

export interface RenderHtmlOptions {
  title?: string;
  /** Fixed timestamp (tests); default: now. */
  generatedAt?: string;
}

export function renderHtml(records: DashboardRecord[], options: RenderHtmlOptions = {}): string {
  const title = options.title ?? defaultTitle(records);
  const payload = scriptSafeJson({
    generatedAt: options.generatedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    nskitVersion: VERSION,
    deployments: records,
  });
  // Function replacements: `$` sequences in the data must not be interpreted.
  return DASHBOARD_TEMPLATE.replace(/\{\{TITLE\}\}/g, () => escapeHtml(title)).replace("{{DATA}}", () => payload);
}

function defaultTitle(records: DashboardRecord[]): string {
  const services = [...new Set(records.map((r) => r.service).filter((s): s is string => Boolean(s)))].sort();
  return `${services.join(" / ") || "Serverless"} dashboard`;
}

export function dashboardPath(root: string): string {
  return path.join(root, WORK_DIR, "dashboard", "index.html");
}

/** Write the dashboard (default `.nskit/dashboard/index.html`) and return its path. */
export function writeDashboard(
  root: string,
  options: { records?: DashboardRecord[]; output?: string; title?: string } = {},
): string {
  const records = options.records ?? collectRecords(root);
  const out = options.output ? path.resolve(options.output) : dashboardPath(root);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, renderHtml(records, { title: options.title }), "utf-8");
  return out;
}

/** Serve a single HTML file on `host:port` (`/` and `/<file name>`). Resolves once listening. */
export function serveDashboard(file: string, options: { host?: string; port?: number } = {}): Promise<{ server: Server; url: string }> {
  const host = options.host ?? "127.0.0.1";
  const name = path.basename(file);
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    if (urlPath !== "/" && urlPath !== `/${name}`) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not Found\n");
      return;
    }
    let body: Buffer;
    try {
      body = readFileSync(file); // re-read so a regenerated dashboard shows up on refresh
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Dashboard not generated\n");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": body.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8765, host, () => {
      server.off("error", reject);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : options.port;
      resolve({ server, url: `http://${host.includes(":") ? `[${host}]` : host}:${port}/${name}` });
    });
  });
}
