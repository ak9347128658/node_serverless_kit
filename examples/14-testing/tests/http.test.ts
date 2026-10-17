/**
 * HTTP tests through the real dispatcher: routing, JSON parsing, error mapping and
 * status codes behave exactly as in the cloud, minus the network.
 */

import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { LocalRunner } from "node_serverless_kit/testing";

const CONFIG = fileURLToPath(new URL("../nskit.yml", import.meta.url));

let runner: LocalRunner;

beforeAll(async () => {
  // mode "import" loads handlers in this process, so vi.mock and coverage apply.
  // mode "bundle" builds them with esbuild exactly like a deployment.
  runner = await LocalRunner.fromConfig(CONFIG, { mode: "import" });
});

describe("POST /price", () => {
  it.each([
    [{ amount: 100 }, 100],
    [{ amount: 100, code: "welcome10" }, 90],
    [{ amount: 80, code: "VIP25" }, 60],
  ])("%j costs %d", async (payload, total) => {
    const res = await runner.http("POST", "/price", { json: payload });
    expect(res.status).toBe(200);
    expect(res.json<{ total: number }>().total).toBe(total);
  });

  it("reads the code from the query string", async () => {
    const res = await runner.http("POST", "/price?code=VIP25", { json: { amount: 100 } });
    expect(res.json()).toMatchObject({ code: "VIP25", total: 75 });
  });

  it.each([[{ amount: -1 }], [{ amount: "ten" }], [{}]])("rejects %j with 400", async (payload) => {
    const res = await runner.http("POST", "/price", { json: payload });
    expect(res.status).toBe(400);
    expect(res.json<{ error: string }>().error).toContain("amount");
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await runner.http("POST", "/price", { body: "{not json", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
  });

  it("answers 405 for other methods, like the API gateway", async () => {
    expect((await runner.http("GET", "/price")).status).toBe(405);
  });
});
