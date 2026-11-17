import { SEED_USERS, schema, seedUsers } from "@escrow-lab/db";
import { ApprovalQueueResponse, DealResponse, RetryPayoutResponse } from "@escrow-lab/shared";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import {
  createFakeChain,
  type Chain,
  type Step as ChainStep,
} from "../src/adapters/chain/index.ts";
import { createFakePaymentRail } from "../src/adapters/payment-rail/index.ts";
import { createFundingRetryJob } from "../src/modules/payout/index.ts";
import { openTestDatabase, testConfig } from "./database.ts";
import { cookieOf, signIn } from "./harness.ts";

const ALICE = SEED_USERS[0]?.id ?? "";
const CAROL = SEED_USERS[2]?.id ?? "";
const ERIN = SEED_USERS[4]?.id ?? "";

type Database = Awaited<ReturnType<typeof openTestDatabase>>;

describe("retry a Payout", () => {
  let database: Database;
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  /** An app and a job that share one scripted fake chain. The fake records each key. */
  async function start(chainScript: ChainStep[]) {
    // The first step of the fake chain is for the funding lock, so the script starts after it.
    const fake = createFakeChain([{ kind: "ok" }, ...chainScript]);
    const transferKeys: string[] = [];
    const chain: Chain = {
      lock: (deal, amount, key) => fake.lock(deal, amount, key),
      transfer: (seller, amount, key) => {
        transferKeys.push(key);
        return fake.transfer(seller, amount, key);
      },
    };
    const paymentRail = createFakePaymentRail([]);
    const app = await buildApp({
      config: testConfig,
      db: database.db,
      logger: false,
      chain,
      paymentRail,
    });
    apps.push(app);
    let clock = Date.now();
    const job = createFundingRetryJob({
      db: database.db,
      chain,
      paymentRail,
      now: () => new Date(clock),
    });
    const sessions = new Map<string, { cookie: string; csrfToken: string }>();
    async function call(userId: string, method: "GET" | "POST", url: string, payload: object = {}) {
      let who = sessions.get(userId);
      if (who === undefined) {
        who = await signIn(app, userId);
        sessions.set(userId, who);
      }
      return app.inject({
        method,
        url,
        headers: { cookie: who.cookie, "x-csrf-token": who.csrfToken },
        ...(method === "POST" ? { payload } : {}),
      });
    }
    /** A funded Deal with the first Milestone approved. The first transfer try takes the first script step. */
    async function approvedPayout() {
      const created = await call(ALICE, "POST", "/api/deals", {
        sellerId: CAROL,
        title: "Logo design",
        totalMinor: 100_000,
        express: false,
        milestones: [
          { title: "Draft", amountMinor: 40_000 },
          { title: "Final", amountMinor: 60_000 },
        ],
      });
      const dealId = DealResponse.parse(created.json()).id;
      await call(ALICE, "POST", `/api/deals/${dealId}/fund`);
      const [milestone] = await database.db
        .select({ id: schema.milestones.id })
        .from(schema.milestones)
        .where(eq(schema.milestones.dealId, dealId))
        .orderBy(schema.milestones.position);
      const milestoneId = milestone?.id ?? "";
      await call(CAROL, "POST", `/api/milestones/${milestoneId}/evidence`, {
        evidenceText: "Done",
      });
      await call(ALICE, "POST", `/api/milestones/${milestoneId}/accept`);
      const approved = await call(ERIN, "POST", `/api/milestones/${milestoneId}/payout`);
      expect(approved.statusCode).toBe(200);
      return { dealId, milestoneId };
    }
    return {
      call,
      job,
      transferKeys,
      fake,
      approvedPayout,
      now: () => clock,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  const payoutOf = async (milestoneId: string) =>
    (
      await database.db
        .select()
        .from(schema.payouts)
        .where(eq(schema.payouts.milestoneId, milestoneId))
    )[0];
  const ledgerOf = (dealId: string) =>
    database.db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.dealId, dealId));
  const auditActions = async (dealId: string) =>
    (
      await database.db
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.dealId, dealId))
    ).map((event) => event.action);

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
  });

  afterAll(async () => {
    for (const app of apps) await app.close();
    await database.close();
  });

  it("[CTRL-PAY-02] sends a lost transfer again with the same key, and the ledger has one Payout", async () => {
    const t = await start([{ kind: "lose_reply" }]);
    const { dealId, milestoneId } = await t.approvedPayout();
    const before = await payoutOf(milestoneId);
    expect(before).toMatchObject({ state: "pending", attempts: 0, nextTryAt: null });
    await t.job.runOnce({ dealIds: [dealId] });
    expect(t.transferKeys).toEqual([before?.idempotencyKey, before?.idempotencyKey]);
    // The chain moved the 1000 pound lock once and the 400 pound transfer once.
    expect(t.fake.moved).toBe(140_000);
    expect(t.fake.events.filter((event) => event.party === CAROL)).toHaveLength(1);
    expect((await payoutOf(milestoneId))?.state).toBe("confirmed");
    const payouts = (await ledgerOf(dealId)).filter((entry) => entry.kind === "payout");
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({
      amountMinor: 40_000,
      chainTxId: t.fake.events.find((event) => event.party === CAROL)?.txId,
    });
    expect(await auditActions(dealId)).toContain("payout_confirmed");
  });

  it("marks the Payout failed after 5 failed tries, with no ledger Payout and a queue item", async () => {
    const fails: ChainStep[] = Array.from({ length: 6 }, () => ({
      kind: "fail",
      failure: "timeout",
    }));
    const t = await start(fails);
    const { dealId, milestoneId } = await t.approvedPayout();
    // The approve action made no try that counts: it leaves 0 attempts and no next try time.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      t.advance(60_000);
      await t.job.runOnce({ dealIds: [dealId] });
      const row = await payoutOf(milestoneId);
      expect(row?.attempts).toBe(attempt);
      if (attempt < 5) expect(row?.state).toBe("pending");
    }
    expect(await payoutOf(milestoneId)).toMatchObject({ state: "failed", nextTryAt: null });
    expect((await ledgerOf(dealId)).filter((entry) => entry.kind === "payout")).toHaveLength(0);
    expect(await auditActions(dealId)).toContain("payout_failed");
    const queue = ApprovalQueueResponse.parse((await t.call(ERIN, "GET", "/api/approvals")).json());
    const failed = queue.items.filter(
      (item) => item.kind === "failed_payout" && item.dealId === dealId,
    );
    expect(failed).toHaveLength(1);
    // A sixth run does nothing.
    t.advance(60_000);
    await t.job.runOnce({ dealIds: [dealId] });
    expect(t.transferKeys).toHaveLength(6);
  });

  it("doubles the wait after each failure, from 1 second", async () => {
    const fails: ChainStep[] = Array.from({ length: 6 }, () => ({
      kind: "fail",
      failure: "timeout",
    }));
    const t = await start(fails);
    const { dealId, milestoneId } = await t.approvedPayout();
    const gaps: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      t.advance(60_000);
      const at = t.now();
      await t.job.runOnce({ dealIds: [dealId] });
      gaps.push(((await payoutOf(milestoneId))?.nextTryAt?.getTime() ?? 0) - at);
    }
    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it("does not try a Payout before its next try time", async () => {
    const t = await start([{ kind: "fail", failure: "timeout" }]);
    const { dealId, milestoneId } = await t.approvedPayout();
    await database.db
      .update(schema.payouts)
      .set({ nextTryAt: new Date(t.now() + 60_000) })
      .where(eq(schema.payouts.milestoneId, milestoneId));
    await t.job.runOnce({ dealIds: [dealId] });
    expect(t.transferKeys).toHaveLength(1);
  });

  it("[CTRL-PAY-02] skips a Payout that another try holds with a row lock", async () => {
    const t = await start([{ kind: "lose_reply" }]);
    const { dealId, milestoneId } = await t.approvedPayout();
    const payout = await payoutOf(milestoneId);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockedRow = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = database.db.transaction(async (tx) => {
      await tx.execute(sql`select id from payouts where id = ${payout?.id ?? ""} for update`);
      locked();
      await held;
    });
    await lockedRow;
    await t.job.runOnce({ dealIds: [dealId] });
    expect(t.transferKeys).toHaveLength(1);
    release();
    await holder;
    await t.job.runOnce({ dealIds: [dealId] });
    expect(t.transferKeys).toHaveLength(2);
    expect((await payoutOf(milestoneId))?.state).toBe("confirmed");
  });

  it("leaves a Payout alone when it left pending during a failing try, and writes no audit event", async () => {
    const t = await start([{ kind: "fail", failure: "timeout" }]);
    const { dealId, milestoneId } = await t.approvedPayout();
    await database.db
      .update(schema.payouts)
      .set({ attempts: 4, nextTryAt: null })
      .where(eq(schema.payouts.milestoneId, milestoneId));
    const auditBefore = await auditActions(dealId);
    const stale: Chain = {
      lock: (deal, amount, key) => t.fake.lock(deal, amount, key),
      transfer: async () => {
        await database.db
          .update(schema.payouts)
          .set({ state: "failed" })
          .where(eq(schema.payouts.milestoneId, milestoneId));
        return { ok: false, failure: "timeout" };
      },
    };
    const job = createFundingRetryJob({
      db: database.db,
      chain: stale,
      paymentRail: createFakePaymentRail([]),
      now: () => new Date(t.now()),
    });
    await job.runOnce({ dealIds: [dealId] });
    expect(await payoutOf(milestoneId)).toMatchObject({ state: "failed", attempts: 4 });
    expect(await auditActions(dealId)).toEqual(auditBefore);
  });

  describe("POST /api/payouts/:id/retry", () => {
    /** A Payout that the job failed after 5 tries. */
    async function failedPayout() {
      const t = await start(
        Array.from({ length: 6 }, (): ChainStep => ({ kind: "fail", failure: "timeout" })),
      );
      const { dealId, milestoneId } = await t.approvedPayout();
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        t.advance(60_000);
        await t.job.runOnce({ dealIds: [dealId] });
      }
      const payout = await payoutOf(milestoneId);
      expect(payout?.state).toBe("failed");
      return { t, dealId, milestoneId, payoutId: payout?.id ?? "", key: payout?.idempotencyKey };
    }

    it("sets the Payout pending with 0 tries and the same key, audits it, and the job pays once", async () => {
      const { t, dealId, milestoneId, payoutId, key } = await failedPayout();
      const response = await t.call(ERIN, "POST", `/api/payouts/${payoutId}/retry`);
      expect(response.statusCode).toBe(200);
      expect(RetryPayoutResponse.parse(response.json())).toEqual({ payoutId, state: "pending" });
      const row = await payoutOf(milestoneId);
      expect(row).toMatchObject({ state: "pending", attempts: 0, idempotencyKey: key });
      expect(row?.nextTryAt?.getTime() ?? Number.MAX_SAFE_INTEGER).toBeLessThanOrEqual(Date.now());
      expect(await auditActions(dealId)).toContain("retry_payout");
      await t.job.runOnce({ dealIds: [dealId] });
      expect(t.transferKeys.at(-1)).toBe(key);
      expect((await payoutOf(milestoneId))?.state).toBe("confirmed");
      expect((await ledgerOf(dealId)).filter((entry) => entry.kind === "payout")).toHaveLength(1);
    });

    it("returns 409 and changes nothing for a Payout that is not failed", async () => {
      const t = await start([{ kind: "fail", failure: "timeout" }]);
      const { dealId, milestoneId } = await t.approvedPayout();
      const before = await payoutOf(milestoneId);
      const auditBefore = await auditActions(dealId);
      const response = await t.call(ERIN, "POST", `/api/payouts/${before?.id ?? ""}/retry`);
      expect(response.statusCode).toBe(409);
      expect(await payoutOf(milestoneId)).toEqual(before);
      expect(await auditActions(dealId)).toEqual(auditBefore);
    });

    it("returns 404 for an unknown Payout", async () => {
      const t = await start([]);
      const response = await t.call(ERIN, "POST", `/api/payouts/${randomUUID()}/retry`);
      expect(response.statusCode).toBe(404);
    });

    it("[CTRL-PAY-01] gives a Buyer and a Seller 403, nobody 401, and changes nothing", async () => {
      const { t, milestoneId, payoutId } = await failedPayout();
      expect((await t.call(ALICE, "POST", `/api/payouts/${payoutId}/retry`)).statusCode).toBe(403);
      expect((await t.call(CAROL, "POST", `/api/payouts/${payoutId}/retry`)).statusCode).toBe(403);
      const anonymous = await apps.at(-1)?.inject({
        method: "POST",
        url: `/api/payouts/${payoutId}/retry`,
      });
      expect(anonymous?.statusCode).toBe(401);
      expect((await payoutOf(milestoneId))?.state).toBe("failed");
    });

    it("refuses a request without the CSRF token and a body with unknown fields", async () => {
      const { t, milestoneId, payoutId } = await failedPayout();
      const app = apps.at(-1);
      const visit = await t.call(ERIN, "GET", "/api/approvals");
      const noCsrf = await app?.inject({
        method: "POST",
        url: `/api/payouts/${payoutId}/retry`,
        headers: { cookie: cookieOf(visit) },
        payload: {},
      });
      expect(noCsrf?.statusCode).toBe(403);
      const extra = await t.call(ERIN, "POST", `/api/payouts/${payoutId}/retry`, { extra: 1 });
      expect(extra.statusCode).toBe(400);
      expect((await payoutOf(milestoneId))?.state).toBe("failed");
    });
  });
});
