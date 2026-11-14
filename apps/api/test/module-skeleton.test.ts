import { describe, expect, it } from "vitest";

// `identity` and `audit` have code now, so they are not in this list.
const paths = ["payout", "approval", "ledger", "deals", "milestones"].map(
  (name) => `../src/modules/${name}/index.ts`,
);

describe("module skeleton", () => {
  it.each(paths)("%s exports nothing", async (path) => {
    const mod = (await import(path)) as Record<string, unknown>;
    expect(Object.keys(mod)).toEqual([]);
  });
});
