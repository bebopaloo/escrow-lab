import { schema, seedUsers } from "@escrow-lab/db";
import { DealListResponse } from "@escrow-lab/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openTestDatabase } from "./database.ts";
import {
  ALICE,
  BOB,
  CAROL,
  ERIN,
  funded,
  signIn,
  startHarness,
  type Harness,
  type TestDatabase,
} from "./harness.ts";

describe("cancel a draft Deal", () => {
  let database: TestDatabase;
  const harnesses: Harness[] = [];

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
  });

  afterEach(async () => {
    for (const h of harnesses.splice(0)) await h.close();
  });

  afterAll(async () => {
    await database.close();
  });

  async function start() {
    const h = await startHarness(database);
    harnesses.push(h);
    return h;
  }

  const cancel = (h: Harness, userId: string, dealId: string) =>
    h.call(userId, "POST", `/api/deals/${dealId}/cancel`);
  const stateOf = async (dealId: string) =>
    (await database.db.select().from(schema.deals).where(eq(schema.deals.id, dealId)))[0]?.state;
  const actionsOf = async (dealId: string) =>
    (
      await database.db
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.dealId, dealId))
    ).map((event) => event.action);

  it("cancels a draft Deal for its Buyer and writes the cancel_deal audit event", async () => {
    const h = await start();
    const { dealId } = await h.createDeal();

    const response = await cancel(h, ALICE, dealId);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: dealId, state: "cancelled" });
    expect(await stateOf(dealId)).toBe("cancelled");
    expect(await actionsOf(dealId)).toEqual(["create_deal", "cancel_deal"]);
  });

  it("removes a cancelled Deal from the default Deal list", async () => {
    const h = await start();
    const { dealId } = await h.createDeal();
    const before = DealListResponse.parse((await h.call(ALICE, "GET", "/api/deals")).json());
    expect(before.deals.map((d) => d.id)).toContain(dealId);

    await cancel(h, ALICE, dealId);

    const after = DealListResponse.parse((await h.call(ALICE, "GET", "/api/deals")).json());
    expect(after.deals.map((d) => d.id)).not.toContain(dealId);
    expect(after.total).toBe(before.total - 1);
  });

  it("refuses to fund a cancelled Deal and calls no partner", async () => {
    const h = await start();
    const { dealId } = await h.createDeal();
    await cancel(h, ALICE, dealId);

    const response = await h.fund(dealId);

    expect(response.statusCode).toBe(409);
    expect(await stateOf(dealId)).toBe("cancelled");
    expect(h.calls).toEqual([]);
  });

  it("returns 409 and changes nothing for a Deal that is not a draft", async () => {
    const h = await start();
    const { dealId } = await funded(h);
    const before = await h.snapshot(dealId);

    const response = await cancel(h, ALICE, dealId);

    expect(response.statusCode).toBe(409);
    expect(await h.snapshot(dealId)).toEqual(before);
  });

  it("returns 409 for a Deal that is already cancelled and writes no second event", async () => {
    const h = await start();
    const { dealId } = await h.createDeal();
    await cancel(h, ALICE, dealId);

    expect((await cancel(h, ALICE, dealId)).statusCode).toBe(409);
    expect((await actionsOf(dealId)).filter((a) => a === "cancel_deal")).toHaveLength(1);
  });

  it("lets only one of a fund request and a cancel request win", async () => {
    const h = await start();
    const { dealId } = await h.createDeal();

    const [fundResponse, cancelResponse] = await Promise.all([
      h.fund(dealId),
      cancel(h, ALICE, dealId),
    ]);

    const codes = [fundResponse.statusCode, cancelResponse.statusCode];
    expect(codes.filter((code) => code === 409)).toHaveLength(codes.includes(200) ? 1 : 0);
    const state = await stateOf(dealId);
    if (cancelResponse.statusCode === 200) {
      expect(state).toBe("cancelled");
      expect(fundResponse.statusCode).toBe(409);
    } else {
      expect(cancelResponse.statusCode).toBe(409);
      expect(state).toBe("funded");
    }
  });

  it("answers 404 to another Buyer's Deal and 403 to a Seller or an Approver", async () => {
    const h = await start();
    const { dealId } = await h.createDeal();

    expect((await cancel(h, CAROL, dealId)).statusCode).toBe(403);
    expect((await cancel(h, ERIN, dealId)).statusCode).toBe(403);
    expect((await cancel(h, ALICE, "00000000-0000-4000-8000-0000000000ff")).statusCode).toBe(404);
    expect((await cancel(h, BOB, dealId)).statusCode).toBe(404);
    expect(await stateOf(dealId)).toBe("draft");
  });

  it("refuses a cancel request without the CSRF token and leaves the Deal a draft", async () => {
    const h = await start();
    const { dealId } = await h.createDeal();
    const { cookie } = await signIn(h.app, ALICE);

    const response = await h.app.inject({
      method: "POST",
      url: `/api/deals/${dealId}/cancel`,
      headers: { cookie },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(await stateOf(dealId)).toBe("draft");
    expect(await actionsOf(dealId)).toEqual(["create_deal"]);
  });
});
