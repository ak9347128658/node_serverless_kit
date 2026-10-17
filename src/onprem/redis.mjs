/**
 * Minimal Redis client (RESP) for on-premises queues and topics.
 *
 * Used when `queue` or `topic` is `redis://host:port` or `redis` (a container
 * nskit deploys). No npm dependency.
 */

import net from "node:net";
import tls from "node:tls";

export function parseRedisUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") throw new Error(`not a redis url: ${value}`);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password ? decodeURIComponent(url.password) : "",
    db: url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : 0,
    tls: url.protocol === "rediss:",
  };
}

export function encodeCommand(args) {
  let out = `*${args.length}\r\n`;
  for (const arg of args) {
    const text = arg === undefined || arg === null ? "" : String(arg);
    out += `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
  }
  return out;
}

/** Incremental RESP parser. `push(buffer)` returns zero or more replies. */
export function createParser() {
  let buffer = Buffer.alloc(0);
  function readLine(start) {
    const end = buffer.indexOf("\r\n", start);
    if (end < 0) return undefined;
    return { line: buffer.toString("utf8", start, end), next: end + 2 };
  }
  function read(start) {
    if (start >= buffer.length) return undefined;
    const prefix = String.fromCharCode(buffer[start]);
    const head = readLine(start + 1);
    if (!head) return undefined;
    if (prefix === "+" || prefix === ":") return { value: prefix === ":" ? Number(head.line) : head.line, next: head.next };
    if (prefix === "-") return { value: Object.assign(new Error(head.line), { redis: true }), next: head.next };
    if (prefix === "$") {
      const len = Number(head.line);
      if (len < 0) return { value: null, next: head.next };
      if (buffer.length < head.next + len + 2) return undefined;
      const value = buffer.toString("utf8", head.next, head.next + len);
      return { value, next: head.next + len + 2 };
    }
    if (prefix === "*") {
      const count = Number(head.line);
      if (count < 0) return { value: null, next: head.next };
      const values = [];
      let cursor = head.next;
      for (let i = 0; i < count; i++) {
        const item = read(cursor);
        if (!item) return undefined;
        values.push(item.value);
        cursor = item.next;
      }
      return { value: values, next: cursor };
    }
    throw new Error(`unknown RESP prefix ${prefix}`);
  }
  return {
    push(chunk) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      const values = [];
      let start = 0;
      for (;;) {
        const item = read(start);
        if (!item) break;
        values.push(item.value);
        start = item.next;
      }
      buffer = buffer.subarray(start);
      return values;
    },
  };
}

function connect(options) {
  return new Promise((resolve, reject) => {
    const socket = options.tls
      ? tls.connect({ host: options.host, port: options.port, servername: options.host })
      : net.connect({ host: options.host, port: options.port });
    const parser = createParser();
    const pending = [];
    socket.on("data", (chunk) => {
      let replies;
      try {
        replies = parser.push(chunk);
      } catch (err) {
        socket.destroy(err);
        return;
      }
      for (const reply of replies) {
        const waiter = pending.shift();
        if (!waiter) continue;
        if (reply instanceof Error) waiter.reject(reply);
        else waiter.resolve(reply);
      }
    });
    socket.once("error", reject);
    socket.once("connect", async () => {
      socket.off("error", reject);
      socket.on("error", (err) => {
        for (const waiter of pending.splice(0)) waiter.reject(err);
      });
      const conn = {
        command(args) {
          return new Promise((resolveReply, rejectReply) => {
            pending.push({ resolve: resolveReply, reject: rejectReply });
            socket.write(encodeCommand(args));
          });
        },
        close() {
          socket.end();
        },
      };
      try {
        if (options.password) {
          const auth = await conn.command(["AUTH", options.password]);
          if (auth instanceof Error) throw auth;
        }
        if (options.db) {
          const selected = await conn.command(["SELECT", String(options.db)]);
          if (selected instanceof Error) throw selected;
        }
        resolve(conn);
      } catch (err) {
        socket.destroy();
        reject(err);
      }
    });
  });
}

/**
 * Queue and topic operations on one Redis.
 *
 * Queues use a ready list and an inflight list (`BRPOPLPUSH`), so a message
 * stays out of the ready list until ack, nack or the visibility sweeper.
 */
export async function createRedisBroker(url) {
  const options = parseRedisUrl(url);
  const conn = await connect(options);
  let chain = Promise.resolve();
  function exclusive(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  const key = (name) => `nskit:q:${name}`;
  const inflightKey = (name) => `nskit:qi:${name}`;
  const metaKey = (name) => `nskit:qm:${name}`;

  function parse(raw) {
    if (raw === null || raw === undefined) return undefined;
    const msg = JSON.parse(raw);
    msg.raw = raw;
    return msg;
  }

  async function enqueue(name, body, attributes = {}) {
    const msg = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, body: body ?? null, attributes, receiveCount: 0 };
    await exclusive(() => conn.command(["LPUSH", key(name), JSON.stringify(msg)]));
    return msg.id;
  }

  async function sweepOne(name) {
    const deadlines = await conn.command(["HGETALL", metaKey(name)]);
    if (!Array.isArray(deadlines) || deadlines.length < 2) return;
    const now = Date.now();
    const expired = [];
    for (let i = 0; i + 1 < deadlines.length; i += 2) {
      const until = Number(deadlines[i + 1]);
      if (Number.isFinite(until) && until <= now) expired.push(String(deadlines[i]));
    }
    if (!expired.length) return;
    const rows = (await conn.command(["LRANGE", inflightKey(name), "0", "-1"])) ?? [];
    for (const id of expired) {
      const raw = rows.find((item) => {
        try {
          return String(JSON.parse(item).id) === id;
        } catch {
          return false;
        }
      });
      await conn.command(["HDEL", metaKey(name), id]);
      if (!raw) continue;
      await conn.command(["LREM", inflightKey(name), "1", raw]);
      await conn.command(["RPUSH", key(name), raw]);
    }
  }

  async function takeOne(name, opts, waitSeconds, blocking) {
    const command = blocking
      ? ["BRPOPLPUSH", key(name), inflightKey(name), String(waitSeconds)]
      : ["RPOPLPUSH", key(name), inflightKey(name)];
    const raw = await conn.command(command);
    const msg = parse(raw);
    if (!msg) return undefined;
    msg.receiveCount = Number(msg.receiveCount || 0) + 1;
    const stored = JSON.stringify({ id: msg.id, body: msg.body, attributes: msg.attributes, receiveCount: msg.receiveCount });
    await conn.command(["LREM", inflightKey(name), "1", msg.raw]);
    await conn.command(["RPUSH", inflightKey(name), stored]);
    await conn.command(["HSET", metaKey(name), msg.id, String(Date.now() + (Number(opts.visibilityMs) || 30000))]);
    return { id: msg.id, body: msg.body, attributes: msg.attributes, receiveCount: msg.receiveCount };
  }

  async function receive(name, opts = {}) {
    const batchSize = Math.max(1, Number(opts.batchSize) || 1);
    const timeout = Math.max(1, Math.ceil((Number(opts.waitMs) || 1000) / 1000));
    return exclusive(async () => {
      await sweepOne(name);
      const out = [];
      for (let i = 0; i < batchSize; i++) {
        const msg = await takeOne(name, opts, timeout, i === 0);
        if (!msg) break;
        out.push(msg);
      }
      return out;
    });
  }

  async function ack(name, ids) {
    let count = 0;
    await exclusive(async () => {
      const rows = await conn.command(["LRANGE", inflightKey(name), "0", "-1"]);
      for (const raw of rows ?? []) {
        const msg = parse(raw);
        if (!msg || !ids.map(String).includes(String(msg.id))) continue;
        await conn.command(["LREM", inflightKey(name), "1", raw]);
        await conn.command(["HDEL", metaKey(name), String(msg.id)]);
        count += 1;
      }
    });
    return count;
  }

  async function nack(name, ids, opts = {}) {
    const maxReceive = Number(opts.maxReceive) || 5;
    const deadLetter = opts.deadLetter ? String(opts.deadLetter) : "";
    let count = 0;
    await exclusive(async () => {
      const rows = await conn.command(["LRANGE", inflightKey(name), "0", "-1"]);
      for (const raw of rows ?? []) {
        const msg = parse(raw);
        if (!msg || !ids.map(String).includes(String(msg.id))) continue;
        await conn.command(["LREM", inflightKey(name), "1", raw]);
        await conn.command(["HDEL", metaKey(name), String(msg.id)]);
        const payload = JSON.stringify({ id: msg.id, body: msg.body, attributes: msg.attributes, receiveCount: msg.receiveCount });
        if (deadLetter && msg.receiveCount >= maxReceive) await conn.command(["LPUSH", key(deadLetter), payload]);
        else await conn.command(["RPUSH", key(name), payload]);
        count += 1;
      }
    });
    return count;
  }

  async function publish(name, body, attributes = {}) {
    const event = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, body: body ?? null, attributes, time: new Date().toISOString() };
    await exclusive(() => conn.command(["PUBLISH", `nskit:t:${name}`, JSON.stringify(event)]));
    return event.id;
  }

  function subscribe(name, onEvent) {
    let closed = false;
    // SUBSCRIBE pushes messages that are not tied to a pending command, so this
    // socket is separate from the command connection.
    const socket = options.tls
      ? tls.connect({ host: options.host, port: options.port, servername: options.host })
      : net.connect({ host: options.host, port: options.port });
    const parser = createParser();
    socket.on("data", (chunk) => {
      let replies;
      try {
        replies = parser.push(chunk);
      } catch {
        return;
      }
      for (const reply of replies) {
        if (Array.isArray(reply) && reply[0] === "message" && typeof reply[2] === "string") {
          try {
            onEvent(JSON.parse(reply[2]));
          } catch {
            /* ignore a malformed payload */
          }
        }
      }
    });
    socket.once("connect", () => {
      const hello = [];
      if (options.password) hello.push(["AUTH", options.password]);
      if (options.db) hello.push(["SELECT", String(options.db)]);
      hello.push(["SUBSCRIBE", `nskit:t:${name}`]);
      for (const args of hello) socket.write(encodeCommand(args));
    });
    return () => {
      if (closed) return;
      closed = true;
      socket.end();
    };
  }

  return { enqueue, receive, ack, nack, publish, subscribe, close: () => conn.close() };
}
