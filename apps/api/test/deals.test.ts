import { SEED_USERS, schema, seedUsers } from "@escrow-lab/db";
import { DealListResponse, DealResponse, ErrorResponse } from "@escrow-lab/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { openTestDatabase, testConfig } from "./database.ts";
import { signIn as signInOn, type Session } from "./harness.ts";

const ALICE = SEED_USERS[0]?.id ?? "";
const BOB = SEED_USERS[1]?.id ?? "";
const CAROL = SEED_USERS[2]?.id ?? "";
const DAN = SEED_USERS[3]?.id ?? "";
const ERIN = SEED_USERS[4]?.id ?? "";

describe("deals", () => {
  let database: Awaited<ReturnType<typeof openTestDatabase>>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
    app = await buildApp({ config: testConfig, db: database.db, logger: false });
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  // Sign-in is rate limited, so each user signs in once.
  const sessions = new Map<string, { cookie: string; csrfToken: string }>();
  async function signIn(userId: string): Promise<Session> {
    const known = sessions.get(userId);
    if (known !== undefined) return known;
    const session = await signInOn(app, userId);
    sessions.set(userId, session);
    return session;
  }

  async function createDeal(
    who: { cookie: string; csrfToken: string },
    payload: unknown,
    withCsrf = true,
  ) {
    return app.inject({
      method: "POST",
      url: "/api/deals",
      headers: { cookie: who.cookie, ...(withCsrf ? { "x-csrf-token": who.csrfToken } : {}) },
      payload: payload as object,
    });
  }

  const good = {
    sellerId: CAROL,
    title: "Logo design",
    totalMinor: 100_000,
    milestones: [
      { title: "Draft", amountMinor: 40_000 },
      { title: "Final", amountMinor: 60_000 },
    ],
  };

  it("creates a draft Deal with pending Milestones, and the Seller can see it", async () => {
    const buyer = await signIn(ALICE);
    const response = await createDeal(buyer, good);
    expect(response.statusCode).toBe(201);
    const deal = DealResponse.parse(response.json());
    expect(deal.state).toBe("draft");
    expect(deal.currency).toBe("GBP");
    expect(deal.milestones.map((m) => [m.position, m.amountMinor, m.state])).toEqual([
      [1, 40_000, "pending"],
      [2, 60_000, "pending"],
    ]);

    const seller = await signIn(CAROL);
    const seen = await app.inject({
      method: "GET",
      url: `/api/deals/${deal.id}`,
      headers: { cookie: seller.cookie },
    });
    expect(seen.statusCode).toBe(200);
    expect(DealResponse.parse(seen.json()).id).toBe(deal.id);

    const events = await database.db
      .select()
      .from(schema.auditEvents)
      .where(
        and(eq(schema.auditEvents.dealId, deal.id), eq(schema.auditEvents.action, "create_deal")),
      );
    expect(events.map((e) => e.userId)).toEqual([ALICE]);
  });

  it("refuses Milestones that do not add up to the total", async () => {
    const buyer = await signIn(ALICE);
    const response = await createDeal(buyer, {
      ...good,
      milestones: [
        { title: "Draft", amountMinor: 40_000 },
        { title: "Final", amountMinor: 50_000 },
      ],
    });
    expect(response.statusCode).toBe(400);
    expect(ErrorResponse.parse(response.json()).error).toBe(
      "The Milestones must add up to the total.",
    );
  });

  it.each([
    ["no Milestones", { ...good, milestones: [] }],
    [
      "11 Milestones",
      {
        ...good,
        totalMinor: 1100,
        milestones: Array.from({ length: 11 }, () => ({ title: "M", amountMinor: 100 })),
      },
    ],
    [
      "a Milestone of 0",
      {
        ...good,
        totalMinor: 100,
        milestones: [
          { title: "A", amountMinor: 0 },
          { title: "B", amountMinor: 100 },
        ],
      },
    ],
    [
      "a total above 1,000,000 pounds",
      { ...good, totalMinor: 100_000_100, milestones: [{ title: "A", amountMinor: 100_000_100 }] },
    ],
    [
      "a fractional amount",
      { ...good, totalMinor: 1.5, milestones: [{ title: "A", amountMinor: 1.5 }] },
    ],
    ["an unknown field", { ...good, state: "funded" }],
  ])("refuses %s", async (_name, payload) => {
    const buyer = await signIn(ALICE);
    const response = await createDeal(buyer, payload);
    expect(response.statusCode).toBe(400);
  });

  it("accepts 10 Milestones of 1p and a total of 1,000,000 pounds", async () => {
    const buyer = await signIn(ALICE);
    const ten = await createDeal(buyer, {
      ...good,
      totalMinor: 10,
      milestones: Array.from({ length: 10 }, () => ({ title: "M", amountMinor: 1 })),
    });
    expect(ten.statusCode).toBe(201);
    const big = await createDeal(buyer, {
      ...good,
      totalMinor: 100_000_000,
      milestones: [{ title: "A", amountMinor: 100_000_000 }],
    });
    expect(big.statusCode).toBe(201);
  });

  it.each([
    ["a Buyer", BOB],
    ["an Approver", ERIN],
    ["an unknown user", "00000000-0000-4000-8000-0000000000ff"],
  ])("refuses %s as the Seller", async (_name, sellerId) => {
    const buyer = await signIn(ALICE);
    const response = await createDeal(buyer, { ...good, sellerId });
    expect(response.statusCode).toBe(400);
    expect(ErrorResponse.parse(response.json()).error).toBe(
      "The Seller must be a user with the Seller role.",
    );
  });

  it("refuses a Seller and an Approver as the creator", async () => {
    expect((await createDeal(await signIn(CAROL), good)).statusCode).toBe(403);
    expect((await createDeal(await signIn(ERIN), good)).statusCode).toBe(403);
  });

  it("refuses a visitor and a request with no CSRF token", async () => {
    const visit = await app.inject({ method: "GET", url: "/api/session" });
    const anon = await app.inject({ method: "POST", url: "/api/deals", payload: good });
    expect(anon.statusCode).toBe(401);
    expect(visit.statusCode).toBe(200);
    const buyer = await signIn(ALICE);
    expect((await createDeal(buyer, good, false)).statusCode).toBe(403);
  });

  it("shows a user only their own Deals, and answers 404 for another Deal", async () => {
    const alice = await signIn(ALICE);
    const created = DealResponse.parse(
      (await createDeal(alice, { ...good, title: "Mine" })).json(),
    );

    const list = async (who: { cookie: string }, query = "") =>
      app.inject({ method: "GET", url: `/api/deals${query}`, headers: { cookie: who.cookie } });

    const aliceList = DealListResponse.parse((await list(alice, "?limit=100")).json());
    expect(aliceList.deals.map((d) => d.id)).toContain(created.id);

    const bob = await signIn(BOB);
    const bobList = DealListResponse.parse((await list(bob, "?limit=100")).json());
    expect(bobList.deals.map((d) => d.id)).not.toContain(created.id);
    const dan = await signIn(DAN);
    const danList = DealListResponse.parse((await list(dan, "?limit=100")).json());
    expect(danList.deals.map((d) => d.id)).not.toContain(created.id);

    for (const other of [bob, dan]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/deals/${created.id}`,
        headers: { cookie: other.cookie },
      });
      expect(response.statusCode).toBe(404);
    }
    const approver = await signIn(ERIN);
    expect((await list(approver)).statusCode).toBe(403);
  });

  it("paginates the list and caps the page size", async () => {
    const buyer = await signIn(ALICE);
    for (let i = 0; i < 3; i += 1) await createDeal(buyer, good);
    const page = await app.inject({
      method: "GET",
      url: "/api/deals?limit=2&offset=0",
      headers: { cookie: buyer.cookie },
    });
    const body = DealListResponse.parse(page.json());
    expect(body.deals).toHaveLength(2);
    expect(body.total).toBeGreaterThanOrEqual(3);
    expect(body.limit).toBe(2);
    const tooBig = await app.inject({
      method: "GET",
      url: "/api/deals?limit=101",
      headers: { cookie: buyer.cookie },
    });
    expect(tooBig.statusCode).toBe(400);
    const unknown = await app.inject({
      method: "GET",
      url: "/api/deals?foo=1",
      headers: { cookie: buyer.cookie },
    });
    expect(unknown.statusCode).toBe(400);
  });
});
