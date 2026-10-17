/**
 * Replace a dependency of the handler with `vi.mock`. This works because the runner
 * uses mode "import": handler modules are loaded by Vitest, so its module mocks apply.
 */

import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { LocalRunner } from "node_serverless_kit/testing";
import { discountRate } from "../src/discounts.js";

vi.mock("../src/discounts.js", () => ({ discountRate: vi.fn(async () => 0.5) }));

it("uses the mocked pricing service", async () => {
  const runner = await LocalRunner.fromConfig(fileURLToPath(new URL("../nskit.yml", import.meta.url)), { mode: "import" });
  const res = await runner.http("POST", "/price", { json: { amount: 100, code: "ANY" } });
  expect(res.json()).toMatchObject({ discount: 50, total: 50, code: "ANY" });
  expect(discountRate).toHaveBeenCalledWith("ANY");
});
