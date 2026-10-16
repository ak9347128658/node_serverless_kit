import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogger, setLogSink, type LogLevel } from "../../src/runtime/log.js";

let lines: { line: string; level: LogLevel }[] = [];
let prev: ReturnType<typeof setLogSink>;

beforeEach(() => {
  lines = [];
  prev = setLogSink((line, level) => lines.push({ line, level }));
  vi.stubEnv("NSKIT_LOG_LEVEL", "");
  vi.stubEnv("LOG_LEVEL", "");
  vi.stubEnv("NSKIT_LOG_FORMAT", "");
});

afterEach(() => {
  setLogSink(prev);
  vi.unstubAllEnvs();
});

const parsed = () => lines.map((l) => JSON.parse(l.line));

describe("json format", () => {
  it("writes one JSON object per line with fields", () => {
    getLogger("orders", { function: "f" }).info("hello", { n: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("info");
    const [entry] = parsed();
    expect(entry).toMatchObject({ level: "INFO", logger: "nskit.orders", message: "hello", function: "f", n: 1 });
    expect(new Date(entry.ts).toString()).not.toBe("Invalid Date");
  });

  it("keeps the nskit prefix once and defaults the name", () => {
    getLogger("nskit.custom").info("a");
    getLogger().info("b");
    expect(parsed().map((e) => e.logger)).toEqual(["nskit.custom", "nskit.function"]);
  });

  it("serializes errors, bigint, bytes and circular values", () => {
    const circ: Record<string, unknown> = { a: 1 };
    circ.self = circ;
    getLogger("x").error("bad", { error: new TypeError("boom"), big: 5n, bytes: new Uint8Array(3), circ });
    const [e] = parsed();
    expect(e.error).toMatchObject({ name: "TypeError", message: "boom" });
    expect(e.error.stack).toContain("TypeError");
    expect(e.big).toBe("5");
    expect(e.bytes).toBe("<3 bytes>");
    expect(e.circ).toEqual({ a: 1, self: "[Circular]" });
    expect(lines[0].level).toBe("error");
  });

  it("child loggers merge fields; call fields win", () => {
    const child = getLogger("x", { a: 1, b: 1 }).child({ b: 2, c: 3 });
    child.warn("w", { c: 4 });
    expect(parsed()[0]).toMatchObject({ a: 1, b: 2, c: 4, level: "WARN" });
    expect(lines[0].level).toBe("warn");
  });

  it("never throws, even when the sink does", () => {
    setLogSink(() => {
      throw new Error("sink broken");
    });
    expect(() => getLogger("x").error("still fine")).not.toThrow();
  });
});

describe("levels", () => {
  const emitAll = () => {
    const log = getLogger("lvl");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    return parsed().map((e) => e.message);
  };

  it("defaults to info", () => {
    expect(emitAll()).toEqual(["i", "w", "e"]);
  });

  it.each([
    ["debug", ["d", "i", "w", "e"]],
    ["DEBUG", ["d", "i", "w", "e"]],
    ["warn", ["w", "e"]],
    ["warning", ["w", "e"]],
    ["error", ["e"]],
    ["critical", ["e"]],
    ["bogus", ["i", "w", "e"]],
  ])("NSKIT_LOG_LEVEL=%s", (level, expected) => {
    vi.stubEnv("NSKIT_LOG_LEVEL", level);
    expect(emitAll()).toEqual(expected);
  });

  it("falls back to LOG_LEVEL; NSKIT_LOG_LEVEL wins", () => {
    vi.stubEnv("LOG_LEVEL", "error");
    expect(emitAll()).toEqual(["e"]);
    lines = [];
    vi.stubEnv("NSKIT_LOG_LEVEL", "debug");
    expect(emitAll()).toEqual(["d", "i", "w", "e"]);
  });
});

describe("text format", () => {
  it("renders a human readable line with key=value pairs and the stack", () => {
    vi.stubEnv("NSKIT_LOG_FORMAT", "TEXT");
    const err = new Error("kaput");
    getLogger("api").error("failed", { requestId: "r1", obj: { a: 1 }, n: 2, skip: undefined, error: err });
    const text = lines[0].line;
    expect(text).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} ERROR nskit\.api: failed {2}requestId=r1 obj=\{"a":1\} n=2\n/);
    expect(text).not.toContain("skip=");
    expect(text).toContain(err.stack!.split("\n")[0]);
  });

  it("omits the separator without fields", () => {
    vi.stubEnv("NSKIT_LOG_FORMAT", "text");
    getLogger("api").info("plain");
    expect(lines[0].line).toMatch(/INFO {2}nskit\.api: plain$/);
  });
});
