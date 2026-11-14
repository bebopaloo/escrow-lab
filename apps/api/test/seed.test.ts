import { runSeed } from "@escrow-lab/db/seed";
import { SEED_USERS, schema, seedUsers } from "@escrow-lab/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDatabase, TEST_DATABASE_URL } from "./database.ts";

describe("seed data", () => {
  let database: Awaited<ReturnType<typeof openTestDatabase>>;

  beforeAll(async () => {
    database = await openTestDatabase();
  });

  afterAll(async () => {
    await database.close();
  });

  it("writes two Buyers, two Sellers and two Approvers, once", async () => {
    await seedUsers(database.db);
    await seedUsers(database.db);
    const rows = await database.db.select().from(schema.users);
    expect(rows).toHaveLength(6);
    for (const role of ["buyer", "seller", "approver"] as const) {
      expect(rows.filter((row) => row.role === role)).toHaveLength(2);
    }
    expect(rows.map((row) => row.id).sort()).toEqual(SEED_USERS.map((user) => user.id).sort());
  });

  it("keeps audit events append-only", async () => {
    await seedUsers(database.db);
    const userId = SEED_USERS[0]?.id ?? "";
    const [event] = await database.db
      .insert(schema.auditEvents)
      .values({ userId, action: "sign_in" })
      .returning();
    expect(event?.id).toBeDefined();
    await expect(
      database.db.execute(sql`update audit_events set action = 'x' where id = ${event?.id ?? ""}`),
    ).rejects.toThrow();
    await expect(
      database.db.execute(sql`delete from audit_events where id = ${event?.id ?? ""}`),
    ).rejects.toThrow();
  });

  it("runSeed writes the users and can run twice", async () => {
    await runSeed(TEST_DATABASE_URL);
    await runSeed(TEST_DATABASE_URL);
    const rows = await database.db.select().from(schema.users);
    expect(rows).toHaveLength(6);
  });
});
