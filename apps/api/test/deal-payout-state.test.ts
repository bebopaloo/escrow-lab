import { schema, seedUsers } from "@escrow-lab/db";
import { DealResponse } from "@escrow-lab/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openTestDatabase } from "./database.ts";
import {
  ALICE,
  CAROL,
  accepted,
  approved,
  failures,
  startHarness,
  type HarnessOptions,
  type TestDatabase,
} from "./harness.ts";

describe("the Payout state of each Milestone on the Deal", () => {
  let database: TestDatabase;
  const closers: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
  });
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });
  afterAll(async () => {
    await database.close();
  });

  async function start(options: HarnessOptions = {}) {
    const h = await startHarness(database, options);
    closers.push(() => h.close());
    return h;
  }

  async function milestonesOf(h: Awaited<ReturnType<typeof start>>, dealId: string, user: string) {
    const response = await h.call(user, "GET", `/api/deals/${dealId}`);
    expect(response.statusCode).toBe(200);
    return DealResponse.parse(response.json()).milestones;
  }

  it("shows no Payout for a Milestone that has none", async () => {
    const h = await start();
    const ids = await accepted(h);
    const [first, second] = await milestonesOf(h, ids.dealId, ALICE);
    expect(first?.payout).toBeNull();
    expect(second?.payout).toBeNull();
  });

  it("shows a confirmed Payout with the time of its ledger entry, to both parties", async () => {
    const h = await start();
    const ids = await approved(h);
    const [ledger] = await database.db
      .select({ createdAt: schema.ledgerEntries.createdAt })
      .from(schema.ledgerEntries)
      .where(
        and(eq(schema.ledgerEntries.kind, "payout"), eq(schema.ledgerEntries.dealId, ids.dealId)),
      );
    for (const user of [ALICE, CAROL]) {
      const [first] = await milestonesOf(h, ids.dealId, user);
      expect(first?.payout).toEqual({
        state: "confirmed",
        paidAt: ledger?.createdAt.toISOString(),
      });
    }
  });

  it("shows a pending Payout without a paid time", async () => {
    const h = await start({ chain: [{ kind: "ok" }, ...failures(1)] });
    const ids = await approved(h);
    const [first] = await milestonesOf(h, ids.dealId, CAROL);
    expect(first?.state).toBe("accepted");
    expect(first?.payout).toEqual({ state: "pending", paidAt: null });
  });

  it("shows a failed Payout without a paid time", async () => {
    const h = await start({ chain: [{ kind: "ok" }, ...failures(1)] });
    const ids = await approved(h);
    await database.db
      .update(schema.payouts)
      .set({ state: "failed" })
      .where(eq(schema.payouts.id, ids.payoutId));
    const [first] = await milestonesOf(h, ids.dealId, ALICE);
    expect(first?.payout).toEqual({ state: "failed", paidAt: null });
  });
});
