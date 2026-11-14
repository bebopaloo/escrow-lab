import type { Database } from "@escrow-lab/db";
import type { Role, SessionUser } from "@escrow-lab/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { findUser } from "./users.ts";

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

async function authenticate(db: Database, request: FastifyRequest): Promise<SessionUser | null> {
  const userId = request.session.get("userId");
  const user = userId === undefined ? undefined : await findUser(db, userId);
  return user ?? null;
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
