import { SEED_USERS, schema } from "@escrow-lab/db";
import { DealResponse, SessionResponse } from "@escrow-lab/shared";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { createFakeChain, type Chain, type Step } from "../src/adapters/chain/index.ts";
import { createFakePaymentRail, type PaymentRail } from "../src/adapters/payment-rail/index.ts";
import { createFundingRetryJob } from "../src/modules/payout/index.ts";
import { openTestDatabase, testConfig } from "./database.ts";

export const ALICE = SEED_USERS[0]?.id ?? "";
export const CAROL = SEED_USERS[2]?.id ?? "";
export const ERIN = SEED_USERS[4]?.id ?? "";

export type TestDatabase = Awaited<ReturnType<typeof openTestDatabase>>;

export interface PartnerCall {
  partner: "chain" | "rail";
  method: string;
  party: string;
  amount: number;
  key: string;
}

export interface HarnessOptions {
  chain?: readonly Step[];
  rail?: readonly Step[];
}

export function cookieOf(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const lines = Array.isArray(header) ? header : typeof header === "string" ? [header] : [];
  return lines.map((line) => String(line).split(";")[0]).join("; ");
}

export interface Session {
  cookie: string;
  csrfToken: string;
}

/** Signs a user in on an app. Sign-in is rate limited, so a test that needs one user often keeps the session. */
export async function signIn(
  app: Pick<FastifyInstance, "inject">,
  userId: string,
): Promise<Session> {
  const visit = await app.inject({ method: "GET", url: "/api/session" });
  const token = SessionResponse.parse(visit.json()).csrfToken;
  const response = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: { cookie: cookieOf(visit), "x-csrf-token": token },
    payload: { userId },
  });
  return {
    cookie: cookieOf(response),
    csrfToken: SessionResponse.parse(response.json()).csrfToken,
  };
}

/**
 * One app with scripted fake partners, a call log for them, and a retry job on a clock that the
 * test moves. Each harness has its own app, so the rate limits of one test do not reach another.
 */
export async function startHarness(database: TestDatabase, options: HarnessOptions = {}) {
  const calls: PartnerCall[] = [];
  const fakeChain = createFakeChain(options.chain);
  const fakeRail = createFakePaymentRail(options.rail);
  const chain: Chain = {
    lock: (deal, amount, key) => {
      calls.push({ partner: "chain", method: "lock", party: deal, amount, key });
      return fakeChain.lock(deal, amount, key);
    },
    transfer: (seller, amount, key) => {
      calls.push({ partner: "chain", method: "transfer", party: seller, amount, key });
      return fakeChain.transfer(seller, amount, key);
    },
  };
  const paymentRail: PaymentRail = {
    charge: (buyer, amount, key) => {
      calls.push({ partner: "rail", method: "charge", party: buyer, amount, key });
      return fakeRail.charge(buyer, amount, key);
    },
  };
  const app = await buildApp({
    config: testConfig,
    db: database.db,
    logger: false,
    chain,
    paymentRail,
  });
  let clock = Date.now();
  const job = createFundingRetryJob({
    db: database.db,
    chain,
    paymentRail,
    now: () => new Date(clock),
  });
  const sessions = new Map<string, Session>();

  async function call(userId: string, method: "GET" | "POST", url: string, payload: object = {}) {
    let who = sessions.get(userId);
    if (who === undefined) {
      who = await signIn(app, userId);
      sessions.set(userId, who);
    }
    return app.inject({
      method,
      url,
      headers: { cookie: who.cookie, "x-csrf-token": who.csrfToken },
      ...(method === "POST" ? { payload } : {}),
    });
  }

  const ok = <T extends { statusCode: number }>(response: T): T => {
    if (response.statusCode !== 200 && response.statusCode !== 201) {
      throw new Error(`The set-up request answered ${String(response.statusCode)}`);
    }
    return response;
  };

  const h = {
    app,
    calls,
    call,
    /** A draft Deal of 400 and 600 pounds. It keeps the approval path unless the test asks for express. */
    async createDeal(options: { express?: boolean } = {}) {
      const created = ok(
        await call(ALICE, "POST", "/api/deals", {
          sellerId: CAROL,
          title: "Logo design",
          totalMinor: 100_000,
          express: options.express ?? false,
          milestones: [
            { title: "Draft", amountMinor: 40_000 },
            { title: "Final", amountMinor: 60_000 },
          ],
        }),
      );
      const dealId = DealResponse.parse(created.json()).id;
      const rows = await database.db
        .select({ id: schema.milestones.id })
        .from(schema.milestones)
        .where(eq(schema.milestones.dealId, dealId))
        .orderBy(schema.milestones.position);
      return { dealId, first: rows[0]?.id ?? "", second: rows[1]?.id ?? "" };
    },
    /** The fund request. It does not check the answer. */
    fund: (dealId: string) => call(ALICE, "POST", `/api/deals/${dealId}/fund`),
    sendEvidence: (milestoneId: string) =>
      call(CAROL, "POST", `/api/milestones/${milestoneId}/evidence`, { evidenceText: "Done" }),
    accept: (milestoneId: string) => call(ALICE, "POST", `/api/milestones/${milestoneId}/accept`),
    reject: (milestoneId: string) =>
      call(ALICE, "POST", `/api/milestones/${milestoneId}/reject`, { reason: "Wrong file" }),
    approve: (milestoneId: string) => call(ERIN, "POST", `/api/milestones/${milestoneId}/payout`),
    retry: (payoutId: string) => call(ERIN, "POST", `/api/payouts/${payoutId}/retry`),
    /** A set-up step: it throws when the request is not a success. */
    async step(request: Promise<{ statusCode: number }>) {
      ok(await request);
    },
    /** Moves the clock of the retry job and runs the job once for the Deal. */
    async runJob(dealId: string, times = 1) {
      for (let run = 0; run < times; run += 1) {
        clock += 60_000;
        await job.runOnce({ dealIds: [dealId] });
      }
    },
    /** Every row that belongs to a Deal, and the partner calls so far. */
    async snapshot(dealId: string) {
      const milestones = await database.db
        .select()
        .from(schema.milestones)
        .where(eq(schema.milestones.dealId, dealId))
        .orderBy(schema.milestones.position);
      return {
        deal: await database.db.select().from(schema.deals).where(eq(schema.deals.id, dealId)),
        milestones,
        payouts: await database.db
          .select()
          .from(schema.payouts)
          .where(
            inArray(
              schema.payouts.milestoneId,
              milestones.map((m) => m.id),
            ),
          )
          .orderBy(schema.payouts.id),
        ledger: await database.db
          .select()
          .from(schema.ledgerEntries)
          .where(eq(schema.ledgerEntries.dealId, dealId))
          .orderBy(schema.ledgerEntries.id),
        audit: await database.db
          .select()
          .from(schema.auditEvents)
          .where(eq(schema.auditEvents.dealId, dealId))
          .orderBy(schema.auditEvents.id),
        calls: [...calls],
      };
    },
    async payoutOf(milestoneId: string) {
      const [row] = await database.db
        .select()
        .from(schema.payouts)
        .where(eq(schema.payouts.milestoneId, milestoneId));
      return row;
    },
    close: () => app.close(),
  };
  return h;
}

export type Harness = Awaited<ReturnType<typeof startHarness>>;

const FAIL: Step = { kind: "fail", failure: "timeout" };
export const failures = (count: number): Step[] => Array.from({ length: count }, () => FAIL);

export interface Target {
  dealId: string;
  first: string;
  second: string;
  payoutId: string;
}

export async function funded(h: Harness): Promise<Target> {
  const ids = await h.createDeal();
  await h.step(h.fund(ids.dealId));
  return { ...ids, payoutId: "" };
}

export async function evidenceSent(h: Harness): Promise<Target> {
  const ids = await funded(h);
  await h.step(h.sendEvidence(ids.first));
  return ids;
}

export async function accepted(h: Harness): Promise<Target> {
  const ids = await evidenceSent(h);
  await h.step(h.accept(ids.first));
  return ids;
}

/** Approves the Payout of the first Milestone and reads its id. */
export async function approved(h: Harness): Promise<Target> {
  const ids = await accepted(h);
  await h.step(h.approve(ids.first));
  return { ...ids, payoutId: (await h.payoutOf(ids.first))?.id ?? "" };
}

export async function completed(h: Harness): Promise<Target> {
  const ids = await approved(h);
  await h.step(h.sendEvidence(ids.second));
  await h.step(h.accept(ids.second));
  await h.step(h.approve(ids.second));
  return ids;
}
