import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Event } from "../../src/runtime/event.js";
import { endpointEnvKey, invoke, InvokeError, physicalName } from "../../src/runtime/invoke.js";
import { setLogSink } from "../../src/runtime/log.js";
import { installBundle } from "../../src/runtime/manifest.js";

interface Received {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

let server: Server;
let baseUrl: string;
const received: Received[] = [];
let prevSink: ReturnType<typeof setLogSink>;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ echoed: (JSON.parse(raw) as { data: unknown }).data }));
      } else if (req.url === "/text") {
        res.end("plain text");
      } else if (req.url === "/empty") {
        res.writeHead(204);
        res.end();
      } else if (req.url === "/fail") {
        res.writeHead(500);
        res.end('{"errorType":"Error","cause":"exploded"}');
      } else if (req.url === "/stall") {
        res.writeHead(200, { "content-type": "application/json" });
        res.write("{");
        setTimeout(() => res.end("}"), 2000);
      } else if (req.url === "/slow") {
        setTimeout(() => res.end("{}"), 2000);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const seen: unknown[] = [];

beforeEach(() => {
  received.length = 0;
  seen.length = 0;
  prevSink = setLogSink(() => undefined);
  vi.stubEnv("NSKIT_PROVIDER", "local");
  installBundle({
    manifest: {
      service: "svc",
      stage: "dev",
      functions: {
        billing: { handler: "m.billing", resourceName: "svc-dev-billing-custom" },
        failing: { handler: "m.failing" },
      },
    },
    handlers: {
      "m.billing": () => (event: Event) => {
        seen.push({ type: event.type, data: event.data, fn: event.functionName });
        return { charged: event.data };
      },
      "m.failing": () => () => {
        throw new Error("billing down");
      },
    },
  });
});

afterEach(() => {
  setLogSink(prevSink);
  vi.unstubAllEnvs();
});

describe("helpers", () => {
  it("endpointEnvKey", () => {
    expect(endpointEnvKey("billing")).toBe("NSKIT_ENDPOINT_BILLING");
    expect(endpointEnvKey("send-email.v2")).toBe("NSKIT_ENDPOINT_SEND_EMAIL_V2");
  });

  it("physicalName prefers the manifest resourceName", () => {
    expect(physicalName("billing")).toBe("svc-dev-billing-custom");
    expect(physicalName("other")).toBe("svc-dev-other");
    installBundle({ manifest: { service: "", stage: "" } });
    vi.stubEnv("NSKIT_SERVICE", "envsvc");
    vi.stubEnv("NSKIT_STAGE", "prod");
    expect(physicalName("x")).toBe("envsvc-prod-x");
  });
});

describe("local", () => {
  it("calls the handler in-process as an invoke event", async () => {
    expect(await invoke("billing", { amount: 5 })).toEqual({ charged: { amount: 5 } });
    expect(seen).toEqual([{ type: "invoke", data: { amount: 5 }, fn: "billing" }]);
    expect(await invoke("billing")).toEqual({ charged: null });
  });

  it("propagates errors", async () => {
    await expect(invoke("failing", {})).rejects.toThrow("billing down");
    await expect(invoke("ghost", {})).rejects.toThrow(/Cannot resolve function "ghost"/);
  });

  it("async mode returns immediately and swallows errors", async () => {
    expect(await invoke("failing", {}, { async: true })).toBeUndefined();
    expect(await invoke("billing", { a: 1 }, { async: true })).toBeUndefined();
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
  });

  it("defaults to local when NSKIT_PROVIDER is unset", async () => {
    vi.stubEnv("NSKIT_PROVIDER", "");
    expect(await invoke("billing", 1)).toEqual({ charged: 1 });
  });
});

describe("HTTP endpoints (NSKIT_ENDPOINT_*)", () => {
  it("POSTs the invoke envelope and parses JSON", async () => {
    vi.stubEnv("NSKIT_PROVIDER", "azure");
    vi.stubEnv("NSKIT_ENDPOINT_BILLING", `${baseUrl}/ok`);
    expect(await invoke("billing", { amount: 7 }, { headers: { "x-api-key": "k" } })).toEqual({ echoed: { amount: 7 } });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: "POST", url: "/ok", body: { __nskit: "invoke", data: { amount: 7 } } });
    expect(received[0].headers["content-type"]).toBe("application/json");
    expect(received[0].headers["x-api-key"]).toBe("k");
    expect(seen).toEqual([]);
  });

  it("the endpoint override wins even locally", async () => {
    vi.stubEnv("NSKIT_ENDPOINT_BILLING", `${baseUrl}/ok`);
    expect(await invoke("billing")).toEqual({ echoed: null });
    expect(seen).toEqual([]);
  });

  it("returns text and empty bodies", async () => {
    vi.stubEnv("NSKIT_ENDPOINT_BILLING", `${baseUrl}/text`);
    expect(await invoke("billing", 1)).toBe("plain text");
    vi.stubEnv("NSKIT_ENDPOINT_BILLING", `${baseUrl}/empty`);
    expect(await invoke("billing", 1)).toBeUndefined();
  });

  it("raises InvokeError on HTTP errors, bad URLs, timeouts and refused connections", async () => {
    vi.stubEnv("NSKIT_ENDPOINT_BILLING", `${baseUrl}/fail`);
    await expect(invoke("billing", 1)).rejects.toThrow(InvokeError);
    await expect(invoke("billing", 1)).rejects.toThrow(/returned 500: \{"errorType":"Error","cause":"exploded"\}/);
    vi.stubEnv("NSKIT_ENDPOINT_BILLING", "ftp://nope");
    await expect(invoke("billing", 1)).rejects.toThrow(/must be an http\(s\) URL/);
    vi.stubEnv("NSKIT_ENDPOINT_BILLING", `${baseUrl}/slow`);
    await expect(invoke("billing", 1, { timeoutMs: 100 })).rejects.toThrow(/HTTP invoke of .* failed/);
    vi.stubEnv("NSKIT_ENDPOINT_BILLING", `${baseUrl}/stall`);
    await expect(invoke("billing", 1, { timeoutMs: 100 })).rejects.toThrow(/HTTP invoke of .* failed/);
    vi.stubEnv("NSKIT_ENDPOINT_BILLING", "http://127.0.0.1:1/");
    await expect(invoke("billing", 1)).rejects.toThrow(InvokeError);
  });
});

describe("other providers", () => {
  it("needs an endpoint on providers without native invoke", async () => {
    vi.stubEnv("NSKIT_PROVIDER", "azure");
    await expect(invoke("billing", {})).rejects.toThrow(/needs the target URL in \$NSKIT_ENDPOINT_BILLING/);
  });
});
