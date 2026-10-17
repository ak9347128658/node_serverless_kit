/**
 * On-premises process: one Node.js server for every function in the service.
 *
 * It serves HTTP, fires schedules, and consumes queues, topics and storage
 * events. Backing services are the built-in broker, Redis, MinIO/S3, a
 * directory, or an HTTP broker started elsewhere. `platform.json` (written by
 * the provider at deploy time) says which.
 */

import { createServer } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBroker, createHttpBroker, matchFilter } from "./broker.mjs";
import { createRedisBroker } from "./redis.mjs";
import { createS3Client } from "./s3.mjs";

export const CALL_ENV = Symbol.for("node_serverless_kit.call-env");
const BATCH_RESULT = Symbol.for("node_serverless_kit.BatchResult");
const BUS = Symbol.for("node_serverless_kit.onprem-bus");

const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTH_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function numberOrName(token, names) {
  const lower = String(token).toLowerCase();
  if (names && lower in names) return names[lower];
  return Number(token);
}

/** True when one cron field matches `value`. `*` and lists, ranges and steps work. */
export function fieldMatches(field, value, min, max, names) {
  if (!field || field === "*") return true;
  return String(field).split(",").some((part) => {
    const [base, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!step) return false;
    let start = min;
    let end = max;
    if (base !== "*") {
      const [rawStart, rawEnd] = base.split("-");
      start = numberOrName(rawStart, names);
      end = rawEnd === undefined ? start : numberOrName(rawEnd, names);
    }
    if (value < start || value > end) return false;
    return (value - start) % step === 0;
  });
}

export function zonedParts(date, timeZone) {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || "UTC",
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(formatted.map((part) => [part.type, part.value]));
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  return {
    minute: Number(map.minute),
    hour,
    day: Number(map.day),
    month: Number(map.month),
    dow: { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[map.weekday] ?? 0,
    stamp: `${map.year}-${map.month}-${map.day} ${String(hour).padStart(2, "0")}:${map.minute}`,
  };
}

/** Standard 5-field cron. When both day-of-month and day-of-week are set, either match is enough. */
export function cronMatches(expression, date, timeZone = "UTC") {
  const fields = String(expression).trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dom, month, dow] = fields;
  const parts = zonedParts(date, timeZone);
  if (!fieldMatches(minute, parts.minute, 0, 59)) return false;
  if (!fieldMatches(hour, parts.hour, 0, 23)) return false;
  if (!fieldMatches(month, parts.month, 1, 12, MONTH_NAMES)) return false;
  const domSet = dom !== "*";
  const dowSet = dow !== "*";
  const domOk = fieldMatches(dom, parts.day, 1, 31);
  const dowOk = fieldMatches(dow, parts.dow, 0, 7, DOW_NAMES) || (parts.dow === 0 && fieldMatches(dow, 7, 0, 7, DOW_NAMES));
  if (domSet && dowSet) return domOk || dowOk;
  return domOk && dowOk;
}

function splitPath(value) {
  return String(value).split("?")[0].split("/").filter((part) => part.length > 0);
}

function decode(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

export function matchPath(pattern, requestPath) {
  const pat = splitPath(pattern);
  const parts = splitPath(requestPath);
  const params = {};
  for (let i = 0; i < pat.length; i++) {
    const seg = pat[i];
    if (seg.startsWith("{") && seg.endsWith("}")) {
      const name = seg.slice(1, -1);
      if (name.endsWith("+")) {
        if (i !== pat.length - 1 || i >= parts.length) return null;
        params[name.slice(0, -1)] = parts.slice(i).map(decode).join("/");
        return params;
      }
      if (i >= parts.length) return null;
      params[name] = decode(parts[i]);
    } else if (i >= parts.length || seg !== parts[i]) {
      return null;
    }
  }
  return parts.length === pat.length ? params : null;
}

export function methodMatches(allowed, method) {
  const want = String(allowed || "GET").toUpperCase();
  const got = String(method || "GET").toUpperCase();
  return want === "ANY" || want === "*" || want === got || (want === "GET" && got === "HEAD");
}

/** Pick the function that owns this request. A path match with the wrong method still wins (the runtime answers 405). */
export function pickFunction(platform, method, requestPath) {
  let pathOnly;
  for (const [name, spec] of Object.entries(platform.functions || {})) {
    for (const route of spec.routes || []) {
      if (matchPath(route.path, requestPath) === null) continue;
      if (methodMatches(route.method, method)) return { name, route };
      pathOnly ??= { name, route };
    }
  }
  return pathOnly || null;
}

function readBody(req, limit = 6 * 1024 * 1024) {
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

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": payload.length });
  res.end(payload);
}

function failedIds(result) {
  if (result && typeof result === "object" && BATCH_RESULT in result && Array.isArray(result.failed)) {
    return new Set(result.failed.map(String));
  }
  return null;
}

function safeObjectKey(key) {
  const rel = String(key).replace(/\\/g, "/");
  if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) throw new Error("object key must be a relative path");
  return rel;
}

function loadPlatform(options) {
  if (options.platform && typeof options.platform === "object") return options.platform;
  const file = options.platformFile || process.env.NSKIT_PLATFORM;
  if (!file) throw new Error("NSKIT_PLATFORM is not set");
  return JSON.parse(readFileSync(file, "utf8"));
}

function walkFiles(dir, prefix = "") {
  const found = [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of names) {
    const rel = prefix ? `${prefix}/${name}` : name;
    let st;
    try {
      st = statSync(path.join(dir, name));
    } catch {
      continue;
    }
    if (st.isDirectory()) found.push(...walkFiles(path.join(dir, name), rel));
    else found.push({ key: rel.replace(/\\/g, "/"), size: st.size });
  }
  return found;
}

async function openRedis(cache, url) {
  if (!url) throw new Error("redis url is empty");
  if (!cache.has(url)) cache.set(url, await createRedisBroker(url));
  return cache.get(url);
}

/**
 * Start the platform. Resolves once HTTP is listening.
 * `close()` stops schedules, consumers and the server.
 */
export async function startPlatform(options = {}) {
  const platform = loadPlatform(options);
  const entry = options.entry || process.env.NSKIT_ENTRY || platform.entry;
  if (!entry) throw new Error("NSKIT_ENTRY is not set");
  // Captured before processEnv is copied. start.sh sets these because a copied
  // bundle does not know its absolute path when platform.json is written.
  const dataDir = options.dataDir || process.env.NSKIT_DATA_DIR || platform.dataDir || "";
  const bundle = createRequire(entry)(entry);
  if (typeof bundle.handler !== "function") throw new Error(`bundle ${entry} does not export handler`);

  const als = new AsyncLocalStorage();
  globalThis[CALL_ENV] = als;
  const shared = platform.processEnv || {};
  for (const [key, value] of Object.entries(shared)) {
    if (value !== undefined && value !== null) process.env[key] = String(value);
  }

  let stopped = false;
  const timers = [];
  const stops = [];
  const redisCache = new Map();
  let builtin;
  function builtinBroker() {
    builtin ??= createBroker({ dataDir });
    return builtin;
  }

  function dirRoot(spec) {
    return process.env.NSKIT_STORAGE_DIR || spec.path || dataDir || ".";
  }

  async function serviceClient(spec) {
    if (!spec || spec.kind === "builtin" || spec.kind === "none") return builtinBroker();
    if (spec.kind === "http") return createHttpBroker(spec.url);
    if (spec.kind === "redis") return openRedis(redisCache, spec.url);
    return null;
  }

  const services = platform.services || {};
  globalThis[BUS] = {
    enqueue(name, body, attributes) {
      return serviceClient(services.queue).then((client) => client.enqueue(name, body, attributes || {}));
    },
    publish(name, body, attributes) {
      return serviceClient(services.topic).then((client) => client.publish(name, body, attributes || {}));
    },
    async putObject(bucket, key, bytes) {
      const spec = services.storage || { kind: "builtin" };
      const body = Buffer.from(bytes);
      const rel = safeObjectKey(key);
      if (spec.kind === "dir") {
        const file = path.join(dirRoot(spec), rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, body);
        return key;
      }
      if (spec.kind === "s3") {
        await createS3Client(spec).put(bucket, rel, body);
        return rel;
      }
      return (await serviceClient(spec)).putObject(bucket, rel, body);
    },
    async deleteObject(bucket, key) {
      const spec = services.storage || { kind: "builtin" };
      const rel = safeObjectKey(key);
      if (spec.kind === "dir") {
        try {
          unlinkSync(path.join(dirRoot(spec), rel));
        } catch {
          /* already gone */
        }
        return;
      }
      if (spec.kind === "s3") {
        await createS3Client(spec).remove(bucket, rel);
        return;
      }
      return (await serviceClient(spec)).deleteObject(bucket, rel);
    },
  };

  async function call(functionName, raw) {
    const spec = (platform.functions || {})[functionName] || {};
    const env = spec.environment || {};
    return als.run({ ...env }, () => bundle.handler(raw, { functionName, timeoutMs: (Number(spec.timeout) || 30) * 1000 }));
  }

  async function fireSchedule(spec, input) {
    const data = input === undefined ? (spec.input ?? null) : input;
    return call(spec.function, {
      __nskit: "schedule",
      data,
      source: "onprem.scheduler",
      time: new Date().toISOString(),
    });
  }

  const http = platform.http || {};
  const host = options.host || http.host || "0.0.0.0";
  const port = options.port ?? http.port ?? 8080;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/__nskit/health") {
        sendJson(res, 200, { ok: true, service: platform.service, stage: platform.stage, provider: "onprem" });
        return;
      }
      const workflow = url.pathname.match(/^\/__nskit\/workflows\/([^/]+)$/);
      const direct = url.pathname.match(/^\/__nskit\/functions\/([^/]+)$/);
      if ((workflow || direct) && req.method === "POST") {
        if (platform.apiKey && req.headers["x-api-key"] !== platform.apiKey) {
          sendJson(res, 401, { error: "Unauthorized", status: 401 });
          return;
        }
        const name = decodeURIComponent((workflow || direct)[1]);
        const target = workflow ? `${name}-orchestrator` : name;
        if (workflow && !(platform.workflows || {})[name]) {
          sendJson(res, 404, { error: `unknown workflow ${name}`, status: 404 });
          return;
        }
        const bytes = await readBody(req);
        const text = bytes.toString("utf8");
        let data = null;
        if (text) data = JSON.parse(text);
        const result = await call(target, { __nskit: workflow ? "workflow" : "invoke", data, source: "onprem.http" });
        const gateway = result && typeof result === "object" && typeof result.status === "number" && result.headers;
        const status = gateway ? result.status : 200;
        const payload = gateway ? String(result.body ?? "") : JSON.stringify(result ?? null);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(payload);
        return;
      }
      const picked = pickFunction(platform, req.method || "GET", url.pathname);
      if (!picked) {
        sendJson(res, 404, { error: "Not Found", status: 404 });
        return;
      }
      if (picked.route.auth === "key") {
        const expected = picked.route.key || platform.apiKey || "";
        if (!expected || req.headers["x-api-key"] !== expected) {
          sendJson(res, 401, { error: "Unauthorized", status: 401 });
          return;
        }
      }
      const bytes = await readBody(req);
      const result = await call(picked.name, {
        http: {
          method: req.method,
          path: url.pathname,
          headers: req.headers,
          queryString: url.search.replace(/^\?/, ""),
          body: bytes.toString("base64"),
          isBase64Encoded: true,
          sourceIp: req.socket.remoteAddress,
        },
      });
      const gateway = result && typeof result === "object" && "status" in result ? result : { status: 200, headers: {}, body: "", isBase64: false };
      const payload = gateway.isBase64 ? Buffer.from(String(gateway.body || ""), "base64") : Buffer.from(String(gateway.body ?? ""));
      res.writeHead(gateway.status || 200, gateway.headers || {});
      res.end(payload);
    } catch (err) {
      if (!res.headersSent) sendJson(res, err.status || 500, { error: "Internal Server Error", status: err.status || 500 });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();

  if (options.workers !== false) {
    const queueClient = (platform.queues || []).length ? await serviceClient(services.queue) : null;
    const topicClient = (platform.topics || []).length ? await serviceClient(services.topic) : null;
    const storageSpec = services.storage || { kind: "builtin" };
    const storageClient = (platform.storage || []).length && (storageSpec.kind === "builtin" || storageSpec.kind === "http")
      ? await serviceClient(storageSpec)
      : null;

    const loops = [];
    const track = (fn) => {
      const done = (async () => {
        while (!stopped) {
          try {
            await fn();
          } catch (err) {
            console.error("[onprem]", err && err.message ? err.message : err);
            await new Promise((resolve) => setTimeout(resolve, platform.pollMs || 1000));
          }
        }
      })();
      loops.push(done);
    };

    for (const sub of platform.queues || []) {
      track(async () => {
        const records = await queueClient.receive(sub.name, {
          batchSize: sub.batchSize || 1,
          waitMs: Math.max((sub.batchWindow || 0) * 1000, platform.pollMs || 1000),
          visibilityMs: (sub.visibilityTimeout || sub.timeout || 30) * 1000,
          maxReceive: sub.maxReceive || 5,
          deadLetter: sub.deadLetter || "",
        });
        if (!records.length || stopped) return;
        const ids = records.map((record) => String(record.id));
        try {
          const result = await call(sub.function, { type: "queue", queue: sub.name, records });
          const failed = failedIds(result);
          if (!failed) {
            await queueClient.ack(sub.name, ids);
            return;
          }
          const bad = ids.filter((id) => failed.has(id));
          const ok = ids.filter((id) => !failed.has(id));
          if (ok.length) await queueClient.ack(sub.name, ok);
          if (bad.length) await queueClient.nack(sub.name, bad, sub);
        } catch {
          await queueClient.nack(sub.name, ids, sub);
        }
      });
    }

    for (const sub of platform.topics || []) {
      if (services.topic && services.topic.kind === "redis") {
        const redis = await openRedis(redisCache, services.topic.url);
        const stop = redis.subscribe(sub.name, (event) => {
          if (!matchFilter(sub.filter, event.attributes)) return;
          call(sub.function, { type: "topic", topic: sub.name, records: [event] }).catch((err) => console.error("[onprem] topic", err.message));
        });
        stops.push(stop);
      } else {
        let cursor = "0";
        track(async () => {
          const pulled = await topicClient.pullTopic(sub.name, { cursor, waitMs: platform.pollMs || 1000, filter: sub.filter || null });
          cursor = String(pulled.cursor || cursor);
          if (!pulled.events || !pulled.events.length) return;
          await call(sub.function, { type: "topic", topic: sub.name, records: pulled.events });
        });
      }
    }

    if (storageSpec.kind === "dir") {
      const seen = new Map();
      for (const sub of platform.storage || []) {
        const root = storageSpec.path;
        mkdirSync(root, { recursive: true });
        seen.set(sub.function + sub.bucket, new Map(walkFiles(root).map((file) => [file.key, file.size])));
        track(async () => {
          const previous = seen.get(sub.function + sub.bucket);
          const current = new Map(walkFiles(root).map((file) => [file.key, file.size]));
          const records = [];
          for (const [key, size] of current) {
            if (previous.has(key) && previous.get(key) === size) continue;
            if (!(sub.events || ["created"]).includes("created")) continue;
            if (sub.prefix && !key.startsWith(sub.prefix)) continue;
            if (sub.suffix && !key.endsWith(sub.suffix)) continue;
            records.push({ id: key, bucket: sub.bucket, key, size, action: "created" });
          }
          for (const key of previous.keys()) {
            if (current.has(key)) continue;
            if (!(sub.events || ["created"]).includes("deleted")) continue;
            if (sub.prefix && !key.startsWith(sub.prefix)) continue;
            if (sub.suffix && !key.endsWith(sub.suffix)) continue;
            records.push({ id: `${key}:deleted`, bucket: sub.bucket, key, size: 0, action: "deleted" });
          }
          seen.set(sub.function + sub.bucket, current);
          if (records.length) await call(sub.function, { type: "storage", records });
          await new Promise((resolve) => setTimeout(resolve, platform.pollMs || 1000));
        });
      }
    } else if (storageSpec.kind === "s3") {
      const s3 = createS3Client(storageSpec);
      for (const sub of platform.storage || []) {
        const seen = new Map();
        let primed = false;
        track(async () => {
          const objects = await s3.list(sub.bucket, sub.prefix || "");
          const current = new Map(objects.map((object) => [object.key, object.size]));
          if (!primed) {
            primed = true;
            for (const [key, size] of current) seen.set(key, size);
          } else {
            const records = [];
            for (const [key, size] of current) {
              if (seen.has(key)) continue;
              if (sub.suffix && !key.endsWith(sub.suffix)) continue;
              if (!(sub.events || ["created"]).includes("created")) continue;
              records.push({ id: key, bucket: sub.bucket, key, size, action: "created" });
            }
            for (const key of seen.keys()) {
              if (current.has(key)) continue;
              if (sub.suffix && !key.endsWith(sub.suffix)) continue;
              if (!(sub.events || ["created"]).includes("deleted")) continue;
              records.push({ id: `${key}:deleted`, bucket: sub.bucket, key, size: 0, action: "deleted" });
            }
            if (records.length) await call(sub.function, { type: "storage", records });
          }
          seen.clear();
          for (const [key, size] of current) seen.set(key, size);
          await new Promise((resolve) => setTimeout(resolve, (storageSpec.pollSeconds || 5) * 1000));
        });
      }
    } else {
      for (const sub of platform.storage || []) {
        let cursor = "0";
        track(async () => {
          const pulled = await storageClient.pullStorage(sub.bucket, {
            cursor,
            waitMs: platform.pollMs || 1000,
            prefix: sub.prefix || "",
            suffix: sub.suffix || "",
            actions: sub.events || ["created"],
          });
          cursor = String(pulled.cursor || cursor);
          if (!pulled.events || !pulled.events.length) return;
          const records = pulled.events.map((event) => ({
            id: event.id,
            bucket: event.bucket,
            key: event.key,
            size: event.size,
            action: event.action,
          }));
          await call(sub.function, { type: "storage", records });
        });
      }
    }

    const lastFire = new Map();
    for (const spec of platform.schedules || []) {
      if (spec.enabled === false) continue;
      if (spec.everySeconds) {
        timers.push(setInterval(() => {
          fireSchedule(spec).catch((err) => console.error("[onprem] schedule", err.message));
        }, Math.max(1, spec.everySeconds) * 1000));
      } else if (spec.cron) {
        timers.push(setInterval(() => {
          const parts = zonedParts(new Date(), spec.timezone || "UTC");
          const token = `${spec.name || spec.function}:${parts.stamp}`;
          if (lastFire.get(spec.function + (spec.name || "")) === token) return;
          if (!cronMatches(spec.cron, new Date(), spec.timezone || "UTC")) return;
          lastFire.set(spec.function + (spec.name || ""), token);
          fireSchedule(spec).catch((err) => console.error("[onprem] schedule", err.message));
        }, 1000));
      }
    }
    void loops;
  }

  async function close() {
    stopped = true;
    for (const timer of timers) clearInterval(timer);
    for (const stop of stops) stop();
    for (const redis of redisCache.values()) redis.close();
    if (builtin && typeof builtin.close === "function") builtin.close();
    if (globalThis[BUS]) delete globalThis[BUS];
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return {
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${address.port}`,
    port: address.port,
    platform,
    get broker() {
      return builtin;
    },
    fireSchedule,
    call,
    close,
  };
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  startPlatform({}).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
