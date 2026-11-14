import { SEED_USERS, schema, seedUsers } from "@escrow-lab/db";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordAuditEvent } from "../src/modules/audit/index.ts";
import { openTestDatabase } from "./database.ts";

describe("recordAuditEvent", () => {
  let database: Awaited<ReturnType<typeof openTestDatabase>>;

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
  });

  afterAll(async () => {
    await database.close();
  });

  it("writes one event with the user, the action and the time", async () => {
    // Other test files write only `sign_in`, so this action keeps the count exact.
    const userId = SEED_USERS[5]?.id ?? "";
    const action = "funding_confirmed";
    const where = and(eq(schema.auditEvents.userId, userId), eq(schema.auditEvents.action, action));
    const before = await database.db.select().from(schema.auditEvents).where(where);
    await recordAuditEvent(database.db, { userId, action });
    const after = await database.db.select().from(schema.auditEvents).where(where);
    expect(after.length - before.length).toBe(1);
    const latest = after.at(-1);
    expect(latest?.dealId).toBeNull();
    expect(Date.now() - (latest?.createdAt.getTime() ?? 0)).toBeLessThan(60_000);
  });

  it("rejects an unknown user", async () => {
    await expect(
      recordAuditEvent(database.db, { userId: randomUUID(), action: "sign_in" }),
    ).rejects.toThrow();
  });
});
