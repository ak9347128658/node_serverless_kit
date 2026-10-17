/**
 * Errors a handler can throw to produce a well-formed HTTP error response.
 *
 * For non-HTTP events they propagate unchanged, so the platform's retry and
 * dead-letter behaviour applies.
 */

const HTTP_ERROR = Symbol.for("node_serverless_kit.HttpError");

export interface HttpErrorOptions {
  status?: number;
  details?: unknown;
  headers?: Record<string, string>;
  cause?: unknown;
}

export class HttpError extends Error {
  static readonly defaultStatus: number = 500;
  static readonly defaultMessage: string = "Internal Server Error";

  readonly status: number;
  readonly details: unknown;
  readonly headers: Record<string, string>;
  readonly [HTTP_ERROR] = true;

  constructor(message?: string, options: HttpErrorOptions = {}) {
    const ctor = new.target as typeof HttpError;
    super(message || ctor.defaultMessage, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = ctor.name;
    this.status = options.status ?? ctor.defaultStatus;
    this.details = options.details;
    this.headers = { ...(options.headers ?? {}) };
  }

  toBody(): Record<string, unknown> {
    const body: Record<string, unknown> = { error: this.message, status: this.status };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

/** `instanceof` that also works when two copies of the library are loaded. */
export function isHttpError(value: unknown): value is HttpError {
  return value instanceof HttpError || (typeof value === "object" && value !== null && HTTP_ERROR in value);
}

export class BadRequest extends HttpError {
  static override readonly defaultStatus = 400;
  static override readonly defaultMessage = "Bad Request";
}

export class Unauthorized extends HttpError {
  static override readonly defaultStatus = 401;
  static override readonly defaultMessage = "Unauthorized";
}

export class Forbidden extends HttpError {
  static override readonly defaultStatus = 403;
  static override readonly defaultMessage = "Forbidden";
}

export class NotFound extends HttpError {
  static override readonly defaultStatus = 404;
  static override readonly defaultMessage = "Not Found";
}

export class MethodNotAllowed extends HttpError {
  static override readonly defaultStatus = 405;
  static override readonly defaultMessage = "Method Not Allowed";
}

export class Conflict extends HttpError {
  static override readonly defaultStatus = 409;
  static override readonly defaultMessage = "Conflict";
}

export class UnprocessableEntity extends HttpError {
  static override readonly defaultStatus = 422;
  static override readonly defaultMessage = "Unprocessable Entity";
}

export class TooManyRequests extends HttpError {
  static override readonly defaultStatus = 429;
  static override readonly defaultMessage = "Too Many Requests";
}

export class ServiceUnavailable extends HttpError {
  static override readonly defaultStatus = 503;
  static override readonly defaultMessage = "Service Unavailable";
}

/** Base class for errors raised by the kit itself. */
export class NskitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The configured handler could not be found in the bundle. */
export class HandlerNotFound extends NskitError {}

/** Name used to match workflow retry/catch rules: `error.error`, then `error.name`. */
export function errorName(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { error?: unknown; name?: unknown; constructor?: { name?: string } };
    if (typeof e.error === "string" && e.error) return e.error;
    if (typeof e.name === "string" && e.name && e.name !== "Error") return e.name;
    if (e.constructor?.name && e.constructor.name !== "Object") return e.constructor.name;
  }
  return "Error";
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
