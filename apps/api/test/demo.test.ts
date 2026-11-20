import { schema, seedUsers } from "@escrow-lab/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeChain } from "../src/adapters/chain/index.ts";
import { createDemoLoop, startDemoLoopWhenOn } from "../src/demo.ts";
import { ALICE, ERIN, startHarness, type TestDatabase } from "./harness.ts";
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
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await database.close();
  });

  async function acceptedMilestone(express = false) {
    const h = await startHarness(database);
    const { dealId, first, second } = await h.createDeal({ express });
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

  it("pays an accepted Milestone of an express Deal with the seeded Approver as approver", async () => {
    const { first } = await acceptedMilestone(true);
    const [queued] = await payoutsOf(first);
    expect(queued?.approvedBy).toBeNull();
    await loop().runOnce();
    const payouts = await payoutsOf(first);
    expect(payouts).toHaveLength(1);
    expect(payouts[0]?.approvedBy).toBe(ERIN);
    expect(payouts[0]?.state).toBe("confirmed");
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

  it("warns and pays nothing when the named user exists but is not an Approver", async () => {
    const { first } = await acceptedMilestone();
    await createDemoLoop({
      db: database.db,
      chain: createFakeChain(),
      log: { warn: (message) => warnings.push(message) },
      approverId: ALICE,
    }).runOnce();
    expect(warnings).toHaveLength(1);
    expect(await payoutsOf(first)).toEqual([]);
    expect(await milestoneState(first)).toBe("accepted");
  });

  it("pays on a timer after start, and stops after stop", async () => {
    const { first } = await acceptedMilestone();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const demo = createDemoLoop({
      db: database.db,
      chain: createFakeChain(),
      log: { warn: (message) => warnings.push(message) },
      intervalMs: 1000,
    });
    demo.start();
    demo.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () => {
      expect(await milestoneState(first)).toBe("paid");
    });
    demo.stop();
    const later = await acceptedMilestone();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await payoutsOf(later.first)).toEqual([]);
  });

  it("passes the error of a timed run that throws to onError, and the next run still happens", async () => {
    const { first } = await acceptedMilestone();
    // The chain throws one time, for the doomed Milestone only. The loop has claimed its Payout
    // before the throw, so the Payout stays `pending` and the loop does not claim it again. The
    // throw must not hit `first`. Other tests leave accepted Milestones in the shared database,
    // so the order of the loop is not known: the doomed Milestone makes the throw sure.
    const { first: doomed } = await acceptedMilestone();
    const boom = new Error("chain down");
    const real = createFakeChain();
    let fail = true;
    const chain = {
      lock: real.lock.bind(real),
      transfer: async (seller: string, amount: number, key: string) => {
        const [claimed] = await database.db
          .select({ milestoneId: schema.payouts.milestoneId })
          .from(schema.payouts)
          .where(eq(schema.payouts.idempotencyKey, key));
        if (fail && claimed?.milestoneId === doomed) {
          fail = false;
          throw boom;
        }
        return real.transfer(seller, amount, key);
      },
    };
    const errors: unknown[] = [];
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const demo = createDemoLoop({
      db: database.db,
      chain,
      log: { warn: (message) => warnings.push(message) },
      intervalMs: 1000,
      onError: (error) => errors.push(error),
    });
    demo.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => {
      expect(errors).toEqual([boom]);
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () => {
      expect(await milestoneState(first)).toBe("paid");
    });
    demo.stop();
    expect(errors).toEqual([boom]);
  });

  it("[CTRL-PAY-03] does not start the demo loop when the setting is off", () => {
    vi.useFakeTimers();
    const started = startDemoLoopWhenOn(false, {
      db: database.db,
      chain: createFakeChain(),
      log: { warn: (message) => warnings.push(message) },
    });
    expect(started).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts the demo loop when the setting is on", () => {
    vi.useFakeTimers();
    const started = startDemoLoopWhenOn(true, {
      db: database.db,
      chain: createFakeChain(),
      log: { warn: (message) => warnings.push(message) },
    });
    expect(started).toBeDefined();
    expect(vi.getTimerCount()).toBe(1);
    started?.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
