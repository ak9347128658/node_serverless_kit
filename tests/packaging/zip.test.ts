import { createHash } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";
import path from "node:path";
import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { digest, zipDirectory } from "../../src/packaging/builder.js";
import { crc32, createZip } from "../../src/packaging/zip.js";
import { readZip, tempDir, writeFiles } from "../helpers.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const enc = (s: string) => Buffer.from(s, "utf-8");

describe("crc32", () => {
  it("matches known values and node:zlib", () => {
    expect(crc32(new Uint8Array())).toBe(0);
    expect(crc32(enc("123456789"))).toBe(0xcbf43926);
    const data = enc("The quick brown fox jumps over the lazy dog");
    expect(crc32(data)).toBe(zlibCrc32(data));
  });
});

describe("createZip", () => {
  const entries = [
    { name: "b.txt", data: enc("b".repeat(1000)) },
    { name: "a/z.json", data: enc('{"x":1}') },
    { name: "a\\win.txt", data: enc("windows separators") },
    { name: "ünï.txt", data: enc("utf-8 name") },
    { name: "empty", data: new Uint8Array() },
    { name: "bin.dat", data: new Uint8Array([0, 1, 2, 3, 255]) },
    { name: "run.sh", data: enc("#!/bin/sh\necho hi\n"), executable: true },
  ];

  it("is deterministic regardless of input order", () => {
    const one = createZip(entries);
    const two = createZip([...entries].reverse());
    expect(sha(one)).toBe(sha(two));
    expect(Buffer.compare(one, createZip(entries))).toBe(0);
  });

  it("produces a valid archive: sorted, fixed timestamps, correct contents", () => {
    const files = readZip(createZip(entries));
    expect(files.map((f) => f.name)).toEqual(["a/win.txt", "a/z.json", "b.txt", "bin.dat", "empty", "run.sh", "ünï.txt"]);
    for (const f of files) {
      expect(f.dosTime).toBe(0);
      expect(f.dosDate).toBe((1 << 5) | 1); // 1980-01-01
      expect(f.flags & 0x0800).toBe(0x0800); // UTF-8 names
      expect(f.crc).toBe(crc32(f.data));
    }
    const byName = Object.fromEntries(files.map((f) => [f.name, f]));
    expect(byName["b.txt"].data.toString()).toBe("b".repeat(1000));
    expect(byName["b.txt"].method).toBe(8); // compressible -> deflate
    expect(byName["bin.dat"].method).toBe(0); // tiny -> stored
    expect(byName["empty"].data.length).toBe(0);
    expect(byName["ünï.txt"].data.toString()).toBe("utf-8 name");
    expect(byName["run.sh"].externalAttrs >>> 16).toBe(0o100755);
    expect(byName["a/z.json"].externalAttrs >>> 16).toBe(0o100644);
  });

  it("an empty archive is just the end record", () => {
    const zip = createZip([]);
    expect(zip.length).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });
});

describe("zipDirectory / digest", () => {
  it("zips a directory tree reproducibly", () => {
    const dir = tempDir();
    writeFiles(dir, { "index.js": "module.exports = 1;\n", "lib/util.js": "x".repeat(500), "node_modules/p/package.json": "{}" });
    if (process.platform !== "win32") chmodSync(path.join(dir, "index.js"), 0o755);
    const out = tempDir();
    const first = path.join(out, "one.zip");
    const second = path.join(out, "two.zip");
    expect(zipDirectory(dir, first)).toBe(3);
    zipDirectory(dir, second);
    expect(digest(first)).toEqual(digest(second));
    const files = readZip(readFileSync(first));
    expect(files.map((f) => f.name)).toEqual(["index.js", "lib/util.js", "node_modules/p/package.json"]);
    // only extension-less files / *.sh are marked executable, so .js stays 0644 even when chmod +x
    expect(files[0].externalAttrs >>> 16).toBe(0o100644);
    const d = digest(first);
    expect(d.hex).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(d.base64, "base64").toString("hex")).toBe(d.hex);
  });
});
