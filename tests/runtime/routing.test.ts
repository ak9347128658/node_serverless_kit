import { describe, expect, it } from "vitest";
import { matchPath, methodMatches, splitPath } from "../../src/runtime/routing.js";

describe("matchPath", () => {
  it.each([
    ["/users/{id}", "/users/7", { id: "7" }],
    ["/users/{id}", "/users/7/", { id: "7" }],
    ["/users/{id}", "//users//7", { id: "7" }],
    ["/users/{id}", "/users/7?x=1", { id: "7" }],
    ["/users/{id}", "/users/7/x", null],
    ["/users/{id}", "/users", { id: "users" }], // tolerant: leading static stripped, documented quirk
    ["/users/{id}/orders/{oid}", "/users/1/orders/2", { id: "1", oid: "2" }],
    ["/files/{path+}", "/files/a/b/c.txt", { path: "a/b/c.txt" }],
    ["/files/{path+}", "/files/one", { path: "one" }],
    ["/files/{path+}", "/files", { path: "files" }], // same tolerant quirk (parity with py-serverless-kit)
    ["/users/{id}", "/7", { id: "7" }], // GCP style: static prefix stripped
    ["/users/{id}", "/api/users/7", { id: "7" }], // Azure style: extra prefix
    ["/users/{id}", "/a/b/users/7", { id: "7" }],
    ["/hello", "/hello", {}],
    ["/hello", "/api/hello", {}],
    ["/hello", "/", {}], // GCP serves the function root
    ["/hello", "/other", null],
    ["/", "/", {}],
    ["/", "/x", null],
    ["/{id}", "/7", { id: "7" }],
    ["/{id}", "/a/7", null], // no static segment -> no prefix tolerance
    ["/users/{name}", "/users/J%C3%BCrgen%20M", { name: "Jürgen M" }],
    ["/users/{name}", "/users/%E0%A4%A", { name: "%E0%A4%A" }],
    ["/files/{p+}", "/files/a%2Fb/c", { p: "a/b/c" }],
  ])("%s ~ %s", (pattern, path, expected) => {
    expect(matchPath(pattern, path)).toEqual(expected);
  });

  it("strict mode only accepts exact matches", () => {
    expect(matchPath("/users/{id}", "/7", false)).toBeNull();
    expect(matchPath("/users/{id}", "/api/users/7", false)).toBeNull();
    expect(matchPath("/users/{id}", "/users/7", false)).toEqual({ id: "7" });
  });

  it("splitPath drops the query and empty segments", () => {
    expect(splitPath("/a//b/?q=1")).toEqual(["a", "b"]);
    expect(splitPath("")).toEqual([]);
  });
});

describe("methodMatches", () => {
  it.each([
    ["ANY", "DELETE", true],
    ["*", "POST", true],
    ["get", "GET", true],
    ["GET", "head", true],
    ["GET", "POST", false],
    ["HEAD", "GET", false],
    ["POST", "post", true],
  ])("%s allows %s: %s", (allowed, method, expected) => {
    expect(methodMatches(allowed, method)).toBe(expected);
  });
});
