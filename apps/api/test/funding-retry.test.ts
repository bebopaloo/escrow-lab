import { SEED_USERS, schema, seedUsers } from "@escrow-lab/db";
import { DealResponse, SessionResponse } from "@escrow-lab/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import { createFundingRetryJob } from "../src/modules/payout/index.ts";
import { openTestDatabase, testConfig } from "./database.ts";

const ALICE = SEED_USERS[0]?.id ?? "";
const CAROL = SEED_USERS[2]?.id ?? "";

type Database = Awaited<ReturnType<typeof openTestDatabase>>;

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

/** An app and a job that share scripted fakes. The fakes record each key they receive. */
async function start(
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
  let clock = Date.now();
  const job = createFundingRetryJob({
    db: database.db,
    chain: spyChain,
    paymentRail,
    now: () => new Date(clock),
  });
  async function fundNewDeal(): Promise<string> {
    const visit = await app.inject({ method: "GET", url: "/api/session" });
    const token = SessionResponse.parse(visit.json()).csrfToken;
    const signedIn = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { cookie: cookieOf(visit), "x-csrf-token": token },
      payload: { userId: ALICE },
    });
    const cookie = cookieOf(signedIn);
    const csrf = SessionResponse.parse(signedIn.json()).csrfToken;
    const created = await app.inject({
      method: "POST",
      url: "/api/deals",
      headers: { cookie, "x-csrf-token": csrf },
      payload: GOOD_DEAL,
    });
    const dealId = DealResponse.parse(created.json()).id;
    await app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/fund`,
      headers: { cookie, "x-csrf-token": csrf },
    });
    return dealId;
  }
  return {
    app,
    rail,
    chain,
    job,
    chargeKeys,
    lockKeys,
    fundNewDeal,
    now: () => clock,
    /** Moves the job clock forward. */
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("retry a Deal's funding", () => {
  let database: Database;
  const apps: Awaited<ReturnType<typeof start>>[] = [];

  async function begin(railScript: RailStep[] = [], chainScript: ChainStep[] = []) {
    const started = await start(database, railScript, chainScript);
    apps.push(started);
    return started;
  }

  const dealRow = async (id: string) =>
    (await database.db.select().from(schema.deals).where(eq(schema.deals.id, id)))[0];
  const ledgerOf = (id: string) =>
    database.db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.dealId, id));
  const auditActions = async (id: string) =>
    (
      await database.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.dealId, id))
    ).map((event) => event.action);

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    for (const started of apps) await started.app.close();
    await database.close();
  });

  it("sets the next try time 1 second ahead when the request leaves the Deal in funding", async () => {
    const t = await begin([{ kind: "lose_reply" }]);
    const before = Date.now();
    const dealId = await t.fundNewDeal();
    const row = await dealRow(dealId);
    expect(row?.state).toBe("funding");
    expect(row?.fundingAttempts).toBe(0);
    const wait = (row?.nextFundingTryAt?.getTime() ?? 0) - before;
    expect(wait).toBeGreaterThan(500);
    expect(wait).toBeLessThan(5_000);
  });

  it("resends a lost charge with the same key, and the Buyer is charged once", async () => {
    const t = await begin([{ kind: "lose_reply" }]);
    const dealId = await t.fundNewDeal();
    const key = (await dealRow(dealId))?.fundingIdempotencyKey;
    t.advance(2_000);
    await t.job.runOnce({ dealIds: [dealId] });
    expect(t.chargeKeys).toEqual([key, key]);
    expect(t.lockKeys).toEqual([key]);
    expect(t.rail.moved).toBe(100_000);
    expect(t.rail.events).toHaveLength(1);
    expect((await dealRow(dealId))?.state).toBe("funded");
    const entries = await ledgerOf(dealId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "deposit", amountMinor: 100_000 });
    expect((await auditActions(dealId)).sort()).toEqual([
      "create_deal",
      "fund",
      "funding_confirmed",
    ]);
  });

  it("does not try a Deal before its next try time", async () => {
    const t = await begin([{ kind: "lose_reply" }]);
    const dealId = await t.fundNewDeal();
    await t.job.runOnce({ dealIds: [dealId] });
    expect(t.chargeKeys).toHaveLength(1);
    expect((await dealRow(dealId))?.state).toBe("funding");
  });

  it("retries the lock with the same key and writes the deposit only when the chain confirms", async () => {
    const t = await begin([], [{ kind: "fail", failure: "timeout" }]);
    const dealId = await t.fundNewDeal();
    const key = (await dealRow(dealId))?.fundingIdempotencyKey;
    expect(await ledgerOf(dealId)).toHaveLength(0);
    t.advance(2_000);
    await t.job.runOnce({ dealIds: [dealId] });
    expect(t.lockKeys).toEqual([key, key]);
    expect(t.rail.events).toHaveLength(1);
    expect(t.chain.events).toHaveLength(1);
    expect((await dealRow(dealId))?.state).toBe("funded");
    expect(await ledgerOf(dealId)).toHaveLength(1);
  });

  it("marks the Deal funding_failed after 5 failed tries, with no deposit", async () => {
    const lockFails: ChainStep[] = Array.from({ length: 6 }, () => ({
      kind: "fail",
      failure: "timeout",
    }));
    const t = await begin([], lockFails);
    const dealId = await t.fundNewDeal();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      t.advance(60_000);
      await t.job.runOnce({ dealIds: [dealId] });
      const row = await dealRow(dealId);
      expect(row?.fundingAttempts).toBe(attempt);
      if (attempt < 5) expect(row?.state).toBe("funding");
    }
    const row = await dealRow(dealId);
    expect(row?.state).toBe("funding_failed");
    expect(await ledgerOf(dealId)).toHaveLength(0);
    expect(await auditActions(dealId)).toContain("funding_failed");
    // A sixth run does nothing.
    t.advance(60_000);
    await t.job.runOnce({ dealIds: [dealId] });
    expect(t.lockKeys).toHaveLength(6);
  });

  it("doubles the wait after each failure, from 1 second", async () => {
    const lockFails: ChainStep[] = Array.from({ length: 6 }, () => ({
      kind: "fail",
      failure: "timeout",
    }));
    const t = await begin([], lockFails);
    const dealId = await t.fundNewDeal();
    const gaps: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      t.advance(60_000);
      const jobNow = t.now();
      await t.job.runOnce({ dealIds: [dealId] });
      const next = (await dealRow(dealId))?.nextFundingTryAt?.getTime() ?? 0;
      gaps.push(next - jobNow);
    }
    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it("skips a Deal that another try holds with a row lock", async () => {
    const t = await begin([{ kind: "lose_reply" }]);
    const dealId = await t.fundNewDeal();
    t.advance(2_000);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockedRow = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = database.db.transaction(async (tx) => {
      await tx.execute(sql`select id from deals where id = ${dealId} for update`);
      locked();
      await held;
    });
    await lockedRow;
    await t.job.runOnce({ dealIds: [dealId] });
    expect(t.chargeKeys).toHaveLength(1);
    release();
    await holder;
    await t.job.runOnce({ dealIds: [dealId] });
    expect(t.chargeKeys).toHaveLength(2);
    expect((await dealRow(dealId))?.state).toBe("funded");
  });

  it("returns the Deal to draft when the rail refuses the charge on a retry", async () => {
    const t = await begin([{ kind: "lose_reply" }, { kind: "fail", failure: "refused" }]);
    const dealId = await t.fundNewDeal();
    t.advance(2_000);
    await t.job.runOnce({ dealIds: [dealId] });
    const row = await dealRow(dealId);
    expect(row?.state).toBe("draft");
    expect(row?.fundingIdempotencyKey).toBeNull();
    expect(await ledgerOf(dealId)).toHaveLength(0);
  });

  it("runs every 30 seconds after start and stops after stop", async () => {
    vi.useFakeTimers();
    const t = await begin();
    const spy = vi.spyOn(t.job, "runOnce").mockResolvedValue(undefined);
    t.job.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(spy).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spy).toHaveBeenCalledTimes(2);
    t.job.stop();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
