import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.ts";
import { createChain } from "./chain/index.ts";
import { createPaymentRail } from "./payment-rail/index.ts";

const SCRIPT = JSON.stringify([{ kind: "fail", failure: "refused" }]);

describe("production cannot turn on failure injection", () => {
  it("gives the config no field for a failure script", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://user:pass@127.0.0.1:41032/escrow",
      NODE_ENV: "production",
      CHAIN_SCRIPT: SCRIPT,
      PAYMENT_RAIL_SCRIPT: SCRIPT,
      FAILURE_SCRIPT: SCRIPT,
    });
    const keys = Object.keys(config);
    expect(keys.filter((key) => /script|fail|inject/i.test(key))).toEqual([]);
    expect(Object.values(config)).not.toContain(SCRIPT);
  });

  it("builds the production fakes with no argument and no script", async () => {
    expect(createChain.length).toBe(0);
    expect(createPaymentRail.length).toBe(0);
    const chain = createChain();
    const rail = createPaymentRail();
    expect((await chain.lock("deal-1", 500, "key-1")).ok).toBe(true);
    expect((await chain.transfer("seller-1", 200, "key-2")).ok).toBe(true);
    expect((await rail.charge("buyer-1", 500, "key-3")).ok).toBe(true);
  });
});
