import { SEED_USERS, schema, seedUsers } from "@escrow-lab/db";
import { SessionResponse } from "@escrow-lab/shared";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.ts";
import { openTestDatabase, testConfig } from "./database.ts";

describe("sessions", () => {
  let database: Awaited<ReturnType<typeof openTestDatabase>>;

  beforeAll(async () => {
    database = await openTestDatabase();
    await seedUsers(database.db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await database.close();
  });

  async function makeApp() {
    return buildApp({ config: testConfig, db: database.db, logger: false });
  }

  type TestApp = Awaited<ReturnType<typeof makeApp>>;

  // Use the raw header: the parsed cookie value is decoded and loses its encoding.
  function cookieHeader(response: LightMyRequestResponse): string {
    const header = response.headers["set-cookie"];
    const lines = Array.isArray(header) ? header : header === undefined ? [] : [header];
    return lines.map((line) => line.split(";")[0] ?? "").join("; ");
  }

  async function visit(app: TestApp) {
    const response = await app.inject({ method: "GET", url: "/api/session" });
    return {
      cookie: cookieHeader(response),
      csrfToken: SessionResponse.parse(response.json()).csrfToken,
    };
  }

  async function signInAs(app: TestApp, userId: string) {
    const visitor = await visit(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { cookie: visitor.cookie, "x-csrf-token": visitor.csrfToken },
      payload: { userId },
    });
    return { response, visitor };
  }

  function signInCount(userId: string) {
    return database.db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.userId, userId), eq(schema.auditEvents.action, "sign_in")))
      .then((rows) => rows.length);
  }

  describe("GET /api/session", () => {
    it("gives a signed-out visitor a CSRF token and a safe cookie", async () => {
      const app = await makeApp();
      const response = await app.inject({ method: "GET", url: "/api/session" });
      expect(response.statusCode).toBe(200);
      const body = SessionResponse.parse(response.json());
      expect(body.user).toBeNull();
      expect(body.csrfToken.length).toBeGreaterThan(0);
      expect(response.cookies.length).toBeGreaterThan(0);
      for (const cookie of response.cookies) {
        expect(cookie.httpOnly).toBe(true);
        expect(cookie.secure).toBe(true);
        expect(cookie.sameSite).toBe("Lax");
      }
      await app.close();
    });
  });

  describe("session cookie", () => {
    it("uses the __Host- name and a path of /", async () => {
      const app = await makeApp();
      const response = await app.inject({ method: "GET", url: "/api/session" });
      const [cookie] = response.cookies;
      expect(cookie?.name).toBe("__Host-session");
      expect(cookie?.path).toBe("/");
      expect(cookie?.domain).toBeUndefined();
      await app.close();
    });

    it("refuses a session older than 8 hours", async () => {
      const app = await makeApp();
      const { response } = await signInAs(app, SEED_USERS[0]?.id ?? "");
      const cookie = cookieHeader(response);
      const read = async () =>
        SessionResponse.parse(
          (await app.inject({ method: "GET", url: "/api/session", headers: { cookie } })).json(),
        ).user;
      expect(await read()).not.toBeNull();
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + (8 * 60 * 60 + 60) * 1000 });
      expect(await read()).toBeNull();
      await app.close();
    });
  });

  describe("session limits", () => {
    const MINUTE = 60 * 1000;

    async function signedInCookie(app: TestApp) {
      const { response } = await signInAs(app, SEED_USERS[0]?.id ?? "");
      return cookieHeader(response);
    }

    function readUser(app: TestApp, cookie: string) {
      return app
        .inject({ method: "GET", url: "/api/session", headers: { cookie } })
        .then((response) => ({
          response,
          user: SessionResponse.parse(response.json()).user,
        }));
    }

    it("refuses a session idle for more than 30 minutes", async () => {
      const app = await makeApp();
      const cookie = await signedInCookie(app);
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 31 * MINUTE });
      expect((await readUser(app, cookie)).user).toBeNull();
      await app.close();
    });

    it("keeps a session that is used often, up to 8 hours after sign-in", async () => {
      const app = await makeApp();
      let cookie = await signedInCookie(app);
      const start = Date.now();
      // A visit every 20 minutes keeps the session alive.
      for (let step = 1; step <= 6; step += 1) {
        vi.useFakeTimers({ toFake: ["Date"], now: start + step * 20 * MINUTE });
        const { response, user } = await readUser(app, cookie);
        expect(user).not.toBeNull();
        const next = cookieHeader(response);
        if (next !== "") cookie = next;
      }
      // The 8 hour limit counts from sign-in, however recent the last visit.
      for (let step = 7; step <= 24; step += 1) {
        vi.useFakeTimers({ toFake: ["Date"], now: start + step * 20 * MINUTE });
        const { response } = await readUser(app, cookie);
        const next = cookieHeader(response);
        if (next !== "") cookie = next;
      }
      vi.useFakeTimers({ toFake: ["Date"], now: start + (8 * 60 + 1) * MINUTE });
      expect((await readUser(app, cookie)).user).toBeNull();
      await app.close();
    });

    it("refuses an authenticated route for a session idle for more than 30 minutes", async () => {
      const app = await makeApp();
      const { response } = await signInAs(app, SEED_USERS[0]?.id ?? "");
      const cookie = cookieHeader(response);
      const csrfToken = SessionResponse.parse(response.json()).csrfToken;
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 31 * MINUTE });
      const out = await app.inject({
        method: "DELETE",
        url: "/api/session",
        headers: { cookie, "x-csrf-token": csrfToken },
      });
      expect(out.statusCode).toBe(401);
      await app.close();
    });
  });

  describe("POST /api/session", () => {
    it.each(SEED_USERS.filter((_, index) => index % 2 === 0))(
      "signs in as $role $displayName and writes one audit event",
      async (seedUser) => {
        const app = await makeApp();
        const before = await signInCount(seedUser.id);
        const { response } = await signInAs(app, seedUser.id);
        expect(response.statusCode).toBe(200);
        const body = SessionResponse.parse(response.json());
        expect(body.user).toEqual(seedUser);
        expect(await signInCount(seedUser.id)).toBe(before + 1);

        const again = await app.inject({
          method: "GET",
          url: "/api/session",
          headers: { cookie: cookieHeader(response) },
        });
        expect(SessionResponse.parse(again.json()).user).toEqual(seedUser);
        await app.close();
      },
    );

    it("signs in nobody when the audit event cannot be written", async () => {
      const failing = new Proxy(database.db, {
        get(target, property) {
          if (property === "insert") {
            return () => {
              throw new Error("audit store down");
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return value;
        },
      });
      const app = await buildApp({ config: testConfig, db: failing, logger: false });
      const { response } = await signInAs(app, SEED_USERS[0]?.id ?? "");
      expect(response.statusCode).toBe(500);
      const after = await app.inject({
        method: "GET",
        url: "/api/session",
        headers: { cookie: cookieHeader(response) },
      });
      expect(SessionResponse.parse(after.json()).user).toBeNull();
      await app.close();
    });

    it("limits sign-ins to 20 a minute from one address", async () => {
      const app = await makeApp();
      const userId = SEED_USERS[1]?.id ?? "";
      const visitor = await visit(app);
      const attempt = () =>
        app.inject({
          method: "POST",
          url: "/api/session",
          headers: { cookie: visitor.cookie, "x-csrf-token": visitor.csrfToken },
          payload: { userId },
        });
      const before = await signInCount(userId);
      for (let count = 0; count < 20; count += 1) {
        expect((await attempt()).statusCode).toBe(200);
      }
      expect((await attempt()).statusCode).toBe(429);
      expect(await signInCount(userId)).toBe(before + 20);
      await app.close();
    });

    it("rotates the CSRF secret, so the token from before sign-in stops working", async () => {
      const app = await makeApp();
      const { response, visitor } = await signInAs(app, SEED_USERS[0]?.id ?? "");
      expect(response.statusCode).toBe(200);
      const signedIn = cookieHeader(response);
      const fresh = SessionResponse.parse(response.json()).csrfToken;
      const old = await app.inject({
        method: "DELETE",
        url: "/api/session",
        headers: { cookie: signedIn, "x-csrf-token": visitor.csrfToken },
      });
      expect(old.statusCode).toBe(403);
      const current = await app.inject({
        method: "DELETE",
        url: "/api/session",
        headers: { cookie: signedIn, "x-csrf-token": fresh },
      });
      expect(current.statusCode).toBe(204);
      await app.close();
    });

    describe("refusals", () => {
      const buyer = SEED_USERS[0];
      const buyerId = buyer?.id ?? "";

      it("answers 404 for an id that is not a seeded user, and writes no audit event", async () => {
        const app = await makeApp();
        const unknownId = randomUUID();
        const { response } = await signInAs(app, unknownId);
        expect(response.statusCode).toBe(404);
        const rows = await database.db
          .select()
          .from(schema.auditEvents)
          .where(eq(schema.auditEvents.userId, unknownId));
        expect(rows).toHaveLength(0);
        await app.close();
      });

      it("answers 400 for a body with an extra field", async () => {
        const app = await makeApp();
        const visitor = await visit(app);
        const before = await signInCount(buyerId);
        const response = await app.inject({
          method: "POST",
          url: "/api/session",
          headers: { cookie: visitor.cookie, "x-csrf-token": visitor.csrfToken },
          payload: { userId: buyerId, role: "approver" },
        });
        expect(response.statusCode).toBe(400);
        expect(await signInCount(buyerId)).toBe(before);
        await app.close();
      });

      it("answers 403 without a CSRF token, and writes no audit event", async () => {
        const app = await makeApp();
        const visitor = await visit(app);
        const before = await signInCount(buyerId);
        const response = await app.inject({
          method: "POST",
          url: "/api/session",
          headers: { cookie: visitor.cookie },
          payload: { userId: buyerId },
        });
        expect(response.statusCode).toBe(403);
        expect(await signInCount(buyerId)).toBe(before);
        await app.close();
      });

      it("answers 403 for a CSRF token from another session", async () => {
        const app = await makeApp();
        const visitor = await visit(app);
        const other = await visit(app);
        const before = await signInCount(buyerId);
        const response = await app.inject({
          method: "POST",
          url: "/api/session",
          headers: { cookie: visitor.cookie, "x-csrf-token": other.csrfToken },
          payload: { userId: buyerId },
        });
        expect(response.statusCode).toBe(403);
        expect(await signInCount(buyerId)).toBe(before);
        await app.close();
      });
    });
  });

  describe("DELETE /api/session", () => {
    async function signedIn(app: TestApp) {
      const { response } = await signInAs(app, SEED_USERS[0]?.id ?? "");
      return {
        cookie: cookieHeader(response),
        csrfToken: SessionResponse.parse(response.json()).csrfToken,
      };
    }

    it("signs the user out", async () => {
      const app = await makeApp();
      const session = await signedIn(app);
      const response = await app.inject({
        method: "DELETE",
        url: "/api/session",
        headers: { cookie: session.cookie, "x-csrf-token": session.csrfToken },
      });
      expect(response.statusCode).toBe(204);
      const after = await app.inject({
        method: "GET",
        url: "/api/session",
        headers: { cookie: cookieHeader(response) },
      });
      expect(SessionResponse.parse(after.json()).user).toBeNull();
      await app.close();
    });

    it("refuses a cookie copied before sign-out", async () => {
      const app = await makeApp();
      const session = await signedIn(app);
      const out = await app.inject({
        method: "DELETE",
        url: "/api/session",
        headers: { cookie: session.cookie, "x-csrf-token": session.csrfToken },
      });
      expect(out.statusCode).toBe(204);
      const replay = await app.inject({
        method: "GET",
        url: "/api/session",
        headers: { cookie: session.cookie },
      });
      expect(SessionResponse.parse(replay.json()).user).toBeNull();
      const again = await app.inject({
        method: "DELETE",
        url: "/api/session",
        headers: { cookie: session.cookie, "x-csrf-token": session.csrfToken },
      });
      expect(again.statusCode).toBe(401);
      await app.close();
    });

    it("answers 401 without a session", async () => {
      const app = await makeApp();
      const visitor = await visit(app);
      const response = await app.inject({
        method: "DELETE",
        url: "/api/session",
        headers: { cookie: visitor.cookie, "x-csrf-token": visitor.csrfToken },
      });
      expect(response.statusCode).toBe(401);
      await app.close();
    });

    it("answers 403 without a CSRF token", async () => {
      const app = await makeApp();
      const session = await signedIn(app);
      const response = await app.inject({
        method: "DELETE",
        url: "/api/session",
        headers: { cookie: session.cookie },
      });
      expect(response.statusCode).toBe(403);
      await app.close();
    });
  });
});
