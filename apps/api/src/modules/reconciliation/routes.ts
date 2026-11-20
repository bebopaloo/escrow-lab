import type { Database } from "@escrow-lab/db";
import {
  ErrorResponse,
  FixMismatchRequest,
  FixMismatchResponse,
  MismatchIdParams,
  MismatchListQuery,
  MismatchListResponse,
  WRONG_FIX_STATE,
} from "@escrow-lab/shared";
import type { preHandlerHookHandler } from "fastify";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { requireRole } from "../identity/index.ts";
import { fixMismatch } from "./fix.ts";
import { listOpenMismatches } from "./list.ts";

const FIX_LIMIT = 30;

export interface ReconciliationRoutesOptions {
  db: Database;
}

export const reconciliationRoutes: FastifyPluginCallbackZod<ReconciliationRoutesOptions> = (
  app,
  { db },
  done,
) => {
  app.get(
    "/reconciliation/mismatches",
    {
      onRequest: requireRole(db, "approver"),
      schema: {
        querystring: MismatchListQuery,
        response: { 200: MismatchListResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async (request) => {
      const { limit, offset } = request.query;
      const page = await listOpenMismatches(db, limit, offset);
      return { ...page, limit, offset };
    },
  );

  const csrf: preHandlerHookHandler = (request, reply, next) => {
    app.csrfProtection(request, reply, next);
  };

  app.post(
    "/reconciliation/mismatches/:id/fix",
    {
      config: { rateLimit: { max: FIX_LIMIT, timeWindow: "1 minute" } },
      onRequest: [requireRole(db, "approver"), csrf],
      schema: {
        params: MismatchIdParams,
        body: FixMismatchRequest,
        response: { 200: FixMismatchResponse, 404: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      const outcome = await fixMismatch(db, request.user?.id ?? "", request.params.id);
      if (outcome.kind === "not_found") {
        return reply.status(404).send({ error: "Not found", requestId: request.id });
      }
      if (outcome.kind === "wrong_state") {
        return reply.status(409).send({ error: WRONG_FIX_STATE, requestId: request.id });
      }
      return { mismatchId: outcome.mismatchId, payoutId: outcome.payoutId };
    },
  );
  done();
};
