import { randomUUID } from "node:crypto";
import { SEED_USERS, schema, seedUsers } from "@escrow-lab/db";
import { MismatchListResponse, SessionResponse } from "@escrow-lab/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { openTestDatabase, testConfig } from "./database.ts";

const ALICE = SEED_USERS[0]?.id ?? "";
const CAROL = SEED_USERS[2]?.id ?? "";
const ERIN = SEED_USERS[4]?.id ?? "";

type Database = Awaited<ReturnType<typeof openTestDatabase>>;

function cookieOf(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const lines = Array.isArray(header) ? header : typeof header === "string" ? [header] : [];
  return lines.map((line) => String(line).split(";")[0]).join("; ");
}

const HOUR = 3_600_000;

describe("List the mismatches", () => {
  let database: Database;
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

  beforeEach(async () => {
    // Other tests share the database: close every open mismatch so each test sees only its own.
    await database.db.update(schema.mismatches).set({ closedAt: new Date() });
  });

  async function get(userId: string | null, url = "/api/reconciliation/mismatches") {
    if (userId === null) return app.inject({ method: "GET", url });
    const visit = await app.inject({ method: "GET", url: "/api/session" });
    const token = SessionResponse.parse(visit.json()).csrfToken;
    const signedIn = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { cookie: cookieOf(visit), "x-csrf-token": token },
      payload: { userId },
    });
    return app.inject({ method: "GET", url, headers: { cookie: cookieOf(signedIn) } });
  }

  async function mismatch(
    title: string,
    foundAgoMs: number,
    extra: Partial<typeof schema.mismatches.$inferInsert> = {},
  ) {
    const [deal] = await database.db
      .insert(schema.deals)
      .values({ title, buyerId: ALICE, sellerId: CAROL, totalMinor: 100 })
      .returning({ id: schema.deals.id });
    await database.db.insert(schema.mismatches).values({
      kind: "missing_in_ledger",
      dealId: deal?.id ?? "",
      idempotencyKey: randomUUID(),
      chainTxId: `tx-${title}`,
      chainAmountMinor: 100,
      foundAt: new Date(Date.now() - foundAgoMs),
      ...extra,
    });
  }

  it("lists each open mismatch with its fields, oldest first", async () => {
    await mismatch("Newer", HOUR);
    await mismatch("Older", 2 * HOUR, {
      kind: "amount_differs",
      ledgerAmountMinor: 90,
      chainAmountMinor: 100,
    });
    const response = await get(ERIN);
    expect(response.statusCode).toBe(200);
    const body = MismatchListResponse.parse(response.json());
    expect(body.total).toBe(2);
    expect(body.items.map((item) => item.dealTitle)).toEqual(["Older", "Newer"]);
    expect(body.items[0]).toMatchObject({
      kind: "amount_differs",
      chainTxId: "tx-Older",
      ledgerAmountMinor: 90,
      chainAmountMinor: 100,
    });
    expect(new Date(body.items[0]?.foundAt ?? "").getTime()).toBeLessThan(
      new Date(body.items[1]?.foundAt ?? "").getTime(),
    );
  });

  it("does not list a closed mismatch", async () => {
    await mismatch("Open", HOUR);
    await mismatch("Closed", HOUR, { closedAt: new Date() });
    const body = MismatchListResponse.parse((await get(ERIN)).json());
    expect(body.items.map((item) => item.dealTitle)).toEqual(["Open"]);
    expect(body.total).toBe(1);
  });

  it("pages the list and counts the mismatches older than 24 hours", async () => {
    await mismatch("A", 30 * HOUR);
    await mismatch("B", 3 * HOUR);
    await mismatch("C", 2 * HOUR);
    const body = MismatchListResponse.parse(
      (await get(ERIN, "/api/reconciliation/mismatches?limit=1&offset=1")).json(),
    );
    expect(body.items.map((item) => item.dealTitle)).toEqual(["B"]);
    expect(body).toMatchObject({ total: 3, limit: 1, offset: 1, oldCount: 1 });
  });

  it("answers 403 to a Buyer and a Seller, and 401 with no session", async () => {
    await mismatch("Hidden", HOUR);
    expect((await get(ALICE)).statusCode).toBe(403);
    expect((await get(CAROL)).statusCode).toBe(403);
    expect((await get(null)).statusCode).toBe(401);
  });
});
