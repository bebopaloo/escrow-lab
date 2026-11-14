import { SEED_USERS, schema, seedUsers } from "@escrow-lab/db";
import { SessionResponse } from "@escrow-lab/shared";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { openTestDatabase, testConfig } from "./database.ts";

const ALICE = SEED_USERS[0]?.id ?? "";
const CAROL = SEED_USERS[2]?.id ?? "";

describe("POST /deals safety", () => {
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

  function cookieOf(response: { headers: Record<string, unknown> }): string {
    const header = response.headers["set-cookie"];
    const lines = Array.isArray(header) ? header : typeof header === "string" ? [header] : [];
    return lines.map((line) => String(line).split(";")[0]).join("; ");
  }

  async function signInBuyer() {
    const visit = await app.inject({ method: "GET", url: "/api/session" });
    const token = SessionResponse.parse(visit.json()).csrfToken;
    const response = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { cookie: cookieOf(visit), "x-csrf-token": token },
      payload: { userId: ALICE },
    });
    return {
      id: ALICE,
      cookie: cookieOf(response),
      csrfToken: SessionResponse.parse(response.json()).csrfToken,
    };
  }

  const payload = {
    sellerId: CAROL,
    title: "Safety test Deal",
    totalMinor: 100,
    milestones: [{ title: "All", amountMinor: 100 }],
  };

  function post(who: { cookie: string; csrfToken: string }, title = payload.title) {
    return app.inject({
      method: "POST",
      url: "/api/deals",
      headers: { cookie: who.cookie, "x-csrf-token": who.csrfToken },
      payload: { ...payload, title },
    });
  }

  it("saves no Deal and no Milestone when the audit event cannot be written", async () => {
    const buyer = await signInBuyer();
    const title = `Refused audit ${randomUUID()}`;
    const suffix = randomUUID().replaceAll("-", "");
    const fn = sql.identifier(`refuse_audit_${suffix}`);
    const trg = sql.identifier(`refuse_audit_trg_${suffix}`);
    await database.db.execute(sql`
      create function ${fn}() returns trigger language plpgsql as $$
      begin
        if new.action = 'create_deal'
          and exists (select 1 from deals where id = new.deal_id and title like 'Refused audit %') then
          raise exception 'audit refused';
        end if;
        return new;
      end $$`);
    await database.db.execute(
      sql`create trigger ${trg} before insert on audit_events for each row execute function ${fn}()`,
    );
    try {
      const response = await post(buyer, title);
      expect(response.statusCode).toBe(500);
      const deals = await database.db
        .select({ id: schema.deals.id })
        .from(schema.deals)
        .where(eq(schema.deals.title, title));
      expect(deals).toEqual([]);
    } finally {
      await database.db.execute(sql`drop trigger ${trg} on audit_events`);
      await database.db.execute(sql`drop function ${fn}()`);
    }
  });

  it("answers 429 over the limit and creates no further Deal", async () => {
    const buyer = await signInBuyer();
    const title = `Rate limited ${randomUUID()}`;
    let limited = 0;
    for (let i = 0; i < 40; i += 1) {
      if ((await post(buyer, title)).statusCode === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
    const deals = await database.db
      .select({ id: schema.deals.id })
      .from(schema.deals)
      .where(eq(schema.deals.title, title));
    expect(deals.length).toBe(40 - limited);
    expect(deals.length).toBeLessThanOrEqual(30);
  });
});
