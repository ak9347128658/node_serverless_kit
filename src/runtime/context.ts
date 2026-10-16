/** Provider-neutral invocation context. */

import { getLogger, type Logger } from "./log.js";
import { env, getEnv, randomId } from "./util.js";

export interface ContextInit {
  requestId?: string;
  functionName?: string;
  provider?: string;
  service?: string;
  stage?: string;
  region?: string;
  memoryMb?: number;
  /** Unix epoch milliseconds when the platform will stop this invocation. */
  deadline?: number;
  remainingTimeMs?: () => number;
  /** Cloudflare-style `waitUntil` to keep work alive after the response. */
  waitUntil?: (promise: Promise<unknown>) => void;
  raw?: unknown;
}

export class Context {
  requestId: string;
  functionName: string;
  provider: string;
  service: string;
  stage: string;
  region: string;
  memoryMb?: number;
  deadline?: number;
  /** The untouched native context object. */
  raw: unknown;
  private readonly remaining?: () => number;
  private readonly waitUntilFn?: (promise: Promise<unknown>) => void;
  private loggerInstance?: Logger;

  constructor(init: ContextInit = {}) {
    this.requestId = init.requestId || randomId();
    this.functionName = init.functionName ?? "";
    this.provider = init.provider ?? "local";
    this.service = init.service ?? getEnv("NSKIT_SERVICE", "")!;
    this.stage = init.stage ?? getEnv("NSKIT_STAGE", "")!;
    this.region = init.region ?? getEnv("NSKIT_REGION", "")!;
    this.memoryMb = init.memoryMb;
    this.deadline = init.deadline;
    this.raw = init.raw;
    this.remaining = init.remainingTimeMs;
    this.waitUntilFn = init.waitUntil;
  }

  /** Environment variables (works on Node and Cloudflare Workers). */
  get env(): Record<string, string | undefined> {
    return env();
  }

  /** Structured logger bound to this function and request. */
  get logger(): Logger {
    if (!this.loggerInstance) {
      this.loggerInstance = getLogger("nskit.function", {
        function: this.functionName,
        requestId: this.requestId,
        provider: this.provider,
      });
    }
    return this.loggerInstance;
  }

  /** Milliseconds until the platform stops this invocation, if known. */
  remainingTimeMs(): number | undefined {
    if (this.remaining) return Math.max(0, Math.floor(this.remaining()));
    if (this.deadline !== undefined) return Math.max(0, Math.floor(this.deadline - Date.now()));
    return undefined;
  }

  /**
   * Keep `promise` running after the response is sent where the platform
   * supports it (Cloudflare `waitUntil`). Elsewhere it is awaited before the
   * invocation finishes.
   */
  waitUntil(promise: Promise<unknown>): void {
    if (this.waitUntilFn) {
      this.waitUntilFn(promise);
      return;
    }
    this.pending.push(promise.catch((err: unknown) => this.logger.error("waitUntil task failed", { error: err })));
  }

  /** @internal promises registered with {@link waitUntil} on platforms without native support. */
  readonly pending: Promise<unknown>[] = [];
}
