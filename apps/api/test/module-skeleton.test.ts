import { describe, expect, it } from "vitest";

const paths = ["payout", "approval", "ledger", "identity", "audit", "deals", "milestones"].map(
  (name) => `../src/modules/${name}/index.ts`,
);
paths.push("../src/adapters/chain/index.ts", "../src/adapters/payment-rail/index.ts");

describe("module skeleton", () => {
  it.each(paths)("%s exports nothing", async (path) => {
    const mod = (await import(path)) as Record<string, unknown>;
    expect(Object.keys(mod)).toEqual([]);
  });
});
