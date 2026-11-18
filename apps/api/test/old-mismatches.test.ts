import { randomUUID } from "node:crypto";
import { SEED_USERS, schema, seedUsers } from "@escrow-lab/db";
import { ApprovalQueueResponse, SessionResponse } from "@escrow-lab/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { openTestDatabase, testConfig } from "./database.ts";

const ALICE = SEED_USERS[0]?.id ?? "";
const CAROL = SEED_USERS[2]?.id ?? "";
const ERIN = SEED_USERS[4]?.id ?? "";
const HOUR = 3_600_000;

type Database = Awaited<ReturnType<typeof openTestDatabase>>;

function cookieOf(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const lines = Array.isArray(header) ? header : typeof header === "string" ? [header] : [];
  return lines.map((line) => String(line).split(";")[0]).join("; ");
}

describe("Warn about old mismatches", () => {
  let database: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let dealId: string;

  async function oldMismatches(): Promise<number> {
    const visit = await app.inject({ method: "GET", url: "/api/session" });
    const token = SessionResponse.parse(visit.json()).csrfToken;
    const signedIn = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { cookie: cookieOf(visit), "x-csrf-token": token },
      payload: { userId: ERIN },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/approvals",
      headers: { cookie: cookieOf(signedIn) },
    });
    return ApprovalQueueResponse.parse(response.json()).oldMismatches;
  }

  async function open(ageMs: number, closedAt: Date | null = null) {
    await database.db.insert(schema.mismatches).values({
      kind: "missing_in_ledger",
      dealId,
      idempotencyKey: randomUUID(),
      chainTxId: "tx-old",
      chainAmountMinor: 100,
      foundAt: new Date(Date.now() - ageMs),
      closedAt,
    });
  }

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
    app = await buildApp({ config: testConfig, db: database.db, logger: false });
    const [deal] = await database.db
      .insert(schema.deals)
      .values({ title: "Old", buyerId: ALICE, sellerId: CAROL, totalMinor: 100 })
      .returning({ id: schema.deals.id });
    dealId = deal?.id ?? "";
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("counts only open mismatches found more than 24 hours ago", async () => {
    // Other tests share the database, so the test compares with the count before it adds rows.
    const before = await oldMismatches();
    await open(25 * HOUR);
    await open(48 * HOUR);
    await open(23 * HOUR);
    await open(30 * HOUR, new Date());
    expect(await oldMismatches()).toBe(before + 2);
  });

  it("does not count a mismatch that is newer than 24 hours", async () => {
    const before = await oldMismatches();
    await open(HOUR);
    expect(await oldMismatches()).toBe(before);
  });
});
