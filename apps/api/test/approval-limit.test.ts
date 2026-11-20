import { randomUUID } from "node:crypto";
import { SEED_USERS, schema, seedUsers } from "@escrow-lab/db";
import { DealResponse } from "@escrow-lab/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { openTestDatabase, testConfig } from "./database.ts";
import { signIn, type Session } from "./harness.ts";

const ALICE = SEED_USERS[0]?.id ?? "";
const CAROL = SEED_USERS[2]?.id ?? "";
const ERIN = SEED_USERS[4]?.id ?? "";
/** The approve limit in `approval/routes.ts`: requests for each minute. */
const APPROVE_LIMIT = 30;

describe("the approve rate limit", () => {
  let database: Awaited<ReturnType<typeof openTestDatabase>>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
    // A new app has its own request counters, so other tests do not use up the limit.
    app = await buildApp({ config: testConfig, db: database.db, logger: false });
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  const post = (who: Session, url: string, payload: object = {}) =>
    app.inject({
      method: "POST",
      url,
      headers: { cookie: who.cookie, "x-csrf-token": who.csrfToken },
      payload,
    });

  it("answers 429 over the limit and creates no new Payout", async () => {
    const alice = await signIn(app, ALICE);
    const carol = await signIn(app, CAROL);
    const erin = await signIn(app, ERIN);
    const created = await post(alice, "/api/deals", {
      sellerId: CAROL,
      title: "Logo design",
      totalMinor: 1000,
      express: false,
      milestones: [{ title: "All", amountMinor: 1000 }],
    });
    const dealId = DealResponse.parse(created.json()).id;
    await post(alice, `/api/deals/${dealId}/fund`);
    const [row] = await database.db
      .select({ id: schema.milestones.id })
      .from(schema.milestones)
      .where(eq(schema.milestones.dealId, dealId));
    const milestoneId = row?.id ?? "";
    await post(carol, `/api/milestones/${milestoneId}/evidence`, { evidenceText: "Done" });
    await post(alice, `/api/milestones/${milestoneId}/accept`);

    // Use up the limit on Milestones that do not exist. Each answer is 404.
    for (let i = 0; i < APPROVE_LIMIT; i += 1) {
      const missing = await post(erin, `/api/milestones/${randomUUID()}/payout`);
      expect(missing.statusCode).toBe(404);
    }

    const limited = await post(erin, `/api/milestones/${milestoneId}/payout`);
    expect(limited.statusCode).toBe(429);
    const payouts = await database.db
      .select({ id: schema.payouts.id })
      .from(schema.payouts)
      .where(eq(schema.payouts.milestoneId, milestoneId));
    expect(payouts).toEqual([]);
    const [after] = await database.db
      .select({ state: schema.milestones.state })
      .from(schema.milestones)
      .where(eq(schema.milestones.id, milestoneId));
    expect(after?.state).toBe("accepted");
  });
});
