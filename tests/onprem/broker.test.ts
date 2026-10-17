import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createBroker, createHttpBroker, listenBroker, matchFilter, matchObject } from "../../src/onprem/broker.mjs";
import { createParser, encodeCommand } from "../../src/onprem/redis.mjs";
import { parseListObjects, signS3 } from "../../src/onprem/s3.mjs";
import { cronMatches, fieldMatches } from "../../src/onprem/supervisor.mjs";

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

test("queue ack, nack and dead-letter", async () => {
  const broker = createBroker();
  expect(broker.enqueue("jobs", { kind: "email" }, { a: "1" })).toBe("1");
  broker.enqueue("jobs", { kind: "bad" });
  const batch = await broker.receive("jobs", { batchSize: 10, waitMs: 0, visibilityMs: 5000, maxReceive: 2, deadLetter: "jobs-dlq" });
  expect(batch.map((m: { id: string }) => m.id)).toEqual(["1", "2"]);
  expect(await broker.receive("jobs", { waitMs: 0 })).toEqual([]);
  expect(broker.ack("jobs", ["1"])).toBe(1);
  expect(broker.nack("jobs", ["2"], { maxReceive: 2, deadLetter: "jobs-dlq" })).toBe(1);
  const again = await broker.receive("jobs", { waitMs: 0, maxReceive: 2, deadLetter: "jobs-dlq" });
  expect(again[0].receiveCount).toBe(2);
  broker.nack("jobs", [again[0].id], { maxReceive: 2, deadLetter: "jobs-dlq" });
  const dead = await broker.receive("jobs-dlq", { waitMs: 0 });
  expect(dead).toHaveLength(1);
  expect(dead[0].body).toEqual({ kind: "bad" });
  broker.close();
});

test("topic filter and object events survive a restart", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nskit-broker-"));
  dirs.push(dir);
  const first = createBroker({ dataDir: dir });
  first.publish("events", { id: "a" }, { type: "created" });
  first.publish("events", { id: "b" }, { type: "deleted" });
  const pulled = await first.pullTopic("events", { cursor: 0, filter: { type: ["created"] }, waitMs: 0 });
  expect(pulled.events.map((event: { body: { id: string } }) => event.body.id)).toEqual(["a"]);
  first.putObject("uploads", "in/note.txt", Buffer.from("hi"));
  const created = await first.pullStorage("uploads", { cursor: 0, prefix: "in/", suffix: ".txt", actions: ["created"], waitMs: 0 });
  expect(created.events[0]).toMatchObject({ key: "in/note.txt", action: "created" });
  expect(Buffer.from(first.getObject("uploads", "in/note.txt")).toString()).toBe("hi");
  first.close();

  const second = createBroker({ dataDir: dir });
  expect(Buffer.from(second.getObject("uploads", "in/note.txt")).toString()).toBe("hi");
  const replay = await second.pullTopic("events", { cursor: 0, waitMs: 0 });
  expect(replay.events).toHaveLength(2);
  expect(readFileSync(path.join(dir, "broker.json"), "utf-8")).toContain("note.txt");
  second.close();
});

test("HTTP broker speaks the same protocol", async () => {
  const broker = createBroker();
  const server = await listenBroker(broker);
  try {
    const remote = createHttpBroker(server.url);
    await remote.enqueue("jobs", { n: 1 }, { k: "v" });
    const got = await remote.receive("jobs", { batchSize: 1, waitMs: 50 });
    expect(got[0].body).toEqual({ n: 1 });
    expect(await remote.ack("jobs", [got[0].id])).toBeGreaterThan(0);
    await remote.publish("events", { id: "a" }, { type: "created" });
    const topic = await remote.pullTopic("events", { cursor: 0, waitMs: 50, filter: { type: ["created"] } });
    expect(topic.events).toHaveLength(1);
    await remote.putObject("uploads", "in/a.txt", Buffer.from("abc"));
    const objects = await remote.pullStorage("uploads", { cursor: 0, waitMs: 50, prefix: "in/", suffix: ".txt", actions: ["created"] });
    expect(objects.events[0].key).toBe("in/a.txt");
  } finally {
    broker.close();
    await server.close();
  }
});

test("receive that is waiting ends when the broker closes", async () => {
  const broker = createBroker();
  const pending = broker.receive("jobs", { waitMs: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  broker.close();
  await expect(pending).resolves.toEqual([]);
});

test("filters and cron fields", () => {
  expect(matchFilter({ type: ["created"] }, { type: "created" })).toBe(true);
  expect(matchFilter({ type: ["created"] }, { type: "deleted" })).toBe(false);
  expect(matchFilter(null, {})).toBe(true);
  expect(matchObject({ prefix: "in/", suffix: ".txt", actions: ["created"], action: "created" }, "in/a.txt")).toBe(true);
  expect(matchObject({ prefix: "in/", suffix: ".txt", actions: ["created"], action: "deleted" }, "in/a.txt")).toBe(false);
  expect(fieldMatches("1-5", 3, 0, 6, undefined)).toBe(true);
  expect(fieldMatches("*/15", 30, 0, 59, undefined)).toBe(true);
  expect(fieldMatches("*/15", 7, 0, 59, undefined)).toBe(false);
  expect(cronMatches("0 9 * * 1", new Date("2026-10-19T09:00:00Z"), "UTC")).toBe(true);
  expect(cronMatches("0 9 * * 1", new Date("2026-10-19T09:01:00Z"), "UTC")).toBe(false);
  expect(cronMatches("0 9 * * 1", new Date("2026-10-19T09:00:00Z"), "Europe/Berlin")).toBe(false);
});

test("RESP parser and S3 list XML", () => {
  const parser = createParser();
  expect(encodeCommand(["PING"])).toBe("*1\r\n$4\r\nPING\r\n");
  expect(parser.push(Buffer.from("+PONG\r\n$3\r\n"))).toEqual(["PONG"]);
  expect(parser.push(Buffer.from("foo\r\n"))).toEqual(["foo"]);
  const signed = signS3({
    method: "GET",
    url: "http://minio:9000/uploads?list-type=2",
    accessKey: "nskit",
    secretKey: "secret",
    region: "us-east-1",
    now: new Date("2026-10-17T00:00:00Z"),
  });
  expect(signed.authorization).toContain("Credential=nskit/20261017/us-east-1/s3/aws4_request");
  const xml = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>in/a&amp;b.txt</Key><Size>4</Size></Contents></ListBucketResult>`;
  expect(parseListObjects(xml).objects).toEqual([{ key: "in/a&b.txt", size: 4 }]);
});
