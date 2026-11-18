import { randomUUID } from "node:crypto";
import { SEED_USERS, schema, seedUsers } from "@escrow-lab/db";
import { PayoutHistoryResponse } from "@escrow-lab/shared";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { openTestDatabase, testConfig } from "./database.ts";
import { signIn, type Session } from "./harness.ts";

const ALICE = SEED_USERS[0]?.id ?? "";
const CAROL = SEED_USERS[2]?.id ?? "";
const DAN = SEED_USERS[3]?.id ?? "";
const ERIN = SEED_USERS[4]?.id ?? "";

describe("Payout history", () => {
  let database: Awaited<ReturnType<typeof openTestDatabase>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  // Dan has no Deals in the other test files. The test removes its rows at the end.
  const seller = DAN;
  const otherSeller = CAROL;
  const dealIds: string[] = [];
  const sessions = new Map<string, Session>();

  async function get(userId: string, query = "") {
    let who = sessions.get(userId);
    if (who === undefined) {
      who = await signIn(app, userId);
      sessions.set(userId, who);
    }
    return app.inject({
      method: "GET",
      url: `/api/payouts/mine${query}`,
      headers: { cookie: who.cookie },
    });
  }

  async function addPayout(
    sellerId: string,
    title: string,
    milestoneTitle: string,
    amountMinor: number,
    state: "pending" | "confirmed" | "failed",
    createdAt: Date,
  ) {
    const [deal] = await database.db
      .insert(schema.deals)
      .values({ buyerId: ALICE, sellerId, title, totalMinor: amountMinor, state: "funded" })
      .returning({ id: schema.deals.id });
    dealIds.push(deal?.id ?? "");
    const [milestone] = await database.db
      .insert(schema.milestones)
      .values({
        dealId: deal?.id ?? "",
        position: 1,
        title: milestoneTitle,
        amountMinor,
        state: "accepted",
      })
      .returning({ id: schema.milestones.id });
    await database.db.insert(schema.payouts).values({
      milestoneId: milestone?.id ?? "",
      idempotencyKey: randomUUID(),
      state,
      approvedBy: ERIN,
      // Retry jobs in other test files must not pick up a pending Payout.
      nextTryAt: new Date("2099-01-01T00:00:00Z"),
      createdAt,
    });
  }

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
    await addPayout(seller, "Logo", "Draft", 40_000, "confirmed", new Date("2026-11-01T10:00:00Z"));
    await addPayout(
      seller,
      "Website",
      "Launch",
      25_000,
      "failed",
      new Date("2026-11-03T10:00:00Z"),
    );
    await addPayout(seller, "Flyer", "Print", 5_000, "pending", new Date("2026-11-02T10:00:00Z"));
    await addPayout(
      otherSeller,
      "Secret",
      "Other",
      9_900,
      "confirmed",
      new Date("2030-01-01T10:00:00Z"),
    );
    app = await buildApp({ config: testConfig, db: database.db, logger: false });
  });

  afterAll(async () => {
    const milestoneIds = database.db
      .select({ id: schema.milestones.id })
      .from(schema.milestones)
      .where(inArray(schema.milestones.dealId, dealIds));
    await database.db
      .delete(schema.payouts)
      .where(inArray(schema.payouts.milestoneId, milestoneIds));
    await database.db.delete(schema.milestones).where(inArray(schema.milestones.dealId, dealIds));
    await database.db.delete(schema.deals).where(inArray(schema.deals.id, dealIds));
    await app.close();
    await database.close();
  });

  it("lists the Seller's Payouts on three Deals, newest first", async () => {
    const response = await get(seller);
    expect(response.statusCode).toBe(200);
    const page = PayoutHistoryResponse.parse(response.json());
    expect(page.total).toBe(3);
    expect(
      page.payouts.map((p) => [p.dealTitle, p.milestoneTitle, p.amountMinor, p.state, p.createdAt]),
    ).toEqual([
      ["Website", "Launch", 25_000, "failed", "2026-11-03T10:00:00.000Z"],
      ["Flyer", "Print", 5_000, "pending", "2026-11-02T10:00:00.000Z"],
      ["Logo", "Draft", 40_000, "confirmed", "2026-11-01T10:00:00.000Z"],
    ]);
  });

  it("paginates with limit and offset", async () => {
    const page = PayoutHistoryResponse.parse((await get(seller, "?limit=2&offset=2")).json());
    expect(page.total).toBe(3);
    expect(page.limit).toBe(2);
    expect(page.offset).toBe(2);
    expect(page.payouts.map((p) => p.dealTitle)).toEqual(["Logo"]);
  });

  it("shows a Seller only their own Payouts", async () => {
    const page = PayoutHistoryResponse.parse((await get(otherSeller, "?limit=100")).json());
    const titles = page.payouts.map((p) => p.dealTitle);
    expect(titles).toContain("Secret");
    expect(titles).not.toContain("Logo");
    const mine = PayoutHistoryResponse.parse((await get(seller, "?limit=100")).json());
    expect(mine.payouts.map((p) => p.dealTitle)).not.toContain("Secret");
  });

  it("refuses a Buyer and an Approver with 403", async () => {
    expect((await get(ALICE)).statusCode).toBe(403);
    expect((await get(ERIN)).statusCode).toBe(403);
  });
});
