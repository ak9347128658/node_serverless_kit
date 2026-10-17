/**
 * Portable function-to-function invocation.
 *
 * `await invoke("billing", { order: 1 })` calls another function of the same
 * service regardless of the cloud it runs on:
 *
 * - `NSKIT_ENDPOINT_<NAME>` env var set -> HTTP POST to that URL (any provider)
 * - local (CLI / tests)                  -> in-process call through the dispatcher
 * - aws                                  -> `lambda:InvokeFunction` (AWS SDK v3 from the Lambda runtime)
 * - gcp                                  -> authenticated HTTPS call (ID token from the metadata server)
 *
 * Other providers need `NSKIT_ENDPOINT_<NAME>` in the caller's `environment`
 * (for example the target's HTTP URL from `nskit info`).
 */

import { envelope } from "./envelope.js";
import { getManifest } from "./manifest.js";
import { getEnv, utf8Decode, utf8Encode } from "./util.js";

export class InvokeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InvokeError";
  }
}

export interface InvokeOptions {
  /** Fire and forget (AWS `Event` invocation type). Resolves to `undefined`. */
  async?: boolean;
  /** Timeout in milliseconds for HTTP based invocations. Default 30000. */
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export function endpointEnvKey(name: string): string {
  return "NSKIT_ENDPOINT_" + name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

export function physicalName(fn: string): string {
  const manifest = getManifest();
  const spec = manifest.functions[fn];
  if (spec?.resourceName) return spec.resourceName;
  const service = manifest.service || getEnv("NSKIT_SERVICE", "")!;
  const stage = manifest.stage || getEnv("NSKIT_STAGE", "")!;
  return [service, stage, fn].filter(Boolean).join("-");
}

async function httpPost(url: string, payload: unknown, options: InvokeOptions): Promise<unknown> {
  if (!/^https?:\/\//i.test(url)) throw new InvokeError(`invoke endpoint must be an http(s) URL, got ${JSON.stringify(url)}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  let resp: globalThis.Response;
  let text: string;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      body: JSON.stringify(envelope("invoke", payload)),
      signal: controller.signal,
    });
    // The timeout covers reading the body too (a server may stall after the headers).
    text = await resp.text();
  } catch (err) {
    throw new InvokeError(`HTTP invoke of ${url} failed: ${(err as Error).message}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw new InvokeError(`HTTP invoke of ${url} returned ${resp.status}: ${text.slice(0, 500)}`);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function gcpIdToken(audience: string): Promise<string> {
  const url =
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=" +
    encodeURIComponent(audience);
  const resp = await fetch(url, { headers: { "Metadata-Flavor": "Google" } });
  if (!resp.ok) throw new InvokeError(`could not get a GCP ID token (${resp.status})`);
  return resp.text();
}

// The AWS SDK v3 ships with the Lambda Node.js runtime; it is loaded lazily and
// kept external by the bundler so functions that never invoke pay nothing.
type LambdaModule = {
  LambdaClient: new (cfg: object) => { send(cmd: unknown): Promise<{ Payload?: Uint8Array; FunctionError?: string }> };
  InvokeCommand: new (input: object) => unknown;
};
let lambdaClient: InstanceType<LambdaModule["LambdaClient"]> | undefined;
let lambdaModule: LambdaModule | undefined;

async function awsInvoke(fn: string, payload: unknown, options: InvokeOptions): Promise<unknown> {
  if (!lambdaModule) {
    try {
      const name = "@aws-sdk/client-lambda";
      lambdaModule = (await import(/* @vite-ignore */ name)) as LambdaModule;
    } catch (err) {
      throw new InvokeError("@aws-sdk/client-lambda is required for invoke() on AWS", { cause: err });
    }
  }
  lambdaClient ??= new lambdaModule.LambdaClient({});
  const resp = await lambdaClient.send(
    new lambdaModule.InvokeCommand({
      FunctionName: physicalName(fn),
      InvocationType: options.async ? "Event" : "RequestResponse",
      Payload: utf8Encode(JSON.stringify(envelope("invoke", payload))),
    }),
  );
  if (options.async) return undefined;
  const body = resp.Payload ? utf8Decode(resp.Payload) : "";
  if (resp.FunctionError) throw new InvokeError(`${fn} failed: ${body}`);
  return body ? JSON.parse(body) : undefined;
}

/** Invoke another function of this service and return its result. */
export async function invoke<T = unknown>(fn: string, payload?: unknown, options: InvokeOptions = {}): Promise<T> {
  const override = getEnv(endpointEnvKey(fn));
  if (override) return (await httpPost(override, payload, options)) as T;

  const provider = getEnv("NSKIT_PROVIDER", "local");
  if (provider === "local") {
    const [{ Context }, { execute }, { Event, EventType }] = await Promise.all([
      import("./context.js"),
      import("./dispatch.js"),
      import("./event.js"),
    ]);
    const event = new Event({ type: EventType.INVOKE, provider: "local", functionName: fn, data: payload ?? null });
    const pending = execute(event, new Context({ functionName: fn }), fn);
    if (options.async) {
      pending.catch(() => undefined);
      return undefined as T;
    }
    return (await pending) as T;
  }
  if (provider === "aws") return (await awsInvoke(fn, payload, options)) as T;
  if (provider === "cloudflare") {
    // Service binding NSKIT_BINDING_<FN> (per-function `options.invokes`); the Cloudflare
    // adapter keeps the Worker `env` on globalThis under this key.
    const workerEnv = (globalThis as unknown as Record<symbol, Record<string, unknown> | undefined>)[
      Symbol.for("node_serverless_kit.cloudflare-env")
    ];
    const binding = workerEnv?.["NSKIT_BINDING_" + fn.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()] as
      | { fetch(url: string, init: RequestInit): Promise<globalThis.Response> }
      | undefined;
    if (binding && typeof binding.fetch === "function") {
      const resp = await binding.fetch("https://nskit.internal/", {
        method: "POST",
        headers: { "content-type": "application/json", ...(options.headers ?? {}) },
        body: JSON.stringify(envelope("invoke", payload)),
      });
      const text = await resp.text();
      if (!resp.ok) throw new InvokeError(`invoke of ${fn} via service binding returned ${resp.status}: ${text.slice(0, 500)}`);
      if (options.async || !text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as T;
      }
    }
  }
  if (provider === "gcp") {
    const project = getEnv("NSKIT_GCP_PROJECT") ?? getEnv("GOOGLE_CLOUD_PROJECT", "");
    const region = getEnv("NSKIT_REGION", "");
    const url = `https://${region}-${project}.cloudfunctions.net/${physicalName(fn)}`;
    const token = await gcpIdToken(url);
    return (await httpPost(url, payload, { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers } })) as T;
  }
  throw new InvokeError(
    `invoke() on provider ${JSON.stringify(provider)} needs the target URL in $${endpointEnvKey(fn)}. ` +
      "Give the target function an http event and set that URL in the caller's environment.",
  );
}
