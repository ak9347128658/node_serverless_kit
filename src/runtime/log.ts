/**
 * Structured JSON logging that every provider's log pipeline can ingest.
 *
 * Set `NSKIT_LOG_FORMAT=text` for human readable output (the local CLI does
 * this) and `NSKIT_LOG_LEVEL` / `LOG_LEVEL` to control verbosity.
 */

import { getEnv } from "./util.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** A logger that adds `fields` to every line. */
  child(fields: Record<string, unknown>): Logger;
}

type Sink = (line: string, level: LogLevel) => void;

let sink: Sink = (line, level) => {
  // console.* is captured by every serverless platform's log pipeline.
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

/** Redirect log output (tests, local tools). Returns the previous sink. */
export function setLogSink(next: Sink): Sink {
  const prev = sink;
  sink = next;
  return prev;
}

function threshold(): number {
  const raw = (getEnv("NSKIT_LOG_LEVEL") ?? getEnv("LOG_LEVEL") ?? "info").toLowerCase();
  const normalized = raw === "warning" ? "warn" : raw === "critical" ? "error" : raw;
  return LEVELS[normalized as LogLevel] ?? LEVELS.info;
}

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return err;
}

function safeStringify(payload: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(payload, (_key, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Error) return serializeError(value);
    if (value instanceof Uint8Array) return `<${value.length} bytes>`;
    if (value && typeof value === "object") {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  });
}

class StructuredLogger implements Logger {
  constructor(
    private readonly name: string,
    private readonly fields: Record<string, unknown>,
  ) {}

  private write(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    // A log call must never crash a handler.
    try {
      if (LEVELS[level] < threshold()) return;
      const merged = { ...this.fields, ...(extra ?? {}) };
      if ((getEnv("NSKIT_LOG_FORMAT") ?? "json").toLowerCase() === "text") {
        const err = merged.error instanceof Error ? merged.error : undefined;
        if (err) delete merged.error;
        const kv = Object.entries(merged)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}=${typeof v === "string" ? v : safeStringify({ v }).slice(5, -1)}`)
          .join(" ");
        const ts = new Date().toISOString().slice(11, 23);
        let line = `${ts} ${level.toUpperCase().padEnd(5)} ${this.name}: ${message}${kv ? "  " + kv : ""}`;
        if (err?.stack) line += "\n" + err.stack;
        sink(line, level);
        return;
      }
      sink(
        safeStringify({ ts: new Date().toISOString(), level: level.toUpperCase(), logger: this.name, message, ...merged }),
        level,
      );
    } catch {
      /* swallow */
    }
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write("debug", message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.write("info", message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.write("warn", message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.write("error", message, fields);
  }
  child(fields: Record<string, unknown>): Logger {
    return new StructuredLogger(this.name, { ...this.fields, ...fields });
  }
}

export function getLogger(name = "nskit.function", fields: Record<string, unknown> = {}): Logger {
  return new StructuredLogger(name.startsWith("nskit") ? name : `nskit.${name}`, fields);
}
