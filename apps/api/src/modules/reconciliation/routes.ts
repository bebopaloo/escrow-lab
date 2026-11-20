import type { Database } from "@escrow-lab/db";
import { ErrorResponse, MismatchListQuery, MismatchListResponse } from "@escrow-lab/shared";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { requireRole } from "../identity/index.ts";
import { listOpenMismatches } from "./list.ts";

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
  done();
};
