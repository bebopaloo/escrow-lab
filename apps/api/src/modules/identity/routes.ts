import type { Database } from "@escrow-lab/db";
import { ErrorResponse, SessionResponse, SignInRequest, UsersResponse } from "@escrow-lab/shared";
import type { preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { recordAuditEvent } from "../audit/index.ts";
import { requireSession } from "./hooks.ts";
import { findUser, listUsers } from "./users.ts";

declare module "@fastify/secure-session" {
  interface SessionData {
    userId: string;
  }
}

const SIGN_IN_LIMIT = 20;

export interface IdentityOptions {
  db: Database;
}

export const identityRoutes: FastifyPluginCallbackZod<IdentityOptions> = (app, { db }, done) => {
  const csrf: preHandlerHookHandler = (request, reply, next) => {
    app.csrfProtection(request, reply, next);
  };

  app.get(
    "/users",
    { config: { public: true }, schema: { response: { 200: UsersResponse } } },
    async () => ({ users: await listUsers(db) }),
  );
  app.get(
    "/session",
    { config: { public: true }, schema: { response: { 200: SessionResponse } } },
    async (request, reply) => {
      const userId = request.session.get("userId");
      const user = userId === undefined ? undefined : await findUser(db, userId);
      return { user: user ?? null, csrfToken: reply.generateCsrf() };
    },
  );
  app.post(
    "/session",
    {
      config: { public: true, rateLimit: { max: SIGN_IN_LIMIT, timeWindow: "1 minute" } },
      onRequest: csrf,
      schema: {
        body: SignInRequest,
        response: { 200: SessionResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const user = await findUser(db, request.body.userId);
      if (user === undefined) {
        return reply.status(404).send({ error: "Not found", requestId: request.id });
      }
      // A new session on sign-in stops session fixation and rotates the CSRF secret.
      request.session.regenerate();
      request.session.set("userId", user.id);
      await recordAuditEvent(db, { userId: user.id, action: "sign_in" });
      return { user, csrfToken: reply.generateCsrf() };
    },
  );
  app.delete(
    "/session",
    {
      // The session check comes first, so a visitor with no session gets 401.
      onRequest: [requireSession(db), csrf],
      schema: { response: { 204: z.null() } },
    },
    async (request, reply) => {
      request.session.delete();
      return reply.status(204).send(null);
    },
  );
  done();
};
