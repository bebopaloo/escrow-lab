import { SEED_USERS, schema, seedUsers } from "@escrow-lab/db";
import { DealResponse, SessionUser, UsersResponse } from "@escrow-lab/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { openTestDatabase, testConfig } from "./database.ts";
import { ALICE, CAROL, signIn } from "./harness.ts";

describe("PATCH /api/session/user", () => {
  let database: Awaited<ReturnType<typeof openTestDatabase>>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
    app = await buildApp({ config: testConfig, db: database.db, logger: false });
  });

  let before = 0;

  beforeEach(async () => {
    before = await auditCount(ALICE);
  });

  afterEach(async () => {
    // Other test files read the seed names.
    for (const seed of SEED_USERS) {
      await database.db
        .update(schema.users)
        .set({ displayName: seed.displayName })
        .where(eq(schema.users.id, seed.id));
    }
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function rename(userId: string, payload: unknown) {
    const session = await signIn(app, userId);
    return app.inject({
      method: "PATCH",
      url: "/api/session/user",
      headers: { cookie: session.cookie, "x-csrf-token": session.csrfToken },
      payload: payload as object,
    });
  }

  async function nameOf(userId: string) {
    const [row] = await database.db
      .select({ name: schema.users.displayName })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    return row?.name;
  }

  function auditCount(userId: string) {
    return database.db
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.userId, userId),
          eq(schema.auditEvents.action, "change_display_name"),
        ),
      )
      .then((rows) => rows.length);
  }

  it("changes the name and trims it", async () => {
    const response = await rename(ALICE, { displayName: "  Alice Builder  " });
    expect(response.statusCode).toBe(200);
    expect(SessionUser.parse(response.json()).displayName).toBe("Alice Builder");
    expect(await nameOf(ALICE)).toBe("Alice Builder");
  });

  it("accepts a name of 1 and of 60 characters", async () => {
    expect((await rename(ALICE, { displayName: "A" })).statusCode).toBe(200);
    const sixty = "B".repeat(60);
    expect((await rename(ALICE, { displayName: sixty })).statusCode).toBe(200);
    expect(await nameOf(ALICE)).toBe(sixty);
  });

  it.each([
    ["an empty name", { displayName: "" }],
    ["a name of only spaces", { displayName: "   \t " }],
    ["a name over 60 characters", { displayName: "C".repeat(61) }],
    ["a name that is not text", { displayName: 7 }],
    ["an extra field", { displayName: "Fine Name", role: "approver" }],
    ["no name", {}],
  ])("refuses %s and changes nothing", async (_label, payload) => {
    const response = await rename(ALICE, payload);
    expect(response.statusCode).toBe(400);
    expect(await nameOf(ALICE)).toBe("Alice Buyer");
    expect(await auditCount(ALICE)).toBe(before);
  });

  it("refuses the name of another user, whatever its case or spaces", async () => {
    const response = await rename(ALICE, { displayName: "  carol SELLER " });
    expect(response.statusCode).toBe(409);
    expect(await nameOf(ALICE)).toBe("Alice Buyer");
  });

  it("gives a name that two users ask for at the same time to one of them", async () => {
    const answers = await Promise.all([
      rename(ALICE, { displayName: "Shared Name" }),
      rename(CAROL, { displayName: "Shared Name" }),
    ]);
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409]);
  });

  it("lets a user keep their own name", async () => {
    expect((await rename(ALICE, { displayName: "alice buyer" })).statusCode).toBe(200);
    expect(await nameOf(ALICE)).toBe("alice buyer");
  });

  it("writes one change_display_name audit event for a change and none for a refusal", async () => {
    await rename(ALICE, { displayName: "" });
    await rename(ALICE, { displayName: "Carol Seller" });
    expect(await auditCount(ALICE)).toBe(before);
    await rename(ALICE, { displayName: "Alice Two" });
    expect(await auditCount(ALICE)).toBe(before + 1);
  });

  it("refuses a visitor with no session and a request with no CSRF token", async () => {
    const visitor = await app.inject({
      method: "PATCH",
      url: "/api/session/user",
      payload: { displayName: "Nobody" },
    });
    expect(visitor.statusCode).toBe(401);
    const session = await signIn(app, ALICE);
    const noToken = await app.inject({
      method: "PATCH",
      url: "/api/session/user",
      headers: { cookie: session.cookie },
      payload: { displayName: "No Token" },
    });
    expect(noToken.statusCode).toBe(403);
    expect(await nameOf(ALICE)).toBe("Alice Buyer");
  });

  it("shows the new name on the user list and to the other party of a Deal", async () => {
    const buyer = await signIn(app, ALICE);
    const created = await app.inject({
      method: "POST",
      url: "/api/deals",
      headers: { cookie: buyer.cookie, "x-csrf-token": buyer.csrfToken },
      payload: {
        sellerId: CAROL,
        title: "Name check",
        totalMinor: 1000,
        milestones: [{ title: "Only", amountMinor: 1000 }],
      },
    });
    expect(created.statusCode).toBe(201);
    const dealId = DealResponse.parse(created.json()).id;
    await rename(ALICE, { displayName: "Alice Renamed" });
    const seller = await signIn(app, CAROL);
    const read = await app.inject({
      method: "GET",
      url: `/api/deals/${dealId}`,
      headers: { cookie: seller.cookie },
    });
    expect(DealResponse.parse(read.json()).buyerName).toBe("Alice Renamed");
    const users = UsersResponse.parse(
      (await app.inject({ method: "GET", url: "/api/users" })).json(),
    );
    expect(users.users.map((user) => user.displayName)).toContain("Alice Renamed");
  });
});
