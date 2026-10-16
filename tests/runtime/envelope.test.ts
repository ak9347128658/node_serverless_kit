import { describe, expect, it } from "vitest";
import { actionFrom, ENVELOPE_KEY, envelope, first, unwrapEnvelope } from "../../src/runtime/envelope.js";

describe("envelope", () => {
  it("wraps data with metadata", () => {
    expect(ENVELOPE_KEY).toBe("__nskit");
    expect(envelope("schedule", { a: 1 }, { source: "aws.scheduler" })).toEqual({ __nskit: "schedule", data: { a: 1 }, source: "aws.scheduler" });
    expect(envelope("invoke")).toEqual({ __nskit: "invoke", data: null });
  });

  it("unwraps objects, JSON strings and bytes", () => {
    const wrapped = envelope("workflow", { n: 1 }, { source: "x", extra: 2 });
    const expected = { kind: "workflow", data: { n: 1 }, meta: { source: "x", extra: 2 } };
    expect(unwrapEnvelope(wrapped)).toEqual(expected);
    expect(unwrapEnvelope(JSON.stringify(wrapped))).toEqual(expected);
    expect(unwrapEnvelope(new TextEncoder().encode(JSON.stringify(wrapped)))).toEqual(expected);
  });

  it("maps unknown kinds to invoke", () => {
    expect(unwrapEnvelope({ __nskit: "mystery", data: 1 })).toEqual({ kind: "invoke", data: 1, meta: {} });
    expect(unwrapEnvelope({ __nskit: "http" })?.kind).toBe("http");
  });

  it("returns undefined for everything else", () => {
    for (const value of [undefined, null, 1, "plain", "{bad json", "[1]", [{ __nskit: "x" }], { data: 1 }, new Uint8Array([0xff])]) {
      expect(unwrapEnvelope(value)).toBeUndefined();
    }
  });

  it.each([
    ["ObjectCreated:Put", "created"],
    ["ObjectRemoved:Delete", "deleted"],
    ["google.cloud.storage.object.v1.deleted", "deleted"],
    ["google.cloud.storage.object.v1.archived", "deleted"],
    ["Microsoft.Storage.BlobDeleted", "deleted"],
    ["oss:ObjectRemoved:DeleteObject", "deleted"],
    ["finalize", "created"],
    [undefined, "created"],
  ])("actionFrom(%j) = %s", (name, expected) => {
    expect(actionFrom(name)).toBe(expected);
  });

  it("first() returns the first non-null value", () => {
    expect(first({ a: null, b: undefined, c: 0, d: 1 }, "a", "b", "c", "d")).toBe(0);
    expect(first({ a: null }, "a", "z")).toBeUndefined();
    expect(first(undefined, "a")).toBeUndefined();
  });
});
