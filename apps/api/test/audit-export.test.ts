import { SEED_USERS, schema, seedUsers } from "@escrow-lab/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDatabase } from "./database.ts";
import { ALICE, CAROL, ERIN, startHarness, type Harness, type TestDatabase } from "./harness.ts";

const BOB = SEED_USERS[1]?.id ?? "";
const DAN = SEED_USERS[3]?.id ?? "";

describe("GET /api/deals/:id/audit.csv", () => {
  let database: TestDatabase;
  let h: Harness;
  let dealId: string;

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
    h = await startHarness(database);
    const ids = await h.createDeal();
    dealId = ids.dealId;
    await h.step(h.fund(dealId));
  });

  afterAll(async () => {
    await h.close();
    await database.close();
  });

  const csvOf = (userId: string) => h.call(userId, "GET", `/api/deals/${dealId}/audit.csv`);

  it("sends one row for each audit event of the Deal as a CSV download", async () => {
    const response = await csvOf(ALICE);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/csv/);
    expect(response.headers["content-disposition"]).toMatch(/^attachment/);
    const events = await database.db
      .select({ action: schema.auditEvents.action })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.dealId, dealId));
    const rows = response.body.split("\r\n").filter((line) => line !== "");
    expect(rows).toHaveLength(events.length + 1);
    expect(rows[0]).toBe('"Time","User","Action"');
    const actions = rows.slice(1).map((row) => row.split(",")[2]);
    expect(actions.sort()).toEqual(events.map((e) => `"${e.action}"`).sort());
  });

  it("names the current display name of the user", async () => {
    await database.db
      .update(schema.users)
      .set({ displayName: "Alice Renamed" })
      .where(eq(schema.users.id, ALICE));
    try {
      const response = await csvOf(CAROL);
      expect(response.body).toContain('"Alice Renamed","create_deal"');
    } finally {
      const seeded = SEED_USERS.find((user) => user.id === ALICE);
      await database.db
        .update(schema.users)
        .set({ displayName: seeded?.displayName ?? "" })
        .where(eq(schema.users.id, ALICE));
    }
  });

  it("neutralises a display name that starts with a formula character", async () => {
    await database.db
      .update(schema.users)
      .set({ displayName: '=HYPERLINK("x")' })
      .where(eq(schema.users.id, ALICE));
    try {
      const response = await csvOf(ALICE);
      expect(response.body).toContain(`"'=HYPERLINK(""x"")","create_deal"`);
    } finally {
      const seeded = SEED_USERS.find((user) => user.id === ALICE);
      await database.db
        .update(schema.users)
        .set({ displayName: seeded?.displayName ?? "" })
        .where(eq(schema.users.id, ALICE));
    }
  });

  it("answers 404 to a Buyer who is not on the Deal", async () => {
    expect((await csvOf(BOB)).statusCode).toBe(404);
  });

  it("answers 404 to a Seller who is not on the Deal", async () => {
    expect((await csvOf(DAN)).statusCode).toBe(404);
  });

  it("answers 404 to an unknown Deal", async () => {
    const response = await h.call(
      ALICE,
      "GET",
      "/api/deals/00000000-0000-4000-8000-0000000000ff/audit.csv",
    );
    expect(response.statusCode).toBe(404);
  });

  it("answers 403 to an Approver", async () => {
    expect((await csvOf(ERIN)).statusCode).toBe(403);
  });

  it("answers 401 with no session", async () => {
    const response = await h.app.inject({ method: "GET", url: `/api/deals/${dealId}/audit.csv` });
    expect(response.statusCode).toBe(401);
  });
});
