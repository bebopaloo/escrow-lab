import { SEED_USERS, schema, seedUsers } from "@escrow-lab/db";
import { DealResponse, SessionResponse } from "@escrow-lab/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import {
  createFakeChain,
  type Chain,
  type Step as ChainStep,
} from "../src/adapters/chain/index.ts";
import {
  createFakePaymentRail,
  type PaymentRail,
  type Step as RailStep,
} from "../src/adapters/payment-rail/index.ts";
import { openTestDatabase, testConfig } from "./database.ts";

const ALICE = SEED_USERS[0]?.id ?? "";
const BOB = SEED_USERS[1]?.id ?? "";
const CAROL = SEED_USERS[2]?.id ?? "";

type Database = Awaited<ReturnType<typeof openTestDatabase>>;
interface Session {
  cookie: string;
  csrfToken: string;
}

function cookieOf(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const lines = Array.isArray(header) ? header : typeof header === "string" ? [header] : [];
  return lines.map((line) => String(line).split(";")[0]).join("; ");
}

const GOOD_DEAL = {
  sellerId: CAROL,
  title: "Logo design",
  totalMinor: 100_000,
  milestones: [
    { title: "Draft", amountMinor: 40_000 },
    { title: "Final", amountMinor: 60_000 },
  ],
};

/** An app with scripted fakes. Each call to `charge` or `lock` also records its key. */
async function startApp(
  database: Database,
  railScript: RailStep[] = [],
  chainScript: ChainStep[] = [],
) {
  const rail = createFakePaymentRail(railScript);
  const chain = createFakeChain(chainScript);
  const chargeKeys: string[] = [];
  const lockKeys: string[] = [];
  const paymentRail: PaymentRail = {
    charge: (buyer, amount, key) => {
      chargeKeys.push(key);
      return rail.charge(buyer, amount, key);
    },
  };
  const spyChain: Chain = {
    lock: (deal, amount, key) => {
      lockKeys.push(key);
      return chain.lock(deal, amount, key);
    },
    transfer: (seller, amount, key) => chain.transfer(seller, amount, key),
  };
  const app = await buildApp({
    config: testConfig,
    db: database.db,
    logger: false,
    paymentRail,
    chain: spyChain,
  });
  const sessions = new Map<string, Session>();
  async function signIn(userId: string): Promise<Session> {
    const known = sessions.get(userId);
    if (known !== undefined) return known;
    const visit = await app.inject({ method: "GET", url: "/api/session" });
    const token = SessionResponse.parse(visit.json()).csrfToken;
    const response = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { cookie: cookieOf(visit), "x-csrf-token": token },
      payload: { userId },
    });
    const session = {
      cookie: cookieOf(response),
      csrfToken: SessionResponse.parse(response.json()).csrfToken,
    };
    sessions.set(userId, session);
    return session;
  }
  async function newDeal(): Promise<string> {
    const buyer = await signIn(ALICE);
    const response = await app.inject({
      method: "POST",
      url: "/api/deals",
      headers: { cookie: buyer.cookie, "x-csrf-token": buyer.csrfToken },
      payload: GOOD_DEAL,
    });
    return DealResponse.parse(response.json()).id;
  }
  async function fund(userId: string, dealId: string, withCsrf = true) {
    const who = await signIn(userId);
    return app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fund`,
      headers: { cookie: who.cookie, ...(withCsrf ? { "x-csrf-token": who.csrfToken } : {}) },
    });
  }
  return { app, rail, chain, chargeKeys, lockKeys, signIn, newDeal, fund };
}

describe("fund a Deal", () => {
  let database: Database;
  const apps: Awaited<ReturnType<typeof startApp>>[] = [];

  async function start(railScript: RailStep[] = [], chainScript: ChainStep[] = []) {
    const started = await startApp(database, railScript, chainScript);
    apps.push(started);
    return started;
  }

  const dealRow = async (id: string) =>
    (await database.db.select().from(schema.deals).where(eq(schema.deals.id, id)))[0];
  const ledgerOf = (id: string) =>
    database.db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.dealId, id));
  const milestonesOf = (id: string) =>
    database.db
      .select()
      .from(schema.milestones)
      .where(eq(schema.milestones.dealId, id))
      .orderBy(schema.milestones.position);
  const auditActions = async (id: string) =>
    (
      await database.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.dealId, id))
    ).map((event) => event.action);

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
  });

  afterAll(async () => {
    for (const started of apps) await started.app.close();
    await database.close();
  });

  it("funds a draft Deal: one deposit, Deal funded, first Milestone awaiting evidence", async () => {
    const t = await start();
    const dealId = await t.newDeal();
    const response = await t.fund(ALICE, dealId);
    expect(response.statusCode).toBe(200);
    expect(DealResponse.parse(response.json()).state).toBe("funded");
    const entries = await ledgerOf(dealId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "deposit", amountMinor: 100_000 });
    expect(entries[0]?.chainTxId.length).toBeGreaterThan(0);
    expect((await dealRow(dealId))?.state).toBe("funded");
    expect((await milestonesOf(dealId)).map((m) => m.state)).toEqual([
      "awaiting_evidence",
      "pending",
    ]);
    expect(t.chargeKeys).toHaveLength(1);
    expect(t.lockKeys).toEqual(t.chargeKeys);
    expect(t.rail.moved).toBe(100_000);
    expect(t.chain.moved).toBe(100_000);
    expect((await auditActions(dealId)).sort()).toEqual([
      "create_deal",
      "fund",
      "funding_confirmed",
    ]);
  });

  it("goes back to draft when the payment rail refuses, and the next try has a new key", async () => {
    const t = await start([{ kind: "fail", failure: "refused" }]);
    const dealId = await t.newDeal();
    const response = await t.fund(ALICE, dealId);
    expect(response.statusCode).toBe(402);
    const row = await dealRow(dealId);
    expect(row?.state).toBe("draft");
    expect(row?.fundingIdempotencyKey).toBeNull();
    expect(await ledgerOf(dealId)).toHaveLength(0);
    expect(t.lockKeys).toHaveLength(0);

    const again = await t.fund(ALICE, dealId);
    expect(again.statusCode).toBe(200);
    expect(t.chargeKeys).toHaveLength(2);
    expect(t.chargeKeys[1]).not.toBe(t.chargeKeys[0]);
    expect((await dealRow(dealId))?.state).toBe("funded");
  });

  it("keeps the Deal in funding when the payment rail loses the reply", async () => {
    const t = await start([{ kind: "lose_reply" }]);
    const dealId = await t.newDeal();
    const response = await t.fund(ALICE, dealId);
    expect(response.statusCode).toBe(200);
    expect(DealResponse.parse(response.json()).state).toBe("funding");
    const row = await dealRow(dealId);
    expect(row?.state).toBe("funding");
    expect(row?.fundingIdempotencyKey).toBe(t.chargeKeys[0]);
    expect(await ledgerOf(dealId)).toHaveLength(0);
    expect(t.lockKeys).toHaveLength(0);
  });

  it("keeps the Deal in funding and writes no deposit when the chain lock fails", async () => {
    const t = await start([], [{ kind: "fail", failure: "timeout" }]);
    const dealId = await t.newDeal();
    const response = await t.fund(ALICE, dealId);
    expect(response.statusCode).toBe(200);
    expect(DealResponse.parse(response.json()).state).toBe("funding");
    expect((await dealRow(dealId))?.state).toBe("funding");
    expect(await ledgerOf(dealId)).toHaveLength(0);
    expect((await milestonesOf(dealId)).map((m) => m.state)).toEqual(["pending", "pending"]);
  });

  it("returns 409 and changes nothing for a Deal that is not in draft", async () => {
    const t = await start();
    const dealId = await t.newDeal();
    await t.fund(ALICE, dealId);
    const second = await t.fund(ALICE, dealId);
    expect(second.statusCode).toBe(409);
    expect(await ledgerOf(dealId)).toHaveLength(1);
    expect(t.chargeKeys).toHaveLength(1);
    expect(await auditActions(dealId)).toHaveLength(3);
  });

  it("refuses a Seller with 403 and another Buyer with 404, and changes nothing", async () => {
    const t = await start();
    const dealId = await t.newDeal();
    expect((await t.fund(CAROL, dealId)).statusCode).toBe(403);
    expect((await t.fund(BOB, dealId)).statusCode).toBe(404);
    expect((await dealRow(dealId))?.state).toBe("draft");
    expect(t.chargeKeys).toHaveLength(0);
  });

  it("refuses a request without a CSRF token", async () => {
    const t = await start();
    const dealId = await t.newDeal();
    expect((await t.fund(ALICE, dealId, false)).statusCode).toBe(403);
    expect((await dealRow(dealId))?.state).toBe("draft");
  });

  it("returns 404 for a Deal that does not exist", async () => {
    const t = await start();
    const response = await t.fund(ALICE, "00000000-0000-4000-8000-0000000000ff");
    expect(response.statusCode).toBe(404);
  });

  it("limits the rate of the route", async () => {
    const t = await start();
    const dealId = await t.newDeal();
    const codes = new Set<number>();
    for (let i = 0; i < 32; i += 1) codes.add((await t.fund(ALICE, dealId)).statusCode);
    expect(codes.has(429)).toBe(true);
  });
});
