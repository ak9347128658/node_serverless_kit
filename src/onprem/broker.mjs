/**
 * Zero-dependency stand-in for a queue, a topic and an object store.
 *
 * nskit starts this inside the on-premises process when `nskit.yml` does not
 * point `queue`, `topic` or `storage` at an existing service. Run it on its
 * own with `node broker.mjs` (port `NSKIT_BROKER_PORT`, default 7700) and point
 * a deployment at `http://<host>:7700`.
 *
 * HTTP:
 *   POST /v1/queues/:name/messages   {body, attributes}
 *   POST /v1/queues/:name/receive    {batchSize, waitMs, visibilityMs, maxReceive, deadLetter}
 *   POST /v1/queues/:name/ack        {ids}
 *   POST /v1/queues/:name/nack       {ids, maxReceive, deadLetter}
 *   POST /v1/topics/:name/messages   {body, attributes}
 *   POST /v1/topics/:name/pull       {cursor, waitMs, filter}
 *   PUT  /v1/buckets/:bucket/objects/<key>
 *   DELETE /v1/buckets/:bucket/objects/<key>
 *   POST /v1/buckets/:bucket/events  {cursor, waitMs, prefix, suffix, actions}
 */

import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_LOG = 10000;

function queuesOf(state) {
  return state.queues;
}

export function matchFilter(filter, attributes) {
  if (!filter || typeof filter !== "object") return true;
  const attrs = attributes && typeof attributes === "object" ? attributes : {};
  for (const [key, expected] of Object.entries(filter)) {
    const actual = attrs[key];
    if (Array.isArray(expected)) {
      const values = (Array.isArray(actual) ? actual : [actual]).map((v) => (v === undefined || v === null ? "" : String(v)));
      if (!expected.some((item) => values.includes(String(item)))) return false;
    } else if (actual === undefined || actual === null || String(actual) !== String(expected)) {
      return false;
    }
  }
  return true;
}

export function matchObject(spec, key) {
  const name = String(key);
  if (spec.prefix && !name.startsWith(String(spec.prefix))) return false;
  if (spec.suffix && !name.endsWith(String(spec.suffix))) return false;
  if (Array.isArray(spec.actions) && spec.actions.length && spec.action && !spec.actions.includes(spec.action)) return false;
  return true;
}

function waitFor(list, ms) {
  return new Promise((resolve) => {
    const item = { resolve };
    if (ms > 0) {
      item.timer = setTimeout(() => {
        const index = list.indexOf(item);
        if (index >= 0) list.splice(index, 1);
        resolve(null);
      }, ms);
    }
    list.push(item);
  });
}

function wakeOne(list, value) {
  const item = list.shift();
  if (!item) return false;
  if (item.timer) clearTimeout(item.timer);
  item.resolve(value);
  return true;
}

function wakeAll(list, value) {
  const pending = list.splice(0);
  for (const item of pending) {
    if (item.timer) clearTimeout(item.timer);
    item.resolve(value);
  }
}

export function createBroker(options = {}) {
  const state = { seq: 1, queues: new Map(), topics: new Map(), buckets: new Map(), objects: new Map() };
  const dataDir = options.dataDir || "";
  let closed = false;

  function nextId() {
    const id = String(state.seq);
    state.seq += 1;
    return id;
  }

  function queue(name) {
    let q = state.queues.get(name);
    if (!q) {
      q = { ready: [], inflight: new Map(), waiters: [] };
      state.queues.set(name, q);
    }
    return q;
  }

  function topic(name) {
    let t = state.topics.get(name);
    if (!t) {
      t = { events: [], waiters: [] };
      state.topics.set(name, t);
    }
    return t;
  }

  function bucketLog(name) {
    let log = state.buckets.get(name);
    if (!log) {
      log = { events: [], waiters: [] };
      state.buckets.set(name, log);
    }
    return log;
  }

  function objectMap(bucket) {
    let map = state.objects.get(bucket);
    if (!map) {
      map = new Map();
      state.objects.set(bucket, map);
    }
    return map;
  }

  function persist() {
    if (!dataDir) return;
    mkdirSync(dataDir, { recursive: true });
    const dump = {
      seq: state.seq,
      queues: [...state.queues.entries()].map(([name, q]) => [name, { ready: q.ready, inflight: [...q.inflight.values()] }]),
      topics: [...state.topics.entries()].map(([name, t]) => [name, t.events]),
      buckets: [...state.buckets.entries()].map(([name, log]) => [name, log.events]),
      objects: [...state.objects.entries()].map(([bucket, map]) => [
        bucket,
        [...map.entries()].map(([key, value]) => [key, Buffer.from(value).toString("base64")]),
      ]),
    };
    writeFileSync(path.join(dataDir, "broker.json"), JSON.stringify(dump));
  }

  function load() {
    if (!dataDir) return;
    let raw;
    try {
      raw = JSON.parse(readFileSync(path.join(dataDir, "broker.json"), "utf8"));
    } catch {
      return;
    }
    state.seq = Number(raw.seq) || 1;
    for (const [name, saved] of raw.queues ?? []) {
      const q = queue(name);
      q.ready = saved.ready ?? [];
      for (const msg of saved.inflight ?? []) q.ready.push(msg);
    }
    for (const [name, events] of raw.topics ?? []) topic(name).events = events ?? [];
    for (const [name, events] of raw.buckets ?? []) bucketLog(name).events = events ?? [];
    for (const [bucket, entries] of raw.objects ?? []) {
      const map = objectMap(bucket);
      for (const [key, b64] of entries) map.set(key, Buffer.from(b64, "base64"));
    }
  }

  function publicMessage(msg) {
    return { id: msg.id, body: msg.body, attributes: msg.attributes, receiveCount: msg.receiveCount };
  }

  function sweep(q, now) {
    for (const [id, msg] of q.inflight) {
      if (msg.inflightUntil <= now) {
        q.inflight.delete(id);
        q.ready.unshift(msg);
      }
    }
  }

  function enqueue(name, body, attributes = {}) {
    const msg = { id: nextId(), body: body ?? null, attributes: { ...attributes }, receiveCount: 0, inflightUntil: 0 };
    const q = queue(name);
    q.ready.push(msg);
    wakeOne(q.waiters, msg);
    persist();
    return msg.id;
  }

  async function receive(name, opts = {}) {
    const q = queue(name);
    const batchSize = Math.max(1, Number(opts.batchSize) || 1);
    const waitMs = Math.max(0, Number(opts.waitMs) || 0);
    const visibilityMs = Math.max(1000, Number(opts.visibilityMs) || 30000);
    const deadline = Date.now() + waitMs;
    const batch = [];
    while (batch.length < batchSize) {
      if (closed) break;
      sweep(q, Date.now());
      const msg = q.ready.shift();
      if (msg) {
        msg.receiveCount += 1;
        msg.inflightUntil = Date.now() + visibilityMs;
        q.inflight.set(msg.id, msg);
        batch.push(publicMessage(msg));
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) break;
      await waitFor(q.waiters, Math.min(left, 250));
    }
    if (batch.length) persist();
    return batch;
  }

  function takeInflight(name, ids) {
    const q = queue(name);
    const found = [];
    for (const id of ids) {
      const msg = q.inflight.get(String(id));
      if (!msg) continue;
      q.inflight.delete(String(id));
      found.push(msg);
    }
    return found;
  }

  function ack(name, ids) {
    const removed = takeInflight(name, ids);
    if (removed.length) persist();
    return removed.length;
  }

  function nack(name, ids, opts = {}) {
    const maxReceive = Number(opts.maxReceive) || 5;
    const deadLetter = opts.deadLetter ? String(opts.deadLetter) : "";
    const msgs = takeInflight(name, ids);
    for (const msg of msgs) {
      if (deadLetter && msg.receiveCount >= maxReceive) enqueue(deadLetter, msg.body, { ...msg.attributes, nskitDeadLetter: "1" });
      else queue(name).ready.unshift(msg);
    }
    if (msgs.length) persist();
    return msgs.length;
  }

  function publish(name, body, attributes = {}) {
    const event = { id: nextId(), body: body ?? null, attributes: { ...attributes }, time: new Date().toISOString() };
    const t = topic(name);
    t.events.push(event);
    if (t.events.length > MAX_LOG) t.events.splice(0, t.events.length - MAX_LOG);
    wakeAll(t.waiters, event);
    persist();
    return event.id;
  }

  async function pullTopic(name, opts = {}) {
    const t = topic(name);
    const cursor = Number(opts.cursor) || 0;
    const filter = opts.filter && typeof opts.filter === "object" ? opts.filter : undefined;
    const ready = t.events.filter((event) => Number(event.id) > cursor && matchFilter(filter, event.attributes));
    if (ready.length) return { cursor: ready[ready.length - 1].id, events: ready };
    const waitMs = Math.max(0, Number(opts.waitMs) || 0);
    if (!waitMs) return { cursor: String(cursor), events: [] };
    const event = await waitFor(t.waiters, waitMs);
    if (!event || Number(event.id) <= cursor || !matchFilter(filter, event.attributes)) return { cursor: String(cursor), events: [] };
    return { cursor: event.id, events: [event] };
  }

  function recordObject(bucket, key, action, size) {
    const event = { id: nextId(), bucket, key, size, action, time: new Date().toISOString() };
    const log = bucketLog(bucket);
    log.events.push(event);
    if (log.events.length > MAX_LOG) log.events.splice(0, log.events.length - MAX_LOG);
    wakeAll(log.waiters, event);
    return event;
  }

  function putObject(bucket, key, bytes) {
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? "");
    objectMap(bucket).set(key, body);
    const event = recordObject(bucket, key, "created", body.length);
    persist();
    return event;
  }

  function deleteObject(bucket, key) {
    const map = objectMap(bucket);
    if (!map.has(key)) return undefined;
    map.delete(key);
    const event = recordObject(bucket, key, "deleted", 0);
    persist();
    return event;
  }

  function getObject(bucket, key) {
    const body = objectMap(bucket).get(key);
    return body ? Buffer.from(body) : undefined;
  }

  async function pullStorage(bucket, opts = {}) {
    const log = bucketLog(bucket);
    const cursor = Number(opts.cursor) || 0;
    const spec = { prefix: opts.prefix, suffix: opts.suffix, actions: opts.actions };
    const ready = log.events.filter((event) => Number(event.id) > cursor && matchObject({ ...spec, action: event.action }, event.key));
    if (ready.length) return { cursor: ready[ready.length - 1].id, events: ready };
    const waitMs = Math.max(0, Number(opts.waitMs) || 0);
    if (!waitMs) return { cursor: String(cursor), events: [] };
    const event = await waitFor(log.waiters, waitMs);
    if (!event || Number(event.id) <= cursor || !matchObject({ ...spec, action: event.action }, event.key)) {
      return { cursor: String(cursor), events: [] };
    }
    return { cursor: event.id, events: [event] };
  }

  load();
  return {
    enqueue,
    receive,
    ack,
    nack,
    publish,
    pullTopic,
    putObject,
    deleteObject,
    getObject,
    pullStorage,
    close() {
      closed = true;
      for (const q of state.queues.values()) wakeAll(q.waiters, null);
      for (const t of state.topics.values()) wakeAll(t.waiters, null);
      for (const log of state.buckets.values()) wakeAll(log.waiters, null);
    },
    snapshot() {
      return { queues: [...queuesOf(state).keys()], topics: [...state.topics.keys()], buckets: [...state.buckets.keys()] };
    },
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined || body === null ? "" : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const type = Buffer.isBuffer(body) ? "application/octet-stream" : "application/json";
  res.writeHead(status, { "content-type": type, "content-length": payload.length, ...headers });
  res.end(payload);
}

async function jsonBody(req) {
  const raw = await readBody(req, 6 * 1024 * 1024);
  if (!raw.length) return {};
  return JSON.parse(raw.toString("utf8"));
}

/**
 * Serve the broker on an existing HTTP server. Returns true when the request
 * was a broker route.
 */
export async function handleBrokerRequest(broker, req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (parts[0] !== "v1") return false;
    if (parts[1] === "queues" && parts[3] === "messages" && req.method === "POST") {
      const body = await jsonBody(req);
      const id = broker.enqueue(decodeURIComponent(parts[2]), body.body ?? null, body.attributes);
      send(res, 202, { id });
      return true;
    }
    if (parts[1] === "queues" && parts[3] === "receive" && req.method === "POST") {
      const body = await jsonBody(req);
      const records = await broker.receive(decodeURIComponent(parts[2]), body);
      send(res, 200, { records });
      return true;
    }
    if (parts[1] === "queues" && (parts[3] === "ack" || parts[3] === "nack") && req.method === "POST") {
      const body = await jsonBody(req);
      const name = decodeURIComponent(parts[2]);
      const count = parts[3] === "ack" ? broker.ack(name, body.ids ?? []) : broker.nack(name, body.ids ?? [], body);
      send(res, 200, { count });
      return true;
    }
    if (parts[1] === "topics" && parts[3] === "messages" && req.method === "POST") {
      const body = await jsonBody(req);
      const id = broker.publish(decodeURIComponent(parts[2]), body.body ?? null, body.attributes);
      send(res, 202, { id });
      return true;
    }
    if (parts[1] === "topics" && parts[3] === "pull" && req.method === "POST") {
      const body = await jsonBody(req);
      send(res, 200, await broker.pullTopic(decodeURIComponent(parts[2]), body));
      return true;
    }
    if (parts[1] === "buckets" && parts[3] === "objects") {
      const bucket = decodeURIComponent(parts[2]);
      const key = parts.slice(4).map(decodeURIComponent).join("/");
      if (!key) {
        send(res, 400, { error: "object key is required" });
        return true;
      }
      if (req.method === "PUT") {
        const bytes = await readBody(req, 32 * 1024 * 1024);
        const event = broker.putObject(bucket, key, bytes);
        send(res, 201, { id: event.id, key, size: event.size });
        return true;
      }
      if (req.method === "DELETE") {
        const event = broker.deleteObject(bucket, key);
        send(res, event ? 200 : 404, event ? { id: event.id, key } : { error: "not found" });
        return true;
      }
      if (req.method === "GET") {
        const bytes = broker.getObject(bucket, key);
        if (!bytes) send(res, 404, { error: "not found" });
        else send(res, 200, bytes);
        return true;
      }
    }
    if (parts[1] === "buckets" && parts[3] === "events" && req.method === "POST") {
      const body = await jsonBody(req);
      send(res, 200, await broker.pullStorage(decodeURIComponent(parts[2]), body));
      return true;
    }
    return false;
  } catch (err) {
    send(res, err.status || 400, { error: err.message || "bad request" });
    return true;
  }
}

/** Client for a broker reached over HTTP (`queue: http://host:7700`). */
export function createHttpBroker(baseUrl) {
  const root = String(baseUrl).replace(/\/+$/, "");
  async function post(pathname, body, waitMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), waitMs + 5000);
    try {
      const resp = await fetch(root + pathname, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
      const text = await resp.text();
      const parsed = text ? JSON.parse(text) : {};
      if (!resp.ok) throw new Error(parsed.error || `broker ${resp.status}`);
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    enqueue: (name, body, attributes) => post(`/v1/queues/${encodeURIComponent(name)}/messages`, { body, attributes }).then((r) => r.id),
    receive: (name, opts) => post(`/v1/queues/${encodeURIComponent(name)}/receive`, opts, (opts.waitMs || 0) + 10000).then((r) => r.records),
    ack: (name, ids) => post(`/v1/queues/${encodeURIComponent(name)}/ack`, { ids }).then((r) => r.count),
    nack: (name, ids, opts) => post(`/v1/queues/${encodeURIComponent(name)}/nack`, { ids, ...opts }).then((r) => r.count),
    publish: (name, body, attributes) => post(`/v1/topics/${encodeURIComponent(name)}/messages`, { body, attributes }).then((r) => r.id),
    pullTopic: (name, opts) => post(`/v1/topics/${encodeURIComponent(name)}/pull`, opts, (opts.waitMs || 0) + 10000),
    putObject: async (bucket, key, bytes) => {
      const resp = await fetch(`${root}/v1/buckets/${encodeURIComponent(bucket)}/objects/${key.split("/").map(encodeURIComponent).join("/")}`, {
        method: "PUT",
        body: bytes,
      });
      if (!resp.ok) throw new Error(`broker put ${resp.status}`);
      return resp.json();
    },
    deleteObject: async (bucket, key) => {
      const resp = await fetch(`${root}/v1/buckets/${encodeURIComponent(bucket)}/objects/${key.split("/").map(encodeURIComponent).join("/")}`, {
        method: "DELETE",
      });
      if (resp.status === 404) return undefined;
      if (!resp.ok) throw new Error(`broker delete ${resp.status}`);
      return resp.json();
    },
    pullStorage: (bucket, opts) => post(`/v1/buckets/${encodeURIComponent(bucket)}/events`, opts, (opts.waitMs || 0) + 10000),
  };
}

export function listenBroker(broker, port = 0, host = "127.0.0.1") {
  const server = createServer((req, res) => {
    handleBrokerRequest(broker, req, res).then((handled) => {
      if (!handled) send(res, 404, { error: "not found" });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        server,
        port: address.port,
        url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const broker = createBroker({ dataDir: process.env.NSKIT_DATA_DIR || "" });
  const port = Number(process.env.NSKIT_BROKER_PORT || 7700);
  const host = process.env.NSKIT_BROKER_HOST || "0.0.0.0";
  listenBroker(broker, port, host).then((running) => {
    console.log(`nskit broker listening on ${running.url}`);
  });
}
