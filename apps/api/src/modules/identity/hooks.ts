import type { Database } from "@escrow-lab/db";
import type { Role, SessionUser } from "@escrow-lab/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { findUserWithVersion } from "./users.ts";

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in user. Set by `requireSession` and `requireRole`. */
    user: SessionUser | null;
  }
}

function refuse(request: FastifyRequest, reply: FastifyReply, status: 401 | 403) {
  const error = status === 401 ? "Unauthorized" : "Forbidden";
  return reply.status(status).send({ error, requestId: request.id });
}

/** A session with no request for this long is refused. */
export const IDLE_LIMIT_MS = 30 * 60 * 1000;
/** A session is refused this long after sign-in, however often it is used. */
export const ABSOLUTE_LIMIT_MS = 8 * 60 * 60 * 1000;

/** Stores who signed in, at which session version and when. Call it after `regenerate()`. */
export function startSession(request: FastifyRequest, userId: string, sessionVersion: number) {
  const now = Date.now();
  request.session.set("userId", userId);
  request.session.set("sessionVersion", sessionVersion);
  request.session.set("signedInAt", now);
  request.session.set("lastSeenAt", now);
}

/**
 * The signed-in user, or null. The session must name a user that exists, match the user's
 * session version, be younger than 8 hours and have been used in the last 30 minutes.
 * A valid session gets a new last-seen time.
 */
export async function authenticate(
  db: Database,
  request: FastifyRequest,
): Promise<SessionUser | null> {
  const userId = request.session.get("userId");
  const version = request.session.get("sessionVersion");
  const signedInAt = request.session.get("signedInAt");
  const lastSeenAt = request.session.get("lastSeenAt");
  if (
    userId === undefined ||
    version === undefined ||
    signedInAt === undefined ||
    lastSeenAt === undefined
  ) {
    return null;
  }
  const now = Date.now();
  if (now - signedInAt > ABSOLUTE_LIMIT_MS || now - lastSeenAt > IDLE_LIMIT_MS) return null;
  const found = await findUserWithVersion(db, userId);
  if (found?.sessionVersion !== version) return null;
  request.session.set("lastSeenAt", now);
  return found.user;
}

/** An `onRequest` hook: the session names a user that exists. The role is read from the database. */
export function requireSession(db: Database) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await authenticate(db, request);
    if (user === null) return refuse(request, reply, 401);
    request.user = user;
    return undefined;
  };
}

/** An `onRequest` hook: requireSession, and the user has one of the roles. */
export function requireRole(db: Database, ...roles: Role[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await authenticate(db, request);
    if (user === null) return refuse(request, reply, 401);
    if (!roles.includes(user.role)) return refuse(request, reply, 403);
    request.user = user;
    return undefined;
  };
}
