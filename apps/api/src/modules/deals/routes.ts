import type { Database } from "@escrow-lab/db";
import {
  CreateDealRequest,
  DealIdParams,
  DealListResponse,
  DealResponse,
  ErrorResponse,
  ListDealsQuery,
  MILESTONES_MUST_ADD_UP,
  SELLER_MUST_BE_SELLER,
} from "@escrow-lab/shared";
import type { preHandlerHookHandler } from "fastify";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { recordAuditEvent } from "../audit/index.ts";
import { requireRole } from "../identity/index.ts";
import { createDeal, findDeal, isSeller, listDeals } from "./store.ts";

export interface DealsOptions {
  db: Database;
}

export const dealRoutes: FastifyPluginCallbackZod<DealsOptions> = (app, { db }, done) => {
  const csrf: preHandlerHookHandler = (request, reply, next) => {
    app.csrfProtection(request, reply, next);
  };
  const participant = requireRole(db, "buyer", "seller");

  app.get(
    "/deals",
    {
      onRequest: participant,
      schema: { querystring: ListDealsQuery, response: { 200: DealListResponse } },
    },
    async (request) => {
      const { limit, offset } = request.query;
      const page = await listDeals(db, request.user?.id ?? "", limit, offset);
      return { ...page, limit, offset };
    },
  );

  app.get(
    "/deals/:id",
    {
      onRequest: participant,
      schema: { params: DealIdParams, response: { 200: DealResponse, 404: ErrorResponse } },
    },
    async (request, reply) => {
      const deal = await findDeal(db, request.user?.id ?? "", request.params.id);
      if (deal === undefined) {
        return reply.status(404).send({ error: "Not found", requestId: request.id });
      }
      return deal;
    },
  );

  app.post(
    "/deals",
    {
      // The role check comes first, so a Seller gets 403 before the CSRF check.
      onRequest: [requireRole(db, "buyer"), csrf],
      schema: {
        body: CreateDealRequest,
        response: { 201: DealResponse, 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const buyerId = request.user?.id ?? "";
      const body = request.body;
      const sum = body.milestones.reduce((total, item) => total + item.amountMinor, 0);
      if (sum !== body.totalMinor) {
        return reply.status(400).send({ error: MILESTONES_MUST_ADD_UP, requestId: request.id });
      }
      if (!(await isSeller(db, body.sellerId))) {
        return reply.status(400).send({ error: SELLER_MUST_BE_SELLER, requestId: request.id });
      }
      const dealId = await createDeal(db, buyerId, body);
      await recordAuditEvent(db, { userId: buyerId, action: "create_deal", dealId });
      const deal = await findDeal(db, buyerId, dealId);
      if (deal === undefined) throw new Error("The new Deal cannot be read");
      return reply.status(201).send(deal);
    },
  );
  done();
};
