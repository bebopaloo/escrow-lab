import { SEED_USERS, schema, seedUsers } from "@escrow-lab/db";
import { DealResponse, SessionResponse } from "@escrow-lab/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { openTestDatabase, testConfig } from "./database.ts";

const ALICE = SEED_USERS[0]?.id ?? "";
const BOB = SEED_USERS[1]?.id ?? "";
const CAROL = SEED_USERS[2]?.id ?? "";
const DAN = SEED_USERS[3]?.id ?? "";

type Database = Awaited<ReturnType<typeof openTestDatabase>>;
interface Session {
  cookie: string;
  csrfToken: string;
}

function cookieOf(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const lines = Array.isArray(header) ? header : typeof header === "string" ? [header] : [];
  return lines.map((line) => String(line).split(";")[0]).join("; ");
}

describe("Milestone evidence", () => {
  let database: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const sessions = new Map<string, Session>();

  async function signIn(userId: string): Promise<Session> {
    const known = sessions.get(userId);
    if (known !== undefined) return known;
    const visit = await app.inject({ method: "GET", url: "/api/session" });
    const token = SessionResponse.parse(visit.json()).csrfToken;
    const response = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { cookie: cookieOf(visit), "x-csrf-token": token },
      payload: { userId },
    });
    const session = {
      cookie: cookieOf(response),
      csrfToken: SessionResponse.parse(response.json()).csrfToken,
    };
    sessions.set(userId, session);
    return session;
  }

  /** A funded Deal between Alice and Carol. Returns the id of its open Milestone. */
  async function openMilestone(): Promise<{ dealId: string; milestoneId: string }> {
    const buyer = await signIn(ALICE);
    const headers = { cookie: buyer.cookie, "x-csrf-token": buyer.csrfToken };
    const created = await app.inject({
      method: "POST",
      url: "/api/deals",
      headers,
      payload: {
        sellerId: CAROL,
        title: "Logo design",
        totalMinor: 100_000,
        milestones: [
          { title: "Draft", amountMinor: 40_000 },
          { title: "Final", amountMinor: 60_000 },
        ],
      },
    });
    const dealId = DealResponse.parse(created.json()).id;
    await app.inject({ method: "POST", url: `/api/deals/${dealId}/fund`, headers });
    const [milestone] = await database.db
      .select({ id: schema.milestones.id })
      .from(schema.milestones)
      .where(eq(schema.milestones.dealId, dealId))
      .orderBy(schema.milestones.position);
    return { dealId, milestoneId: milestone?.id ?? "" };
  }

  async function act(
    userId: string,
    milestoneId: string,
    action: "evidence" | "accept" | "reject",
    payload: unknown = {},
    withCsrf = true,
  ) {
    const who = await signIn(userId);
    return app.inject({
      method: "POST",
      url: `/api/milestones/${milestoneId}/${action}`,
      headers: { cookie: who.cookie, ...(withCsrf ? { "x-csrf-token": who.csrfToken } : {}) },
      payload: payload as object,
    });
  }

  const row = async (id: string) =>
    (await database.db.select().from(schema.milestones).where(eq(schema.milestones.id, id)))[0];
  const auditActions = async (dealId: string) =>
    (
      await database.db
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.dealId, dealId))
    ).map((event) => event.action);
  async function dealAs(userId: string, dealId: string) {
    const who = await signIn(userId);
    const response = await app.inject({
      method: "GET",
      url: `/api/deals/${dealId}`,
      headers: { cookie: who.cookie },
    });
    return DealResponse.parse(response.json());
  }
  async function sendEvidence() {
    const open = await openMilestone();
    const sent = await act(CAROL, open.milestoneId, "evidence", { evidenceText: "Done: link" });
    expect(sent.statusCode).toBe(200);
    return open;
  }

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
    app = await buildApp({ config: testConfig, db: database.db, logger: false });
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  describe("send evidence", () => {
    it("moves the Milestone to evidence_sent, shows the evidence to the Buyer and audits it", async () => {
      const { dealId, milestoneId } = await openMilestone();
      const response = await act(CAROL, milestoneId, "evidence", {
        evidenceText: "x".repeat(2000),
      });
      expect(response.statusCode).toBe(200);
      expect((await row(milestoneId))?.state).toBe("evidence_sent");
      const seen = await dealAs(ALICE, dealId);
      expect(seen.milestones[0]).toMatchObject({
        state: "evidence_sent",
        evidenceText: "x".repeat(2000),
      });
      expect(await auditActions(dealId)).toContain("send_evidence");
    });

    it("refuses bad bodies with 400 and changes nothing", async () => {
      const { milestoneId } = await openMilestone();
      for (const payload of [
        { evidenceText: "x".repeat(2001) },
        { evidenceText: "" },
        { evidenceText: "ok", extra: 1 },
      ]) {
        expect((await act(CAROL, milestoneId, "evidence", payload)).statusCode).toBe(400);
      }
      expect((await row(milestoneId))?.state).toBe("awaiting_evidence");
    });

    it("returns 409 for evidence in the wrong state and keeps the first evidence", async () => {
      const { milestoneId, dealId } = await sendEvidence();
      const again = await act(CAROL, milestoneId, "evidence", { evidenceText: "second" });
      expect(again.statusCode).toBe(409);
      expect((await row(milestoneId))?.evidenceText).toBe("Done: link");
      expect((await auditActions(dealId)).filter((a) => a === "send_evidence")).toHaveLength(1);
    });

    it("returns 409 for a Milestone that is not open", async () => {
      const { dealId } = await openMilestone();
      const [second] = await database.db
        .select({ id: schema.milestones.id })
        .from(schema.milestones)
        .where(eq(schema.milestones.dealId, dealId))
        .orderBy(schema.milestones.position)
        .offset(1);
      const response = await act(CAROL, second?.id ?? "", "evidence", { evidenceText: "early" });
      expect(response.statusCode).toBe(409);
    });

    it("refuses the Buyer with 403, another Seller with 404, and a missing CSRF token", async () => {
      const { milestoneId } = await openMilestone();
      const body = { evidenceText: "mine" };
      expect((await act(ALICE, milestoneId, "evidence", body)).statusCode).toBe(403);
      expect((await act(DAN, milestoneId, "evidence", body)).statusCode).toBe(404);
      expect((await act(CAROL, milestoneId, "evidence", body, false)).statusCode).toBe(403);
      expect((await row(milestoneId))?.state).toBe("awaiting_evidence");
    });

    it("returns 404 for an unknown Milestone and 400 for a bad id", async () => {
      const unknown = "00000000-0000-4000-8000-0000000000ff";
      expect((await act(CAROL, unknown, "evidence", { evidenceText: "a" })).statusCode).toBe(404);
      expect((await act(CAROL, "nope", "evidence", { evidenceText: "a" })).statusCode).toBe(400);
    });
  });

  describe("reject evidence", () => {
    it("goes back to awaiting_evidence, the Seller sees the reason and can send again", async () => {
      const { dealId, milestoneId } = await sendEvidence();
      const response = await act(ALICE, milestoneId, "reject", { reason: "r".repeat(500) });
      expect(response.statusCode).toBe(200);
      expect((await row(milestoneId))?.state).toBe("awaiting_evidence");
      const seen = await dealAs(CAROL, dealId);
      expect(seen.milestones[0]).toMatchObject({
        state: "awaiting_evidence",
        rejectionReason: "r".repeat(500),
      });
      expect(await auditActions(dealId)).toContain("reject");
      const resent = await act(CAROL, milestoneId, "evidence", { evidenceText: "better" });
      expect(resent.statusCode).toBe(200);
      expect((await row(milestoneId))?.evidenceText).toBe("better");
    });

    it("refuses bad bodies with 400 and changes nothing", async () => {
      const { milestoneId } = await sendEvidence();
      for (const payload of [
        { reason: "r".repeat(501) },
        { reason: "" },
        {},
        { reason: "a", x: 1 },
      ]) {
        expect((await act(ALICE, milestoneId, "reject", payload)).statusCode).toBe(400);
      }
      expect((await row(milestoneId))?.state).toBe("evidence_sent");
    });

    it("returns 409 when no evidence is waiting", async () => {
      const { milestoneId, dealId } = await openMilestone();
      const response = await act(ALICE, milestoneId, "reject", { reason: "no" });
      expect(response.statusCode).toBe(409);
      expect((await row(milestoneId))?.state).toBe("awaiting_evidence");
      expect(await auditActions(dealId)).not.toContain("reject");
    });

    it("refuses the Seller with 403, another Buyer with 404, and a missing CSRF token", async () => {
      const { milestoneId } = await sendEvidence();
      const body = { reason: "no" };
      expect((await act(CAROL, milestoneId, "reject", body)).statusCode).toBe(403);
      expect((await act(BOB, milestoneId, "reject", body)).statusCode).toBe(404);
      expect((await act(ALICE, milestoneId, "reject", body, false)).statusCode).toBe(403);
      expect((await row(milestoneId))?.state).toBe("evidence_sent");
    });
  });

  describe("accept evidence", () => {
    it("moves the Milestone to accepted and audits it", async () => {
      const { dealId, milestoneId } = await sendEvidence();
      const response = await act(ALICE, milestoneId, "accept");
      expect(response.statusCode).toBe(200);
      expect((await row(milestoneId))?.state).toBe("accepted");
      expect(await auditActions(dealId)).toContain("accept");
    });

    it("returns 409 for a second accept and for an accept with no evidence", async () => {
      const { dealId, milestoneId } = await sendEvidence();
      await act(ALICE, milestoneId, "accept");
      expect((await act(ALICE, milestoneId, "accept")).statusCode).toBe(409);
      expect((await auditActions(dealId)).filter((a) => a === "accept")).toHaveLength(1);
      const fresh = await openMilestone();
      expect((await act(ALICE, fresh.milestoneId, "accept")).statusCode).toBe(409);
      expect((await row(fresh.milestoneId))?.state).toBe("awaiting_evidence");
    });

    it("refuses the Seller with 403, another Buyer with 404, and a missing CSRF token", async () => {
      const { milestoneId } = await sendEvidence();
      expect((await act(CAROL, milestoneId, "accept")).statusCode).toBe(403);
      expect((await act(BOB, milestoneId, "accept")).statusCode).toBe(404);
      expect((await act(ALICE, milestoneId, "accept", {}, false)).statusCode).toBe(403);
      expect((await act(ALICE, milestoneId, "accept", { x: 1 })).statusCode).toBe(400);
      expect((await row(milestoneId))?.state).toBe("evidence_sent");
    });
  });
});
