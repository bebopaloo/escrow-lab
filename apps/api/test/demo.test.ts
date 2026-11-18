import { schema, seedUsers } from "@escrow-lab/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeChain } from "../src/adapters/chain/index.ts";
import { createDemoLoop } from "../src/demo.ts";
import { ERIN, startHarness, type TestDatabase } from "./harness.ts";
import { openTestDatabase } from "./database.ts";

describe("Demo mode loop", () => {
  let database: TestDatabase;
  let warnings: string[];
  const loop = () =>
    createDemoLoop({
      db: database.db,
      chain: createFakeChain(),
      log: { warn: (message) => warnings.push(message) },
    });

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
  });
  beforeEach(() => {
    warnings = [];
  });
  afterAll(async () => {
    await database.close();
  });

  async function acceptedMilestone() {
    const h = await startHarness(database);
    const { dealId, first, second } = await h.createDeal();
    await h.step(h.fund(dealId));
    await h.runJob(dealId);
    await h.step(h.sendEvidence(first));
    await h.step(h.accept(first));
    return { dealId, first, second };
  }
  const payoutsOf = (milestoneId: string) =>
    database.db.select().from(schema.payouts).where(eq(schema.payouts.milestoneId, milestoneId));
  const milestoneState = async (id: string) =>
    (await database.db.select().from(schema.milestones).where(eq(schema.milestones.id, id)))[0]
      ?.state;

  it("pays an accepted Milestone with the seeded Approver as approver", async () => {
    const { first } = await acceptedMilestone();
    await loop().runOnce();
    const [payout] = await payoutsOf(first);
    expect(payout?.approvedBy).toBe(ERIN);
    expect(payout?.state).toBe("confirmed");
    expect(await milestoneState(first)).toBe("paid");
  });

  it("does not pay a Milestone that is not accepted", async () => {
    const { second } = await acceptedMilestone();
    await loop().runOnce();
    expect(await payoutsOf(second)).toEqual([]);
  });

  it("writes the approve_payout audit event for the seeded Approver", async () => {
    const { dealId } = await acceptedMilestone();
    await loop().runOnce();
    const events = await database.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.dealId, dealId));
    expect(events.filter((e) => e.action === "approve_payout").map((e) => e.userId)).toEqual([
      ERIN,
    ]);
  });

  it("pays a Milestone one time only", async () => {
    const { first } = await acceptedMilestone();
    const demo = loop();
    await demo.runOnce();
    await demo.runOnce();
    expect(await payoutsOf(first)).toHaveLength(1);
  });

  it("warns and pays nothing when the seeded Approver is missing", async () => {
    const { first } = await acceptedMilestone();
    await createDemoLoop({
      db: database.db,
      chain: createFakeChain(),
      log: { warn: (message) => warnings.push(message) },
      approverId: "00000000-0000-4000-8000-0000000000ff",
    }).runOnce();
    expect(warnings).toHaveLength(1);
    expect(await payoutsOf(first)).toEqual([]);
  });
});
