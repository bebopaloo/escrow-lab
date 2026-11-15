import { SEED_USERS, schema, seedUsers } from "@escrow-lab/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordDeposit } from "../src/modules/ledger/index.ts";
import { openTestDatabase } from "./database.ts";

describe("ledger", () => {
  let database: Awaited<ReturnType<typeof openTestDatabase>>;
  let dealId = "";

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
    const [deal] = await database.db
      .insert(schema.deals)
      .values({
        title: "Ledger test",
        buyerId: SEED_USERS[0]?.id ?? "",
        sellerId: SEED_USERS[2]?.id ?? "",
        totalMinor: 100_000,
      })
      .returning({ id: schema.deals.id });
    dealId = deal?.id ?? "";
  });

  afterAll(async () => {
    await database.close();
  });

  const rows = () =>
    database.db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.dealId, dealId));

  it("writes a deposit with the amount and the chain transaction id", async () => {
    await recordDeposit(database.db, { dealId, amountMinor: 100_000, chainTxId: "tx-1" });
    const [entry] = await rows();
    expect(entry).toMatchObject({ kind: "deposit", amountMinor: 100_000, chainTxId: "tx-1" });
  });

  it("[CTRL-LED-01] refuses UPDATE and DELETE", async () => {
    await expect(
      database.db
        .update(schema.ledgerEntries)
        .set({ amountMinor: 1 })
        .where(eq(schema.ledgerEntries.dealId, dealId)),
    ).rejects.toThrow();
    await expect(
      database.db.delete(schema.ledgerEntries).where(eq(schema.ledgerEntries.dealId, dealId)),
    ).rejects.toThrow();
    expect(await rows()).toHaveLength(1);
  });

  it("[CTRL-PAY-02] refuses a second deposit for the same Deal", async () => {
    await expect(
      recordDeposit(database.db, { dealId, amountMinor: 100_000, chainTxId: "tx-2" }),
    ).rejects.toThrow();
    expect(await rows()).toHaveLength(1);
  });
});
