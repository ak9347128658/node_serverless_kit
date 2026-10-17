/**
 * Produce queue messages, topic events and objects from a handler.
 *
 * On-premises installs an in-process bus on `globalThis` (the supervisor).
 * `NSKIT_QUEUE_URL`, `NSKIT_TOPIC_URL` and `NSKIT_STORAGE_URL` point at an HTTP
 * broker when the service runs somewhere else. `nskit dev` and local tests
 * (`NSKIT_PROVIDER=local`) keep an in-memory bus so a handler can still publish.
 * Other providers have no shared bus: use that cloud's SDK there.
 */

import { getEnv } from "./util.js";

const BUS = Symbol.for("node_serverless_kit.onprem-bus");
const MEMORY = Symbol.for("node_serverless_kit.local-bus");

export interface OnpremBus {
  enqueue?: (name: string, body: unknown, attributes?: Record<string, unknown>) => unknown;
  publish?: (name: string, body: unknown, attributes?: Record<string, unknown>) => unknown;
  putObject?: (bucket: string, key: string, bytes: Uint8Array) => unknown;
  deleteObject?: (bucket: string, key: string) => unknown;
}

interface MemoryBus extends OnpremBus {
  seq: number;
  messages: Map<string, { id: string; body: unknown; attributes: Record<string, unknown> }[]>;
  events: { id: string; topic: string; body: unknown; attributes: Record<string, unknown> }[];
  objects: Map<string, Uint8Array>;
}

function installed(): OnpremBus | undefined {
  return (globalThis as Record<symbol, OnpremBus | undefined>)[BUS];
}

function memoryBus(): MemoryBus {
  const slot = globalThis as Record<symbol, MemoryBus | undefined>;
  if (slot[MEMORY]) return slot[MEMORY];
  const bus: MemoryBus = {
    seq: 0,
    messages: new Map(),
    events: [],
    objects: new Map(),
    enqueue(name, body, attributes = {}) {
      const id = String(++bus.seq);
      const list = bus.messages.get(name) ?? [];
      list.push({ id, body: body ?? null, attributes });
      bus.messages.set(name, list);
      return id;
    },
    publish(name, body, attributes = {}) {
      const id = String(++bus.seq);
      bus.events.push({ id, topic: name, body: body ?? null, attributes });
      return id;
    },
    putObject(bucket, key, bytes) {
      bus.objects.set(`${bucket}/${key}`, bytes);
      return key;
    },
    deleteObject(bucket, key) {
      bus.objects.delete(`${bucket}/${key}`);
    },
  };
  slot[MEMORY] = bus;
  return bus;
}

function rootUrl(name: string): string {
  return (getEnv(name, "") ?? "").replace(/\/+$/, "");
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`on-premises service ${resp.status} ${url}: ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function asBytes(body: Uint8Array | string): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  return body;
}

/** Send one message to an on-premises queue. Returns the broker message id. */
export async function sendMessage(queue: string, body: unknown, attributes?: Record<string, unknown>): Promise<string> {
  const bus = installed();
  if (bus?.enqueue) return String((await bus.enqueue(queue, body, attributes)) ?? "");
  const root = rootUrl("NSKIT_QUEUE_URL");
  if (root) {
    const out = await postJson(`${root}/v1/queues/${encodeURIComponent(queue)}/messages`, { body, attributes });
    return String(out.id ?? "");
  }
  if (getEnv("NSKIT_PROVIDER", "local") === "local") return String(await memoryBus().enqueue!(queue, body, attributes));
  throw new Error("no on-premises queue. Deploy with provider onprem, or set NSKIT_QUEUE_URL to an HTTP broker");
}

/** Publish one event to an on-premises topic. Returns the event id. */
export async function publishEvent(topic: string, body: unknown, attributes?: Record<string, unknown>): Promise<string> {
  const bus = installed();
  if (bus?.publish) return String((await bus.publish(topic, body, attributes)) ?? "");
  const root = rootUrl("NSKIT_TOPIC_URL");
  if (root) {
    const out = await postJson(`${root}/v1/topics/${encodeURIComponent(topic)}/messages`, { body, attributes });
    return String(out.id ?? "");
  }
  if (getEnv("NSKIT_PROVIDER", "local") === "local") return String(await memoryBus().publish!(topic, body, attributes));
  throw new Error("no on-premises topic. Deploy with provider onprem, or set NSKIT_TOPIC_URL to an HTTP broker");
}

/** Store one object. `body` is text or bytes. */
export async function putObject(bucket: string, key: string, body: Uint8Array | string): Promise<void> {
  const bytes = asBytes(body);
  const bus = installed();
  if (bus?.putObject) {
    await bus.putObject(bucket, key, bytes);
    return;
  }
  const root = rootUrl("NSKIT_STORAGE_URL");
  if (root) {
    const resp = await fetch(`${root}/v1/buckets/${encodeURIComponent(bucket)}/objects/${key.split("/").map(encodeURIComponent).join("/")}`, {
      method: "PUT",
      body: bytes as BufferSource,
    });
    if (!resp.ok) throw new Error(`on-premises storage PUT ${resp.status}`);
    return;
  }
  if (getEnv("NSKIT_PROVIDER", "local") === "local") {
    await memoryBus().putObject!(bucket, key, bytes);
    return;
  }
  throw new Error("no on-premises object store. Deploy with provider onprem, or set NSKIT_STORAGE_URL");
}

/** Delete one object. Missing keys are ignored by the built-in broker. */
export async function deleteObject(bucket: string, key: string): Promise<void> {
  const bus = installed();
  if (bus?.deleteObject) {
    await bus.deleteObject(bucket, key);
    return;
  }
  const root = rootUrl("NSKIT_STORAGE_URL");
  if (root) {
    const resp = await fetch(`${root}/v1/buckets/${encodeURIComponent(bucket)}/objects/${key.split("/").map(encodeURIComponent).join("/")}`, {
      method: "DELETE",
    });
    if (!resp.ok && resp.status !== 404) throw new Error(`on-premises storage DELETE ${resp.status}`);
    return;
  }
  if (getEnv("NSKIT_PROVIDER", "local") === "local") {
    await memoryBus().deleteObject!(bucket, key);
    return;
  }
  throw new Error("no on-premises object store. Deploy with provider onprem, or set NSKIT_STORAGE_URL");
}
