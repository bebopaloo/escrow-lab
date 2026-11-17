import { seedUsers } from "@escrow-lab/db";
import { DealResponse } from "@escrow-lab/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, failures, startHarness, type Harness, type TestDatabase } from "./harness.ts";
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

  it("pays the Milestone at once when the Buyer accepts, and opens the next one", async () => {
    const h = await startHarness(database);
    const ids = await fundedExpress(h);

    const accepted = await h.accept(ids.first);
    expect(accepted.statusCode).toBe(200);

    const snapshot = await h.snapshot(ids.dealId);
    expect(snapshot.milestones.map((m) => m.state)).toEqual(["paid", "awaiting_evidence"]);
    expect(snapshot.payouts.map((p) => [p.state, p.approvedBy])).toEqual([["confirmed", ALICE]]);
    expect(snapshot.calls.filter((c) => c.method === "transfer")).toHaveLength(1);
    expect(snapshot.audit.map((e) => e.action)).toEqual(
      expect.arrayContaining(["accept", "express_payout", "payout_confirmed"]),
    );
    await h.close();
  });

  it("returns the Milestone as accepted and keeps the Payout pending when the transfer fails", async () => {
    const h = await startHarness(database, { chain: [{ kind: "ok" }, ...failures(1)] });
    const ids = await fundedExpress(h);

    const accepted = await h.accept(ids.first);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ state: "accepted" });
    expect((await h.payoutOf(ids.first))?.state).toBe("pending");

    await h.runJob(ids.dealId);
    expect((await h.payoutOf(ids.first))?.state).toBe("confirmed");
    const snapshot = await h.snapshot(ids.dealId);
    expect(snapshot.milestones.map((m) => m.state)).toEqual(["paid", "awaiting_evidence"]);
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
