import type { Database } from "@escrow-lab/db";
import {
  ChangeDisplayNameRequest,
  ErrorResponse,
  SessionResponse,
  SessionUser,
  SignInRequest,
  UsersResponse,
} from "@escrow-lab/shared";
import type { preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { recordAuditEvent } from "../audit/index.ts";
import { authenticate, requireSession, startSession } from "./hooks.ts";
import { bumpSessionVersion, findUserWithVersion, listUsers, changeDisplayName } from "./users.ts";

declare module "@fastify/secure-session" {
  interface SessionData {
    userId: string;
    sessionVersion: number;
    /** Milliseconds since the epoch. */
    signedInAt: number;
    lastSeenAt: number;
  }
}

const CHANGE_NAME_LIMIT = 30;

export interface IdentityOptions {
  db: Database;
  /** Sign-ins per minute from one address. */
  signInLimit: number;
}

export const identityRoutes: FastifyPluginCallbackZod<IdentityOptions> = (
  app,
  { db, signInLimit },
  done,
) => {
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
      const user = await authenticate(db, request);
      return { user, csrfToken: reply.generateCsrf() };
    },
  );
  app.post(
    "/session",
    {
      config: { public: true, rateLimit: { max: signInLimit, timeWindow: "1 minute" } },
      onRequest: csrf,
      schema: {
        body: SignInRequest,
        response: { 200: SessionResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const found = await findUserWithVersion(db, request.body.userId);
      if (found === undefined) {
        return reply.status(404).send({ error: "Not found", requestId: request.id });
      }
      const { user, sessionVersion } = found;
      // The audit event comes first: when it fails, the reply carries no signed-in session.
      await recordAuditEvent(db, { userId: user.id, action: "sign_in" });
      // A new session on sign-in stops session fixation and rotates the CSRF secret.
      request.session.regenerate();
      startSession(request, user.id, sessionVersion);
      return { user, csrfToken: reply.generateCsrf() };
    },
  );
  app.patch(
    "/session/user",
    {
      config: { rateLimit: { max: CHANGE_NAME_LIMIT, timeWindow: "1 minute" } },
      onRequest: [requireSession(db), csrf],
      schema: {
        body: ChangeDisplayNameRequest,
        response: { 200: SessionUser, 401: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      // requireSession sets the user. The check keeps the type honest.
      const me = request.user;
      if (me === null)
        return reply.status(401).send({ error: "Unauthorized", requestId: request.id });
      const result = await changeDisplayName(db, me.id, request.body.displayName);
      if (result === "taken") {
        return reply.status(409).send({ error: "Name already in use", requestId: request.id });
      }
      return result;
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
      // The cookie holds its own state, so a new session version is what voids a copied cookie.
      if (request.user !== null) await bumpSessionVersion(db, request.user.id);
      request.session.delete();
      return reply.status(204).send(null);
    },
  );
  done();
};
