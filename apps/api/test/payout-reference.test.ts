import { SEED_USERS, schema, seedUsers } from "@escrow-lab/db";
import { DealResponse } from "@escrow-lab/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openTestDatabase } from "./database.ts";
import {
  ALICE,
  BOB,
  CAROL,
  ERIN,
  accepted,
  approved,
  signIn,
  startHarness,
  type Harness,
  type Session,
  type TestDatabase,
} from "./harness.ts";

const DAN = SEED_USERS[3]?.id ?? "";

describe("the Seller reference of a Payout", () => {
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

  const sessions = new WeakMap<Harness, Map<string, Session>>();
  async function setReference(
    h: Harness,
    userId: string,
    dealId: string,
    milestoneId: string,
    body: unknown,
    withCsrf = true,
  ) {
    const known = sessions.get(h) ?? new Map<string, Session>();
    sessions.set(h, known);
    let who = known.get(userId);
    if (who === undefined) {
      who = await signIn(h.app, userId);
      known.set(userId, who);
    }
    return h.app.inject({
      method: "PUT",
      url: `/api/deals/${dealId}/milestones/${milestoneId}/reference`,
      headers: { cookie: who.cookie, ...(withCsrf ? { "x-csrf-token": who.csrfToken } : {}) },
      payload: body as object,
    });
  }

  async function referenceInDatabase(milestoneId: string) {
    const [row] = await database.db
      .select({ ref: schema.payouts.sellerReference })
      .from(schema.payouts)
      .where(eq(schema.payouts.milestoneId, milestoneId));
    return row?.ref;
  }

  it("lets the Seller set a reference", async () => {
    const h = await start();
    const ids = await approved(h);
    const response = await setReference(h, CAROL, ids.dealId, ids.first, {
      reference: "INV-2041",
    });
    expect(response.statusCode).toBe(200);
    expect(await referenceInDatabase(ids.first)).toBe("INV-2041");
  });

  it("shows the reference next to the Payout to the Buyer and the Seller", async () => {
    const h = await start();
    const ids = await approved(h);
    await setReference(h, CAROL, ids.dealId, ids.first, { reference: "INV-2041" });
    for (const user of [ALICE, CAROL]) {
      const response = await h.call(user, "GET", `/api/deals/${ids.dealId}`);
      const [first, second] = DealResponse.parse(response.json()).milestones;
      expect(first?.payout?.sellerReference).toBe("INV-2041");
      expect(second?.payout).toBeNull();
    }
  });

  it("lets the Seller change the reference, and an empty value clears it", async () => {
    const h = await start();
    const ids = await approved(h);
    await setReference(h, CAROL, ids.dealId, ids.first, { reference: "INV-1" });
    await setReference(h, CAROL, ids.dealId, ids.first, { reference: "INV-2" });
    expect(await referenceInDatabase(ids.first)).toBe("INV-2");
    const cleared = await setReference(h, CAROL, ids.dealId, ids.first, { reference: "  " });
    expect(cleared.statusCode).toBe(200);
    expect(await referenceInDatabase(ids.first)).toBeNull();
  });

  it("accepts 40 characters and refuses 41", async () => {
    const h = await start();
    const ids = await approved(h);
    const long = await setReference(h, CAROL, ids.dealId, ids.first, {
      reference: "x".repeat(41),
    });
    expect(long.statusCode).toBe(400);
    expect(await referenceInDatabase(ids.first)).toBeNull();
    const limit = await setReference(h, CAROL, ids.dealId, ids.first, {
      reference: "x".repeat(40),
    });
    expect(limit.statusCode).toBe(200);
  });

  it("refuses a Buyer, an Approver and another Seller, and changes nothing", async () => {
    const h = await start();
    const ids = await approved(h);
    await setReference(h, CAROL, ids.dealId, ids.first, { reference: "INV-1" });
    for (const user of [ALICE, BOB, ERIN]) {
      const response = await setReference(h, user, ids.dealId, ids.first, { reference: "bad" });
      expect(response.statusCode).toBe(403);
    }
    const other = await setReference(h, DAN, ids.dealId, ids.first, { reference: "bad" });
    expect(other.statusCode).toBe(404);
    expect(await referenceInDatabase(ids.first)).toBe("INV-1");
  });

  it("returns 404 for a Milestone with no Payout, and for a Milestone of another Deal", async () => {
    const h = await start();
    const ids = await accepted(h);
    const none = await setReference(h, CAROL, ids.dealId, ids.first, { reference: "INV-1" });
    expect(none.statusCode).toBe(404);
    const other = await approved(h);
    const mismatch = await setReference(h, CAROL, ids.dealId, other.first, { reference: "INV-1" });
    expect(mismatch.statusCode).toBe(404);
    expect(await referenceInDatabase(other.first)).toBeNull();
  });

  it("needs the CSRF token and a strict body", async () => {
    const h = await start();
    const ids = await approved(h);
    const noToken = await setReference(
      h,
      CAROL,
      ids.dealId,
      ids.first,
      { reference: "INV-1" },
      false,
    );
    expect(noToken.statusCode).toBe(403);
    const extra = await setReference(h, CAROL, ids.dealId, ids.first, {
      reference: "INV-1",
      state: "x",
    });
    expect(extra.statusCode).toBe(400);
    expect(await referenceInDatabase(ids.first)).toBeNull();
  });
});
