/**
 * Shared test fixtures: throwaway projects in the OS temp directory, a fake
 * artifact for rendering Terraform without bundling, and small utilities.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterAll } from "vitest";
import type { LoadOptions } from "../src/config/loader.js";
import { Project } from "../src/core/project.js";
import { RenderContext, type Artifact } from "../src/providers/base.js";
import type { TerraformDoc } from "../src/providers/terraform-doc.js";

const created: string[] = [];

afterAll(() => {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may still hold a handle; the OS cleans the temp dir eventually */
    }
  }
});

/** A fresh, empty directory under the OS temp dir (long path form, removed after the file's tests). */
export function tempDir(prefix = "nskit-test-"): string {
  const base = realpathSync.native(os.tmpdir());
  const dir = mkdtempSync(path.join(base, prefix));
  created.push(dir);
  return dir;
}

/** Strip the common leading indentation of a template literal (like Python's textwrap.dedent). */
export function dedent(text: string): string {
  const lines = text.replace(/^\n/, "").split("\n");
  const indents = lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min)).join("\n");
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, "utf-8");
  }
}

export interface TempProject {
  root: string;
  configPath: string;
  load(options?: LoadOptions): Project;
}

/** Handler module used by most fixtures (TypeScript, imports the package by name). */
export const HANDLERS_TS = dedent(`
  import { BatchResult, HttpResponse, NotFound, type Event, type Context } from "node-serverless-kit";

  export async function hello(event: Event, ctx: Context) {
    const name = event.http?.pathParams.name ?? event.http?.query.name ?? "world";
    return { message: \`hello \${name}\`, provider: event.provider, fn: ctx.functionName };
  }

  export function create(event: Event) {
    const body = event.http!.json<Record<string, unknown>>();
    if (!("id" in body)) throw new NotFound("missing id");
    return HttpResponse.json(body, 201);
  }

  export function worker(event: Event) {
    const result = new BatchResult();
    for (const record of event.records) if (record.text() === "fail") result.fail(record);
    return result;
  }

  export function tick(event: Event) {
    return { type: event.type, data: event.data, source: event.source ?? null };
  }

  export function step(event: Event) {
    const data = { ...((event.data as Record<string, number>) ?? {}) };
    data.steps = (data.steps ?? 0) + 1;
    return data;
  }

  export function env() {
    return { greeting: process.env.GREETING ?? null, fn: process.env.NSKIT_FUNCTION ?? null };
  }
`);

/** The full multi-trigger config used by provider tests (mirrors py-serverless-kit's conftest). */
export function fullConfig(provider = "aws", region = "eu-west-1", options = "{}"): string {
  return dedent(`
    service: demo
    provider:
      name: ${provider}
      region: ${region}
      options: ${options}
    functions:
      hello:
        handler: src/handlers.hello
        events:
          - http: GET /hello/{name}
          - http: {path: /hello, method: POST, cors: true}
      tick:
        handler: src/handlers.tick
        events:
          - schedule: 5 minutes
          - schedule: {cron: "0 12 * * 1", input: {report: weekly}}
      worker:
        handler: src/handlers.worker
        events:
          - queue: {name: jobs}
          - storage: {bucket: demo-uploads-1234, suffix: .csv}
          - topic: events
      step:
        handler: src/handlers.step
    workflows:
      pipeline:
        start_at: First
        states:
          First: {type: task, function: step, next: Second}
          Second: {type: task, function: step, end: true}
  `);
}

/**
 * Write `nskit.yml` (plus `src/handlers.ts` unless `files` overrides it) into a
 * new temp directory.
 */
export function makeProject(yaml: string, files: Record<string, string> = {}, configName = "nskit.yml"): TempProject {
  const root = tempDir();
  writeFiles(root, { "src/handlers.ts": HANDLERS_TS, ...files, [configName]: dedent(yaml) });
  const configPath = path.join(root, configName);
  return { root, configPath, load: (options = {}) => Project.load(configPath, options) };
}

export function fakeArtifact(root = os.tmpdir(), entryFile = "index.js"): Artifact {
  return {
    path: path.join(root, "artifact.zip"),
    sha256: "ab".repeat(32),
    sha256Base64: "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s=",
    size: 1234,
    fileCount: 3,
    buildDir: path.join(root, "build"),
    entryFile,
  };
}

export function renderContext(project: Project): RenderContext {
  return new RenderContext({
    config: project.config,
    provider: project.provider,
    root: project.root,
    workDir: project.workDir,
    artifact: fakeArtifact(project.workDir, project.provider.bundleTarget(project.config).entryFile),
    region: project.region,
    workflowEngines: { ...project.engines },
  });
}

/** Render a project's Terraform without bundling (fake artifact). */
export function renderDoc(project: Project): TerraformDoc {
  return project.provider.render(renderContext(project));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function render(project: Project): Record<string, any> {
  return JSON.parse(renderDoc(project).toJSON());
}

// ------------------------------------------------------------------ zip reading

export interface ZipFileEntry {
  name: string;
  data: Buffer;
  method: number;
  crc: number;
  dosTime: number;
  dosDate: number;
  flags: number;
  externalAttrs: number;
}

/** Minimal ZIP reader (central directory + local headers), enough to verify our writer. */
export function readZip(buf: Buffer): ZipFileEntry[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("no end of central directory");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: ZipFileEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error("bad central directory header");
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const dosTime = buf.readUInt16LE(offset + 12);
    const dosDate = buf.readUInt16LE(offset + 14);
    const crc = buf.readUInt32LE(offset + 16);
    const compSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const externalAttrs = buf.readUInt32LE(offset + 38);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf-8");
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    const data = method === 8 ? inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : null;
    if (!data) throw new Error(`unsupported method ${method}`);
    if (data.length !== size) throw new Error(`size mismatch for ${name}`);
    entries.push({ name, data, method, crc, dosTime, dosDate, flags, externalAttrs });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
