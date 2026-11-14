import { describe, expect, it } from "vitest";

// `identity`, `audit`, `deals`, `milestones`, `ledger` and `payout` have code now, so they are not in this list.
const paths = ["approval"].map((name) => `../src/modules/${name}/index.ts`);

describe("module skeleton", () => {
  it.each(paths)("%s exports nothing", async (path) => {
    const mod = (await import(path)) as Record<string, unknown>;
    expect(Object.keys(mod)).toEqual([]);
  });
});
