import { seedUsers } from "@escrow-lab/db";
import { ApprovalQueueResponse } from "@escrow-lab/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openTestDatabase } from "./database.ts";
import {
  ALICE,
  CAROL,
  ERIN,
  approved,
  evidenceSent,
  failures,
  funded,
  startHarness,
  type Harness,
  type HarnessOptions,
  type TestDatabase,
} from "./harness.ts";

const TOTAL = 100_000;
const LOST_REPLY: HarnessOptions = { chain: [{ kind: "ok" }, { kind: "lose_reply" }] };

describe("Refund a funded Deal", () => {
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

  async function start(options: HarnessOptions = {}) {
    const h = await startHarness(database, options);
    harnesses.push(h);
    return h;
  }

  const refund = (h: Harness, dealId: string, userId = ERIN) =>
    h.call(userId, "POST", `/api/deals/${dealId}/refund`);

  async function queueItems(h: Harness, dealId: string) {
    const found: ApprovalQueueResponse["items"] = [];
    for (let offset = 0; ; offset += 100) {
      const page = ApprovalQueueResponse.parse(
        (await h.call(ERIN, "GET", `/api/approvals?limit=100&offset=${String(offset)}`)).json(),
      );
      found.push(...page.items.filter((item) => item.dealId === dealId));
      if (offset + 100 >= page.total) return found;
    }
  }

  it("returns the locked money to the Buyer, writes one refund and refunds the Deal", async () => {
    const h = await start();
    const { dealId } = await funded(h);

    const response = await refund(h, dealId);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ dealId, state: "refunded" });
    const after = await h.snapshot(dealId);
    expect(after.deal[0]?.state).toBe("refunded");
    expect(after.ledger.filter((e) => e.kind === "refund").map((e) => e.amountMinor)).toEqual([
      TOTAL,
    ]);
    expect(after.audit.map((e) => e.action)).toContain("refund_deal");
    expect(after.calls.filter((c) => c.method === "refund")).toMatchObject([
      { party: ALICE, amount: TOTAL },
    ]);
  });

  it("refuses a Deal that has a Payout in any state", async () => {
    for (const options of [
      {},
      { chain: [{ kind: "ok" }, { kind: "fail", failure: "timeout" }] },
    ] as HarnessOptions[]) {
      const h = await start(options);
      const { dealId } = await approved(h);
      const before = await h.snapshot(dealId);

      const response = await refund(h, dealId);

      expect(response.statusCode).toBe(409);
      expect(await h.snapshot(dealId)).toEqual(before);
    }
  });

  it("refuses a Deal that is not funded, and a Deal that is already refunded", async () => {
    const h = await start();
    const draft = await h.createDeal();
    const { dealId } = await funded(h);
    await h.step(refund(h, dealId));
    for (const id of [draft.dealId, dealId]) {
      const before = await h.snapshot(id);

      const response = await refund(h, id);

      expect(response.statusCode).toBe(409);
      expect(await h.snapshot(id)).toEqual(before);
    }
  });

  it("answers 403 to a Buyer and a Seller and changes nothing", async () => {
    const h = await start();
    const { dealId } = await funded(h);
    const before = await h.snapshot(dealId);

    expect((await refund(h, dealId, ALICE)).statusCode).toBe(403);
    expect((await refund(h, dealId, CAROL)).statusCode).toBe(403);

    expect(await h.snapshot(dealId)).toEqual(before);
  });

  it("answers 404 for a Deal that does not exist", async () => {
    const h = await start();
    const response = await refund(h, "00000000-0000-4000-8000-0000000000ff");
    expect(response.statusCode).toBe(404);
  });

  it("keeps the Deal refunding after a lost reply and refunds once with the same key", async () => {
    const h = await start(LOST_REPLY);
    const { dealId } = await funded(h);

    const response = await refund(h, dealId);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ dealId, state: "refunding" });
    expect((await h.snapshot(dealId)).ledger.filter((e) => e.kind === "refund")).toEqual([]);

    await h.runJob(dealId);

    const after = await h.snapshot(dealId);
    expect(after.deal[0]?.state).toBe("refunded");
    expect(after.ledger.filter((e) => e.kind === "refund")).toHaveLength(1);
    const keys = after.calls.filter((c) => c.method === "refund").map((c) => c.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(after.audit.filter((e) => e.action === "refund_deal")).toHaveLength(1);
  });

  it("sets refund_failed after 5 failed tries and shows the Deal in the queue", async () => {
    const h = await start({ chain: [{ kind: "ok" }, ...failures(10)] });
    const { dealId } = await funded(h);
    await h.step(refund(h, dealId));

    await h.runJob(dealId, 4);
    expect((await h.snapshot(dealId)).deal[0]?.state).toBe("refunding");
    await h.runJob(dealId);

    const after = await h.snapshot(dealId);
    expect(after.deal[0]?.state).toBe("refund_failed");
    expect(after.ledger.filter((e) => e.kind === "refund")).toEqual([]);
    expect(await queueItems(h, dealId)).toMatchObject([
      { kind: "refund_failed", dealTitle: "Logo design", totalMinor: TOTAL },
    ]);
  });

  it("lists a funded Deal with no Payout as refundable, and not one with a Payout", async () => {
    const h = await start();
    const open = await funded(h);
    const paid = await approved(h);

    expect(await queueItems(h, open.dealId)).toMatchObject([
      { kind: "refundable", id: open.dealId, totalMinor: TOTAL },
    ]);
    expect((await queueItems(h, paid.dealId)).map((i) => i.kind)).not.toContain("refundable");
  });

  it("refuses evidence, accept and reject on a Deal that is not funded", async () => {
    const h = await start();
    const awaiting = await funded(h);
    const sent = await evidenceSent(h);
    await h.step(refund(h, awaiting.dealId));
    await h.step(refund(h, sent.dealId));
    const first = await h.snapshot(awaiting.dealId);
    const second = await h.snapshot(sent.dealId);

    expect((await h.sendEvidence(awaiting.first)).statusCode).toBe(409);
    expect((await h.accept(sent.first)).statusCode).toBe(409);
    expect((await h.reject(sent.first)).statusCode).toBe(409);

    expect(await h.snapshot(awaiting.dealId)).toEqual(first);
    expect(await h.snapshot(sent.dealId)).toEqual(second);
  });
});
