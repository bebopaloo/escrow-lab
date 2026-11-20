import { SEED_USERS, schema, seedUsers } from "@escrow-lab/db";
import { ApprovalQueueResponse, ApprovePayoutResponse, DealResponse } from "@escrow-lab/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { createFakeChain, type Chain, type Step } from "../src/adapters/chain/index.ts";
import { openTestDatabase, testConfig } from "./database.ts";
import { signIn as signInOn, type Session } from "./harness.ts";

const ALICE = SEED_USERS[0]?.id ?? "";
const CAROL = SEED_USERS[2]?.id ?? "";
const ERIN = SEED_USERS[4]?.id ?? "";

type Database = Awaited<ReturnType<typeof openTestDatabase>>;

describe("Approve a Payout", () => {
  let database: Database;
  let fake = createFakeChain();
  let transfers: { seller: string; amount: number; key: string }[];
  let app: Awaited<ReturnType<typeof buildApp>>;
  const sessions = new Map<string, Session>();

  async function signIn(userId: string): Promise<Session> {
    const known = sessions.get(userId);
    if (known !== undefined) return known;
    const session = await signInOn(app, userId);
    sessions.set(userId, session);
    return session;
  }

  async function call(
    userId: string,
    method: "GET" | "POST",
    url: string,
    payload: object = {},
    withCsrf = true,
  ) {
    const who = await signIn(userId);
    return app.inject({
      method,
      url,
      headers: { cookie: who.cookie, ...(withCsrf ? { "x-csrf-token": who.csrfToken } : {}) },
      ...(method === "POST" ? { payload } : {}),
    });
  }

  /** A funded Deal of 400 and 600 pounds. Milestone 1 is accepted when `accept` is true. */
  async function newDeal(accept = true) {
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
    const milestones = await database.db
      .select({ id: schema.milestones.id })
      .from(schema.milestones)
      .where(eq(schema.milestones.dealId, dealId))
      .orderBy(schema.milestones.position);
    const first = milestones[0]?.id ?? "";
    const second = milestones[1]?.id ?? "";
    if (accept) {
      await call(CAROL, "POST", `/api/milestones/${first}/evidence`, { evidenceText: "Done" });
      await call(ALICE, "POST", `/api/milestones/${first}/accept`);
    }
    return { dealId, first, second };
  }

  /** Replaces the fake chain with one that follows the steps. */
  const scriptChain = (steps: Step[]) => {
    fake = createFakeChain(steps);
  };
  const approve = (userId: string, milestoneId: string, withCsrf = true) =>
    call(userId, "POST", `/api/milestones/${milestoneId}/payout`, {}, withCsrf);
  const milestone = async (id: string) =>
    (await database.db.select().from(schema.milestones).where(eq(schema.milestones.id, id)))[0];
  const ledger = (dealId: string) =>
    database.db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.dealId, dealId));
  const payouts = (milestoneId: string) =>
    database.db.select().from(schema.payouts).where(eq(schema.payouts.milestoneId, milestoneId));
  const audit = async (dealId: string) =>
    (
      await database.db
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.dealId, dealId))
    ).map((event) => event.action);

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
    transfers = [];
    const chain: Chain = {
      lock: (deal, amount, key) => fake.lock(deal, amount, key),
      transfer: (seller, amount, key) => {
        transfers.push({ seller, amount, key });
        return fake.transfer(seller, amount, key);
      },
    };
    app = await buildApp({ config: testConfig, db: database.db, logger: false, chain });
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("pays the Milestone, opens the next one and audits it", async () => {
    const { dealId, first, second } = await newDeal();
    const response = await approve(ERIN, first);
    expect(response.statusCode).toBe(200);
    const body = ApprovePayoutResponse.parse(response.json());
    expect(body).toMatchObject({ milestoneId: first, state: "confirmed" });

    const entries = (await ledger(dealId)).filter((entry) => entry.kind === "payout");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.amountMinor).toBe(40_000);
    expect((await milestone(first))?.state).toBe("paid");
    expect((await milestone(second))?.state).toBe("awaiting_evidence");
    const [payout] = await payouts(first);
    expect(payout).toMatchObject({ state: "confirmed", approvedBy: ERIN });
    expect(payout?.chainTxId).toBe(entries[0]?.chainTxId);
    expect(await audit(dealId)).toEqual(
      expect.arrayContaining(["approve_payout", "payout_confirmed"]),
    );
    expect(transfers.at(-1)).toEqual({
      seller: CAROL,
      amount: 40_000,
      key: payout?.idempotencyKey,
    });
  });
  it("completes the Deal when the last Milestone is paid", async () => {
    const { dealId, first, second } = await newDeal();
    expect((await approve(ERIN, first)).statusCode).toBe(200);
    await call(CAROL, "POST", `/api/milestones/${second}/evidence`, { evidenceText: "Done" });
    await call(ALICE, "POST", `/api/milestones/${second}/accept`);
    expect((await approve(ERIN, second)).statusCode).toBe(200);
    expect((await milestone(second))?.state).toBe("paid");
    const deal = (
      await database.db.select().from(schema.deals).where(eq(schema.deals.id, dealId))
    )[0];
    expect(deal?.state).toBe("completed");
    const amounts = (await ledger(dealId)).map(
      (entry) => `${entry.kind}:${String(entry.amountMinor)}`,
    );
    expect(amounts.sort()).toEqual(["deposit:100000", "payout:40000", "payout:60000"]);
  });

  describe("access control", () => {
    it("[CTRL-PAY-01] gives a Buyer and a Seller 403, and nobody 401, and changes nothing", async () => {
      const { first } = await newDeal();
      expect((await approve(ALICE, first)).statusCode).toBe(403);
      expect((await approve(CAROL, first)).statusCode).toBe(403);
      const anonymous = await app.inject({
        method: "POST",
        url: `/api/milestones/${first}/payout`,
      });
      expect(anonymous.statusCode).toBe(401);
      expect(await payouts(first)).toHaveLength(0);
      expect((await milestone(first))?.state).toBe("accepted");
    });

    it("refuses a request without the CSRF token", async () => {
      const { first } = await newDeal();
      expect((await approve(ERIN, first, false)).statusCode).toBe(403);
      expect(await payouts(first)).toHaveLength(0);
    });

    it("refuses a body with unknown fields", async () => {
      const { first } = await newDeal();
      const response = await call(ERIN, "POST", `/api/milestones/${first}/payout`, { amount: 1 });
      expect(response.statusCode).toBe(400);
      expect(await payouts(first)).toHaveLength(0);
    });

    it("gives 404 for a Milestone that does not exist", async () => {
      const response = await approve(ERIN, "99999999-9999-4999-8999-999999999999");
      expect(response.statusCode).toBe(404);
    });

    it("[CTRL-PAY-01] refuses an Approver who is the Buyer of the Deal", async () => {
      const { dealId, first } = await newDeal();
      await database.db
        .update(schema.deals)
        .set({ buyerId: ERIN })
        .where(eq(schema.deals.id, dealId));
      expect((await approve(ERIN, first)).statusCode).toBe(403);
      expect(await payouts(first)).toHaveLength(0);
    });

    it("[CTRL-PAY-01] refuses an Approver who is the Seller of the Deal", async () => {
      const { dealId, first } = await newDeal();
      await database.db
        .update(schema.deals)
        .set({ sellerId: ERIN })
        .where(eq(schema.deals.id, dealId));
      expect((await approve(ERIN, first)).statusCode).toBe(403);
      expect(await payouts(first)).toHaveLength(0);
    });
  });

  describe("state rules", () => {
    it("returns 409 for a Milestone that the Buyer has not accepted", async () => {
      const { first } = await newDeal(false);
      const before = transfers.length;
      expect((await approve(ERIN, first)).statusCode).toBe(409);
      expect(transfers.length).toBe(before);
      expect(await payouts(first)).toHaveLength(0);
    });

    it("[CTRL-PAY-02] returns 409 for a second approval and pays once", async () => {
      const { dealId, first } = await newDeal();
      expect((await approve(ERIN, first)).statusCode).toBe(200);
      expect((await approve(ERIN, first)).statusCode).toBe(409);
      expect((await ledger(dealId)).filter((e) => e.kind === "payout")).toHaveLength(1);
      expect(await payouts(first)).toHaveLength(1);
    });

    it("[CTRL-PAY-02] lets only one of two approvals at the same time pass", async () => {
      const { dealId, first } = await newDeal();
      const before = transfers.length;
      const results = await Promise.all([approve(ERIN, first), approve(ERIN, first)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect(transfers.length - before).toBe(1);
      expect((await ledger(dealId)).filter((e) => e.kind === "payout")).toHaveLength(1);
    });
  });

  describe("a first try that does not confirm", () => {
    it.each([
      ["fails", { kind: "fail", failure: "timeout" }],
      ["loses the reply", { kind: "lose_reply" }],
    ] as const)("leaves the Payout pending when the chain %s", async (_name, step) => {
      const { dealId, first } = await newDeal();
      scriptChain([step]);
      const response = await approve(ERIN, first);
      expect(response.statusCode).toBe(200);
      expect(ApprovePayoutResponse.parse(response.json()).state).toBe("pending");
      const [payout] = await payouts(first);
      expect(payout).toMatchObject({ state: "pending", attempts: 0, chainTxId: null });
      expect((await milestone(first))?.state).toBe("accepted");
      expect((await ledger(dealId)).filter((e) => e.kind === "payout")).toHaveLength(0);
      expect(await audit(dealId)).not.toContain("payout_confirmed");
      scriptChain([]);
    });
  });

  describe("approval queue", () => {
    const queue = async (
      userId: string,
      query = "",
    ): Promise<{ status: number; body: unknown }> => {
      const response = await call(userId, "GET", `/api/approvals${query}`);
      return { status: response.statusCode, body: response.json() };
    };

    it("is for Approvers only", async () => {
      expect((await queue(ALICE)).status).toBe(403);
      expect((await queue(CAROL)).status).toBe(403);
      const anonymous = await app.inject({ method: "GET", url: "/api/approvals" });
      expect(anonymous.statusCode).toBe(401);
    });

    it("lists accepted Milestones, failed Payouts and Deals in funding_failed", async () => {
      const accepted = await newDeal();
      const failedPayout = await newDeal();
      const failedDeal = await newDeal(false);
      await approve(ERIN, failedPayout.first);
      await database.db
        .update(schema.payouts)
        .set({ state: "failed" })
        .where(eq(schema.payouts.milestoneId, failedPayout.first));
      await database.db
        .update(schema.deals)
        .set({ state: "funding_failed" })
        .where(eq(schema.deals.id, failedDeal.dealId));

      const { status, body } = await queue(ERIN, "?limit=100");
      expect(status).toBe(200);
      const page = ApprovalQueueResponse.parse(body);
      const mine = new Set([accepted.dealId, failedPayout.dealId, failedDeal.dealId]);
      const items = page.items.filter((item) => mine.has(item.dealId));
      expect(items).toHaveLength(3);
      expect(items).toContainEqual(
        expect.objectContaining({
          kind: "milestone",
          id: accepted.first,
          dealId: accepted.dealId,
          title: "Draft",
          amountMinor: 40_000,
        }),
      );
      expect(items).toContainEqual(
        expect.objectContaining({ kind: "failed_payout", dealId: failedPayout.dealId }),
      );
      expect(items).toContainEqual(
        expect.objectContaining({
          kind: "funding_failed",
          id: failedDeal.dealId,
          totalMinor: 100_000,
        }),
      );
    });

    it("drops a Milestone once its Payout is approved", async () => {
      const { first } = await newDeal();
      await approve(ERIN, first);
      const page = ApprovalQueueResponse.parse((await queue(ERIN, "?limit=100")).body);
      expect(page.items.find((item) => item.id === first)).toBeUndefined();
    });

    it("does not list a Milestone whose Payout is pending", async () => {
      const { first, dealId } = await newDeal();
      scriptChain([{ kind: "fail", failure: "timeout" }]);
      await approve(ERIN, first);
      scriptChain([]);
      expect((await milestone(first))?.state).toBe("accepted");
      const page = ApprovalQueueResponse.parse((await queue(ERIN, "?limit=100")).body);
      expect(page.items.filter((item) => item.dealId === dealId)).toHaveLength(0);
    });

    it("lists a Milestone with a failed Payout once and counts it once", async () => {
      const before = ApprovalQueueResponse.parse((await queue(ERIN, "?limit=100")).body).total;
      const { first, dealId } = await newDeal();
      scriptChain([{ kind: "fail", failure: "timeout" }]);
      await approve(ERIN, first);
      scriptChain([]);
      await database.db
        .update(schema.payouts)
        .set({ state: "failed" })
        .where(eq(schema.payouts.milestoneId, first));
      const page = ApprovalQueueResponse.parse((await queue(ERIN, "?limit=100")).body);
      const mine = page.items.filter((item) => item.dealId === dealId);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.kind).toBe("failed_payout");
      expect(page.total - before).toBe(1);
    });

    it("pages the items and refuses a page size above the maximum", async () => {
      await newDeal();
      await newDeal();
      const first = ApprovalQueueResponse.parse((await queue(ERIN, "?limit=1&offset=0")).body);
      const second = ApprovalQueueResponse.parse((await queue(ERIN, "?limit=1&offset=1")).body);
      expect(first.items).toHaveLength(1);
      expect(second.items).toHaveLength(1);
      expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
      expect(first.total).toBeGreaterThanOrEqual(2);
      expect((await queue(ERIN, "?limit=101")).status).toBe(400);
      expect((await queue(ERIN, "?extra=1")).status).toBe(400);
    });
  });
});
