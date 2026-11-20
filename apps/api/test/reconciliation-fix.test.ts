import { randomUUID } from "node:crypto";
import { SEED_USERS, schema, seedUsers } from "@escrow-lab/db";
import { SessionResponse } from "@escrow-lab/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { openTestDatabase, testConfig } from "./database.ts";

const ALICE = SEED_USERS[0]?.id ?? "";
const CAROL = SEED_USERS[2]?.id ?? "";
const ERIN = SEED_USERS[4]?.id ?? "";

type Database = Awaited<ReturnType<typeof openTestDatabase>>;
type Kind = (typeof schema.mismatches.$inferInsert)["kind"];
type PayoutState = (typeof schema.payouts.$inferInsert)["state"];

function cookieOf(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const lines = Array.isArray(header) ? header : typeof header === "string" ? [header] : [];
  return lines.map((line) => String(line).split(";")[0]).join("; ");
}

describe("Fix a mismatch", () => {
  let database: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
    app = await buildApp({ config: testConfig, db: database.db, logger: false });
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function post(userId: string, url: string) {
    const visit = await app.inject({ method: "GET", url: "/api/session" });
    const token = SessionResponse.parse(visit.json()).csrfToken;
    const signedIn = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { cookie: cookieOf(visit), "x-csrf-token": token },
      payload: { userId },
    });
    return app.inject({
      method: "POST",
      url,
      headers: {
        cookie: cookieOf(signedIn),
        "x-csrf-token": SessionResponse.parse(signedIn.json()).csrfToken,
      },
      payload: {},
    });
  }

  /** A funded Deal with two Milestones. The first is accepted and its Payout has the given state. */
  async function seed(
    options: { kind?: Kind; payoutState?: PayoutState | null; milestones?: number } = {},
  ) {
    const count = options.milestones ?? 2;
    const [deal] = await database.db
      .insert(schema.deals)
      .values({ title: "Fix", buyerId: ALICE, sellerId: CAROL, totalMinor: 1_000, state: "funded" })
      .returning({ id: schema.deals.id });
    const dealId = deal?.id ?? "";
    const milestones = await database.db
      .insert(schema.milestones)
      .values(
        Array.from({ length: count }, (_, index) => ({
          dealId,
          position: index + 1,
          title: `M${(index + 1).toString()}`,
          amountMinor: 400,
          state: index === 0 ? ("accepted" as const) : ("pending" as const),
        })),
      )
      .returning({ id: schema.milestones.id, position: schema.milestones.position });
    const first = milestones.find((m) => m.position === 1)?.id ?? "";
    let payoutId: string | null = null;
    if (options.payoutState !== null) {
      const [payout] = await database.db
        .insert(schema.payouts)
        .values({
          milestoneId: first,
          idempotencyKey: randomUUID(),
          state: options.payoutState ?? "failed",
          approvedBy: ERIN,
        })
        .returning({ id: schema.payouts.id });
      payoutId = payout?.id ?? null;
    }
    const txId = `tx-${randomUUID()}`;
    const [mismatch] = await database.db
      .insert(schema.mismatches)
      .values({
        kind: options.kind ?? "missing_in_ledger",
        dealId,
        payoutId,
        idempotencyKey: randomUUID(),
        chainTxId: txId,
        chainAmountMinor: 400,
      })
      .returning({ id: schema.mismatches.id });
    return { dealId, first, payoutId: payoutId ?? "", mismatchId: mismatch?.id ?? "", txId };
  }

  const fixUrl = (id: string) => `/api/reconciliation/mismatches/${id}/fix`;
  const mismatchOf = async (id: string) =>
    (await database.db.select().from(schema.mismatches).where(eq(schema.mismatches.id, id)))[0];
  const ledgerOf = (dealId: string) =>
    database.db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.dealId, dealId));
  const auditOf = async (dealId: string) =>
    (
      await database.db
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.dealId, dealId))
    ).map((event) => event.action);

  it("records the Payout from the chain transaction and closes the mismatch", async () => {
    const s = await seed();
    const response = await post(ERIN, fixUrl(s.mismatchId));
    expect(response.statusCode).toBe(200);
    expect(await ledgerOf(s.dealId)).toMatchObject([
      { kind: "payout", amountMinor: 400, chainTxId: s.txId },
    ]);
    const [payout] = await database.db
      .select()
      .from(schema.payouts)
      .where(eq(schema.payouts.id, s.payoutId));
    expect(payout).toMatchObject({ state: "confirmed", chainTxId: s.txId });
    const milestones = await database.db
      .select({ position: schema.milestones.position, state: schema.milestones.state })
      .from(schema.milestones)
      .where(eq(schema.milestones.dealId, s.dealId))
      .orderBy(schema.milestones.position);
    expect(milestones.map((m) => m.state)).toEqual(["paid", "awaiting_evidence"]);
    const closed = await mismatchOf(s.mismatchId);
    expect(closed?.fixedBy).toBe(ERIN);
    expect(closed?.closedAt).not.toBeNull();
    expect(await auditOf(s.dealId)).toContain("fix_mismatch");
  });

  it("completes the Deal when the fixed Payout was for the last Milestone", async () => {
    const s = await seed({ milestones: 1 });
    expect((await post(ERIN, fixUrl(s.mismatchId))).statusCode).toBe(200);
    const [deal] = await database.db
      .select()
      .from(schema.deals)
      .where(eq(schema.deals.id, s.dealId));
    expect(deal?.state).toBe("completed");
  });

  it("answers 409 for another kind and for a mismatch with no Payout, and changes nothing", async () => {
    const other = await seed({ kind: "amount_differs" });
    const noPayout = await seed({ payoutState: null });
    for (const s of [other, noPayout]) {
      expect((await post(ERIN, fixUrl(s.mismatchId))).statusCode).toBe(409);
      expect(await ledgerOf(s.dealId)).toHaveLength(0);
      expect((await mismatchOf(s.mismatchId))?.closedAt).toBeNull();
      expect(await auditOf(s.dealId)).not.toContain("fix_mismatch");
    }
  });

  it("answers 409 and changes nothing when the Payout is no longer failed", async () => {
    const s = await seed({ payoutState: "pending" });
    expect((await post(ERIN, fixUrl(s.mismatchId))).statusCode).toBe(409);
    expect(await ledgerOf(s.dealId)).toHaveLength(0);
    expect((await mismatchOf(s.mismatchId))?.closedAt).toBeNull();
    const [payout] = await database.db
      .select()
      .from(schema.payouts)
      .where(eq(schema.payouts.id, s.payoutId));
    expect(payout?.state).toBe("pending");
  });

  it("answers 409 to a second Fix and writes one Payout and one audit event", async () => {
    const s = await seed();
    expect((await post(ERIN, fixUrl(s.mismatchId))).statusCode).toBe(200);
    expect((await post(ERIN, fixUrl(s.mismatchId))).statusCode).toBe(409);
    expect(await ledgerOf(s.dealId)).toHaveLength(1);
    expect((await auditOf(s.dealId)).filter((a) => a === "fix_mismatch")).toHaveLength(1);
  });

  it("answers 404 for an unknown mismatch id", async () => {
    expect((await post(ERIN, fixUrl(randomUUID()))).statusCode).toBe(404);
  });

  it("answers 403 to a Buyer and a Seller", async () => {
    const s = await seed();
    expect((await post(ALICE, fixUrl(s.mismatchId))).statusCode).toBe(403);
    expect((await post(CAROL, fixUrl(s.mismatchId))).statusCode).toBe(403);
    expect((await mismatchOf(s.mismatchId))?.closedAt).toBeNull();
  });
});
