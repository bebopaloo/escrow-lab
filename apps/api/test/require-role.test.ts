import { SEED_USERS, seedUsers } from "@escrow-lab/db";
import { SessionResponse, type Role } from "@escrow-lab/shared";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { requireRole } from "../src/modules/identity/index.ts";
import { openTestDatabase, testConfig } from "./database.ts";

describe("requireRole", () => {
  let database: Awaited<ReturnType<typeof openTestDatabase>>;

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
  });

  afterAll(async () => {
    await database.close();
  });

  async function makeApp() {
    const app = await buildApp({ config: testConfig, db: database.db, logger: false });
    app.get(
      "/api/only-approvers",
      { onRequest: requireRole(database.db, "approver") },
      (request) => ({ role: request.user?.role ?? null }),
    );
    app.get("/api/ghost-session", { config: { public: true } }, (request) => {
      request.session.set("userId", randomUUID());
      return { ok: true };
    });
    return app;
  }

  function cookieOf(response: { headers: Record<string, unknown> }): string {
    const header = response.headers["set-cookie"];
    const lines = Array.isArray(header) ? header : typeof header === "string" ? [header] : [];
    return lines.map((line) => String(line).split(";")[0]).join("; ");
  }

  async function cookieFor(app: Awaited<ReturnType<typeof makeApp>>, role: Role) {
    const seedUser = SEED_USERS.find((user) => user.role === role);
    const visit = await app.inject({ method: "GET", url: "/api/session" });
    const token = SessionResponse.parse(visit.json()).csrfToken;
    const signedIn = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { cookie: cookieOf(visit), "x-csrf-token": token },
      payload: { userId: seedUser?.id },
    });
    return cookieOf(signedIn);
  }

  it("answers 401 with no session", async () => {
    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/api/only-approvers" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("answers 403 for a Buyer", async () => {
    const app = await makeApp();
    const cookie = await cookieFor(app, "buyer");
    const response = await app.inject({
      method: "GET",
      url: "/api/only-approvers",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("answers 200 for an Approver", async () => {
    const app = await makeApp();
    const cookie = await cookieFor(app, "approver");
    const response = await app.inject({
      method: "GET",
      url: "/api/only-approvers",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ role: "approver" });
    await app.close();
  });

  it("answers 401 when the session user is not in the database", async () => {
    const app = await makeApp();
    const ghost = await app.inject({ method: "GET", url: "/api/ghost-session" });
    const response = await app.inject({
      method: "GET",
      url: "/api/only-approvers",
      headers: { cookie: cookieOf(ghost) },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
