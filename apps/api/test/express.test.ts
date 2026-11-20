import { seedUsers } from "@escrow-lab/db";
import { ApprovalQueueResponse, DealResponse } from "@escrow-lab/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALICE,
  CAROL,
  ERIN,
  failures,
  startHarness,
  type Harness,
  type TestDatabase,
} from "./harness.ts";
import { openTestDatabase } from "./database.ts";

describe("express Deals", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
  });
  afterAll(async () => {
    await database.close();
  });

  async function fundedExpress(h: Harness) {
    const ids = await h.createDeal({ express: true });
    await h.step(h.fund(ids.dealId));
    await h.step(h.sendEvidence(ids.first));
    return ids;
  }

  it("queues an express Payout with no approver and sends no transfer when the Buyer accepts", async () => {
    const h = await startHarness(database);
    const ids = await fundedExpress(h);

    const accepted = await h.accept(ids.first);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ state: "accepted" });

    const snapshot = await h.snapshot(ids.dealId);
    expect(snapshot.milestones.map((m) => m.state)).toEqual(["accepted", "pending"]);
    expect(snapshot.payouts.map((p) => [p.state, p.approvedBy, p.express])).toEqual([
      ["pending", null, true],
    ]);
    expect(snapshot.calls.filter((c) => c.method === "transfer")).toHaveLength(0);
    const actions = snapshot.audit.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["accept", "express_payout"]));
    expect(actions).not.toContain("approve_payout");
    await h.close();
  });

  it("never sends the transfer of an express Payout that has no approver, even in the retry job", async () => {
    const h = await startHarness(database);
    const ids = await fundedExpress(h);
    await h.step(h.accept(ids.first));

    await h.runJob(ids.dealId, 2);
    const snapshot = await h.snapshot(ids.dealId);
    expect(snapshot.payouts.map((p) => [p.state, p.approvedBy])).toEqual([["pending", null]]);
    expect(snapshot.calls.filter((c) => c.method === "transfer")).toHaveLength(0);
    await h.close();
  });

  it("refuses the Buyer and the Seller who try to approve an express Payout", async () => {
    const h = await startHarness(database);
    const ids = await fundedExpress(h);
    await h.step(h.accept(ids.first));

    for (const who of [ALICE, CAROL]) {
      const refused = await h.call(who, "POST", `/api/milestones/${ids.first}/payout`);
      expect(refused.statusCode).toBe(403);
    }
    const snapshot = await h.snapshot(ids.dealId);
    expect(snapshot.payouts.map((p) => [p.state, p.approvedBy])).toEqual([["pending", null]]);
    expect(snapshot.calls.filter((c) => c.method === "transfer")).toHaveLength(0);
    await h.close();
  });

  it("pays the Milestone when an Approver approves the express Payout, and opens the next one", async () => {
    const h = await startHarness(database);
    const ids = await fundedExpress(h);
    await h.step(h.accept(ids.first));

    const approved = await h.approve(ids.first);
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ state: "confirmed" });

    const snapshot = await h.snapshot(ids.dealId);
    expect(snapshot.milestones.map((m) => m.state)).toEqual(["paid", "awaiting_evidence"]);
    expect(snapshot.payouts.map((p) => [p.state, p.approvedBy])).toEqual([["confirmed", ERIN]]);
    expect(snapshot.calls.filter((c) => c.method === "transfer")).toHaveLength(1);
    expect(snapshot.audit.map((e) => e.action)).toEqual(
      expect.arrayContaining(["approve_payout", "payout_confirmed"]),
    );
    const again = await h.approve(ids.first);
    expect(again.statusCode).toBe(409);
    await h.close();
  });

  it("keeps the express Payout pending for the retry job when the transfer does not confirm", async () => {
    const h = await startHarness(database, { chain: [{ kind: "ok" }, ...failures(1)] });
    const ids = await fundedExpress(h);
    await h.step(h.accept(ids.first));

    const approved = await h.approve(ids.first);
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ state: "pending" });
    expect((await h.payoutOf(ids.first))?.approvedBy).toBe(ERIN);

    await h.runJob(ids.dealId);
    expect((await h.payoutOf(ids.first))?.state).toBe("confirmed");
    const snapshot = await h.snapshot(ids.dealId);
    expect(snapshot.milestones.map((m) => m.state)).toEqual(["paid", "awaiting_evidence"]);
    await h.close();
  });

  it("lists express Payouts first in the order of their creation, marked express", async () => {
    const h = await startHarness(database);
    const plain = await h.createDeal();
    await h.step(h.fund(plain.dealId));
    await h.step(h.sendEvidence(plain.first));
    await h.step(h.accept(plain.first));
    const early = await fundedExpress(h);
    await h.step(h.accept(early.first));
    const late = await fundedExpress(h);
    await h.step(h.accept(late.first));

    const queue = ApprovalQueueResponse.parse(
      (await h.call(ERIN, "GET", "/api/approvals?limit=100")).json(),
    );
    const mine = new Set([plain.first, early.first, late.first]);
    const ours = queue.items.filter((item) => mine.has(item.id));
    expect(ours.map((item) => [item.kind, item.id])).toEqual([
      ["express_payout", early.first],
      ["express_payout", late.first],
      ["milestone", plain.first],
    ]);
    const firstExpress = queue.items.findIndex((item) => item.kind === "express_payout");
    expect(queue.items.slice(0, firstExpress)).toEqual([]);
    expect(
      queue.items.slice(firstExpress).findIndex((item) => item.kind !== "express_payout"),
    ).toBe(queue.items.filter((item) => item.kind === "express_payout").length);
    expect(queue.total).toBeGreaterThanOrEqual(3);
    await h.close();
  });

  it("keeps the approval queue for a Deal that is not express", async () => {
    const h = await startHarness(database);
    const ids = await h.createDeal();
    await h.step(h.fund(ids.dealId));
    await h.step(h.sendEvidence(ids.first));
    await h.step(h.accept(ids.first));

    const snapshot = await h.snapshot(ids.dealId);
    expect(snapshot.milestones[0]?.state).toBe("accepted");
    expect(snapshot.payouts).toEqual([]);
    expect(snapshot.audit.map((e) => e.action)).not.toContain("express_payout");
    await h.close();
  });

  it("makes a new Deal express by default, shows the setting, and refuses a non-boolean", async () => {
    const h = await startHarness(database);
    const body = {
      sellerId: SELLER,
      title: "Default",
      totalMinor: 1000,
      milestones: [{ title: "One", amountMinor: 1000 }],
    };
    const made = await h.call(ALICE, "POST", "/api/deals", body);
    expect(made.statusCode).toBe(201);
    expect(DealResponse.parse(made.json()).express).toBe(true);
    const off = await h.call(ALICE, "POST", "/api/deals", { ...body, express: false });
    expect(DealResponse.parse(off.json()).express).toBe(false);
    const bad = await h.call(ALICE, "POST", "/api/deals", { ...body, express: "yes" });
    expect(bad.statusCode).toBe(400);
    await h.close();
  });
});

const SELLER = "00000000-0000-4000-8000-000000000003";
