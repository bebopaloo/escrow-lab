import { randomUUID } from "node:crypto";
import { SEED_USERS, schema, seedUsers } from "@escrow-lab/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeChain, type Chain, type Step } from "../src/adapters/chain/index.ts";
import { createReconciliationJob } from "../src/modules/reconciliation/index.ts";
import { openTestDatabase } from "./database.ts";

const ALICE = SEED_USERS[0]?.id ?? "";
const CAROL = SEED_USERS[2]?.id ?? "";
const ERIN = SEED_USERS[4]?.id ?? "";

type Database = Awaited<ReturnType<typeof openTestDatabase>>;
type DealState = (typeof schema.deals.$inferInsert)["state"];
type PayoutState = (typeof schema.payouts.$inferInsert)["state"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mismatch store", () => {
  let database: Database;

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
  });

  afterAll(async () => {
    await database.close();
  });

  it("allows one open mismatch for each key", async () => {
    const [deal] = await database.db
      .insert(schema.deals)
      .values({ title: "Store", buyerId: ALICE, sellerId: CAROL, totalMinor: 100 })
      .returning({ id: schema.deals.id });
    const key = randomUUID();
    const row = {
      kind: "missing_in_ledger" as const,
      dealId: deal?.id ?? "",
      idempotencyKey: key,
      chainTxId: "tx-1",
      chainAmountMinor: 100,
    };
    await database.db.insert(schema.mismatches).values(row);
    await expect(database.db.insert(schema.mismatches).values(row)).rejects.toThrow();
    await database.db
      .update(schema.mismatches)
      .set({ closedAt: new Date() })
      .where(eq(schema.mismatches.idempotencyKey, key));
    await database.db.insert(schema.mismatches).values(row);
    const open = await database.db
      .select()
      .from(schema.mismatches)
      .where(and(eq(schema.mismatches.idempotencyKey, key), isNull(schema.mismatches.closedAt)));
    expect(open).toHaveLength(1);
  });
});

describe("reconciliation job", () => {
  let database: Database;
  let startedAt: Date;
  let clock: number;
  let chain: ReturnType<typeof createFakeChain>;

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
  });

  afterAll(async () => {
    await database.close();
  });

  /** A new chain and a start time that is later than the rows of every earlier test. */
  async function begin(script: readonly Step[] = []) {
    await sleep(5);
    startedAt = new Date();
    clock = startedAt.getTime() + 60_000;
    chain = createFakeChain(script);
    await sleep(5);
  }

  function job(over: Chain = chain, at: Date = startedAt) {
    return createReconciliationJob({
      db: database.db,
      chain: over,
      startedAt: at,
      now: () => new Date(clock),
    });
  }

  async function run(over: Chain = chain) {
    clock += 3_600_000;
    await job(over).runOnce();
  }

  async function seedDeal(state: DealState, totalMinor = 1_000) {
    const key = randomUUID();
    const [deal] = await database.db
      .insert(schema.deals)
      .values({
        title: "Reconcile",
        buyerId: ALICE,
        sellerId: CAROL,
        totalMinor,
        state,
        fundingIdempotencyKey: key,
      })
      .returning({ id: schema.deals.id });
    return { dealId: deal?.id ?? "", key };
  }

  async function seedPayout(
    dealId: string,
    state: PayoutState,
    amountMinor = 400,
    chainTxId: string | null = null,
  ) {
    const key = randomUUID();
    const [milestone] = await database.db
      .insert(schema.milestones)
      .values({ dealId, position: 1, title: "Draft", amountMinor })
      .returning({ id: schema.milestones.id });
    const [payout] = await database.db
      .insert(schema.payouts)
      .values({
        milestoneId: milestone?.id ?? "",
        idempotencyKey: key,
        state,
        approvedBy: ERIN,
        chainTxId,
      })
      .returning({ id: schema.payouts.id });
    return { payoutId: payout?.id ?? "", key };
  }

  const ledger = (dealId: string, kind: "deposit" | "payout", amountMinor: number, tx: string) =>
    database.db.insert(schema.ledgerEntries).values({ dealId, kind, amountMinor, chainTxId: tx });

  const mismatchesOf = (dealId: string) =>
    database.db
      .select()
      .from(schema.mismatches)
      .where(eq(schema.mismatches.dealId, dealId))
      .orderBy(schema.mismatches.foundAt, schema.mismatches.id);

  it("records a transfer that has no ledger Payout", async () => {
    await begin();
    const { dealId } = await seedDeal("funded");
    const { payoutId, key } = await seedPayout(dealId, "failed", 400);
    const transfer = await chain.transfer(CAROL, 400, key);
    await run();
    const rows = await mismatchesOf(dealId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "missing_in_ledger",
      dealId,
      payoutId,
      idempotencyKey: key,
      chainTxId: transfer.ok ? transfer.txId : "",
      chainAmountMinor: 400,
      ledgerAmountMinor: null,
      closedAt: null,
    });
  });

  it("records a deposit that has no ledger row", async () => {
    await begin();
    const { dealId, key } = await seedDeal("funding_failed", 900);
    const lock = await chain.lock(dealId, 900, key);
    await run();
    const rows = await mismatchesOf(dealId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "missing_in_ledger",
      payoutId: null,
      idempotencyKey: key,
      chainTxId: lock.ok ? lock.txId : "",
      chainAmountMinor: 900,
      closedAt: null,
    });
  });

  it("records a ledger Payout that the chain does not know", async () => {
    await begin();
    const { dealId } = await seedDeal("funded");
    const { payoutId, key } = await seedPayout(dealId, "confirmed", 400, "tx-lost-1");
    await ledger(dealId, "payout", 400, "tx-lost-1");
    await run();
    const rows = await mismatchesOf(dealId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "missing_on_chain",
      payoutId,
      idempotencyKey: key,
      chainTxId: "tx-lost-1",
      ledgerAmountMinor: 400,
      chainAmountMinor: null,
    });
  });

  it("records a ledger deposit that the chain does not know", async () => {
    await begin();
    const { dealId, key } = await seedDeal("funded", 900);
    await ledger(dealId, "deposit", 900, "tx-lost-2");
    await run();
    const rows = await mismatchesOf(dealId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "missing_on_chain",
      payoutId: null,
      idempotencyKey: key,
      chainTxId: "tx-lost-2",
      ledgerAmountMinor: 900,
    });
  });

  it("records a ledger Payout whose amount differs from the chain", async () => {
    await begin();
    const { dealId } = await seedDeal("funded");
    const { payoutId, key } = await seedPayout(dealId, "confirmed", 400);
    const transfer = await chain.transfer(CAROL, 350, key);
    const txId = transfer.ok ? transfer.txId : "";
    await database.db
      .update(schema.payouts)
      .set({ chainTxId: txId })
      .where(eq(schema.payouts.id, payoutId));
    await ledger(dealId, "payout", 400, txId);
    await run();
    const rows = await mismatchesOf(dealId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "amount_differs",
      payoutId,
      chainTxId: txId,
      ledgerAmountMinor: 400,
      chainAmountMinor: 350,
    });
  });

  it("records a ledger deposit whose amount differs from the chain", async () => {
    await begin();
    const { dealId, key } = await seedDeal("completed", 900);
    const lock = await chain.lock(dealId, 800, key);
    await ledger(dealId, "deposit", 900, lock.ok ? lock.txId : "");
    await run();
    const rows = await mismatchesOf(dealId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "amount_differs",
      payoutId: null,
      ledgerAmountMinor: 900,
      chainAmountMinor: 800,
    });
  });

  it("records nothing when the ledger and the chain agree", async () => {
    await begin();
    const { dealId, key } = await seedDeal("funded", 900);
    const lock = await chain.lock(dealId, 900, key);
    await ledger(dealId, "deposit", 900, lock.ok ? lock.txId : "");
    const payout = await seedPayout(dealId, "confirmed", 400);
    const transfer = await chain.transfer(CAROL, 400, payout.key);
    const txId = transfer.ok ? transfer.txId : "";
    await database.db
      .update(schema.payouts)
      .set({ chainTxId: txId })
      .where(eq(schema.payouts.id, payout.payoutId));
    await ledger(dealId, "payout", 400, txId);
    await run();
    expect(await mismatchesOf(dealId)).toHaveLength(0);
  });

  it("skips a Payout in pending and a Deal in funding", async () => {
    await begin();
    const { dealId, key } = await seedDeal("funding", 900);
    await chain.lock(dealId, 900, key);
    const payout = await seedPayout(dealId, "pending", 400);
    await chain.transfer(CAROL, 400, payout.key);
    await run();
    expect(await mismatchesOf(dealId)).toHaveLength(0);
  });

  it("records no duplicate for a mismatch that is still open", async () => {
    await begin();
    const { dealId } = await seedDeal("funded");
    const { key } = await seedPayout(dealId, "failed", 400);
    await chain.transfer(CAROL, 400, key);
    await run();
    const [first] = await mismatchesOf(dealId);
    await run();
    await run();
    const rows = await mismatchesOf(dealId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first?.id);
    expect(rows[0]?.closedAt).toBeNull();
  });

  it("closes a mismatch with the time when the next run finds no difference", async () => {
    await begin();
    const { dealId } = await seedDeal("funded");
    const { payoutId, key } = await seedPayout(dealId, "failed", 400);
    const transfer = await chain.transfer(CAROL, 400, key);
    await run();
    const txId = transfer.ok ? transfer.txId : "";
    await database.db
      .update(schema.payouts)
      .set({ state: "confirmed", chainTxId: txId })
      .where(eq(schema.payouts.id, payoutId));
    await ledger(dealId, "payout", 400, txId);
    await run();
    const rows = await mismatchesOf(dealId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.closedAt).toEqual(new Date(clock));
  });

  it("closes the old mismatch and opens a new one when the kind changes", async () => {
    await begin();
    const { dealId, key } = await seedDeal("funded", 900);
    const lock = await chain.lock(dealId, 800, key);
    await run();
    expect((await mismatchesOf(dealId)).map((m) => m.kind)).toEqual(["missing_in_ledger"]);
    await ledger(dealId, "deposit", 900, lock.ok ? lock.txId : "");
    await run();
    const rows = await mismatchesOf(dealId);
    expect(rows.map((m) => [m.kind, m.closedAt === null])).toEqual([
      ["missing_in_ledger", false],
      ["amount_differs", true],
    ]);
  });

  it("keeps the open mismatch of a key that the run skips because of a chain failure", async () => {
    await begin();
    const { dealId } = await seedDeal("funded");
    const { key } = await seedPayout(dealId, "failed", 400);
    await chain.transfer(CAROL, 400, key);
    await run();
    const flaky: Chain = {
      lock: (d, a, k) => chain.lock(d, a, k),
      transfer: (s, a, k) => chain.transfer(s, a, k),
      status: () => Promise.resolve({ state: "unknown" }),
    };
    const failing: Chain = {
      ...flaky,
      status: () => Promise.resolve({ state: "failed", failure: "timeout" }),
    };
    await run(failing);
    expect((await mismatchesOf(dealId)).map((m) => m.closedAt)).toEqual([null]);
  });

  it("keeps the open mismatch of a row that another transaction locks", async () => {
    await begin();
    const { dealId } = await seedDeal("funded");
    const { payoutId, key } = await seedPayout(dealId, "failed", 400);
    await chain.transfer(CAROL, 400, key);
    await run();
    const unknown: Chain = { ...chain, status: () => Promise.resolve({ state: "unknown" }) };
    await database.db.transaction(async (tx) => {
      await tx
        .select({ id: schema.payouts.id })
        .from(schema.payouts)
        .where(eq(schema.payouts.id, payoutId))
        .for("update");
      await run(unknown);
    });
    expect((await mismatchesOf(dealId)).map((m) => m.closedAt)).toEqual([null]);
    await run(unknown);
    expect((await mismatchesOf(dealId)).map((m) => m.closedAt === null)).toEqual([false]);
  });

  it("checks only rows that were created at or after startedAt", async () => {
    await begin();
    const { dealId } = await seedDeal("funded");
    const { key } = await seedPayout(dealId, "failed", 400);
    await chain.transfer(CAROL, 400, key);
    clock += 3_600_000;
    await job(chain, new Date(startedAt.getTime() + 3_600_000)).runOnce();
    expect(await mismatchesOf(dealId)).toHaveLength(0);
  });

  it("never closes a mismatch that was found before startedAt", async () => {
    await begin();
    const { dealId, key } = await seedDeal("funded", 900);
    await database.db.insert(schema.mismatches).values({
      kind: "missing_in_ledger",
      dealId,
      idempotencyKey: key,
      chainTxId: "tx-old",
      chainAmountMinor: 900,
      foundAt: new Date(startedAt.getTime() - 3_600_000),
    });
    await run();
    expect((await mismatchesOf(dealId)).map((m) => m.closedAt)).toEqual([null]);
  });

  it("runs one pass at a time and records one mismatch", async () => {
    await begin();
    const { dealId } = await seedDeal("funded");
    const { key } = await seedPayout(dealId, "failed", 400);
    await chain.transfer(CAROL, 400, key);
    const same = job();
    await Promise.all([same.runOnce(), same.runOnce(), same.runOnce()]);
    expect(await mismatchesOf(dealId)).toHaveLength(1);
  });

  describe("on a timer", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("runs every hour until it stops", async () => {
      await begin();
      const { dealId } = await seedDeal("funded");
      const { key } = await seedPayout(dealId, "failed", 400);
      await chain.transfer(CAROL, 400, key);
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const timed = job();
      timed.start();
      timed.start();
      vi.advanceTimersByTime(3_599_999);
      expect(await mismatchesOf(dealId)).toHaveLength(0);
      vi.advanceTimersByTime(1);
      await vi.waitFor(async () => {
        expect(await mismatchesOf(dealId)).toHaveLength(1);
      });
      timed.stop();
      let asked = 0;
      const counting: Chain = {
        ...chain,
        status: (k) => {
          asked += 1;
          return chain.status(k);
        },
      };
      const stopped = job(counting);
      stopped.start();
      stopped.stop();
      vi.advanceTimersByTime(7_200_000);
      await sleep(50);
      expect(asked).toBe(0);
    });

    it("calls onError when a timed run throws, and runs again", async () => {
      await begin();
      const errors: unknown[] = [];
      const broken: Chain = {
        ...chain,
        status: () => Promise.reject(new Error("chain broke")),
      };
      await seedDeal("funded");
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const timed = createReconciliationJob({
        db: database.db,
        chain: broken,
        startedAt,
        onError: (error) => errors.push(error),
      });
      timed.start();
      vi.advanceTimersByTime(3_600_000);
      await vi.waitFor(() => {
        expect(errors).toHaveLength(1);
      });
      vi.advanceTimersByTime(3_600_000);
      await vi.waitFor(() => {
        expect(errors).toHaveLength(2);
      });
      timed.stop();
    });
  });
});
