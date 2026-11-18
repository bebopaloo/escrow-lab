import type { Database } from "@escrow-lab/db";
import {
  AddNoteRequest,
  CreateDealRequest,
  DealIdParams,
  DealListResponse,
  DealResponse,
  ErrorResponse,
  ListDealsQuery,
  MILESTONES_MUST_ADD_UP,
  NoteResponse,
  NotesResponse,
  PAYMENT_FAILED,
  SELLER_MUST_BE_SELLER,
  WRONG_DEAL_STATE,
} from "@escrow-lab/shared";
import type { preHandlerHookHandler } from "fastify";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import type { Chain } from "../../adapters/chain/index.ts";
import type { PaymentRail } from "../../adapters/payment-rail/index.ts";
import { requireRole } from "../identity/index.ts";
import { cancelDeal } from "./cancel.ts";
import { fundDeal } from "./fund.ts";
import { addNote, listNotes } from "./notes.ts";
import { createDeal, findDeal, isSeller, listDeals } from "./store.ts";

const CREATE_DEAL_LIMIT = 30;
const FUND_DEAL_LIMIT = 30;
const CANCEL_DEAL_LIMIT = 30;
const ADD_NOTE_LIMIT = 30;

export interface DealsOptions {
  db: Database;
  chain: Chain;
  paymentRail: PaymentRail;
}

export const dealRoutes: FastifyPluginCallbackZod<DealsOptions> = (
  app,
  { db, chain, paymentRail },
  done,
) => {
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
      config: { rateLimit: { max: CREATE_DEAL_LIMIT, timeWindow: "1 minute" } },
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
      const deal = await findDeal(db, buyerId, dealId);
      if (deal === undefined) throw new Error("The new Deal cannot be read");
      return reply.status(201).send(deal);
    },
  );

  app.post(
    "/deals/:id/fund",
    {
      config: { rateLimit: { max: FUND_DEAL_LIMIT, timeWindow: "1 minute" } },
      onRequest: [requireRole(db, "buyer"), csrf],
      schema: {
        params: DealIdParams,
        response: {
          200: DealResponse,
          402: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const buyerId = request.user?.id ?? "";
      const outcome = await fundDeal(db, { chain, paymentRail }, buyerId, request.params.id);
      if (outcome.kind === "not_found") {
        return reply.status(404).send({ error: "Not found", requestId: request.id });
      }
      if (outcome.kind === "wrong_state") {
        return reply.status(409).send({ error: WRONG_DEAL_STATE, requestId: request.id });
      }
      if (outcome.kind === "refused") {
        return reply.status(402).send({ error: PAYMENT_FAILED, requestId: request.id });
      }
      const deal = await findDeal(db, buyerId, request.params.id);
      if (deal === undefined) throw new Error("The funded Deal cannot be read");
      return deal;
    },
  );

  app.post(
    "/deals/:id/cancel",
    {
      config: { rateLimit: { max: CANCEL_DEAL_LIMIT, timeWindow: "1 minute" } },
      onRequest: [requireRole(db, "buyer"), csrf],
      schema: {
        params: DealIdParams,
        response: { 200: DealResponse, 404: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (request, reply) => {
      const buyerId = request.user?.id ?? "";
      const outcome = await cancelDeal(db, buyerId, request.params.id);
      if (outcome.kind === "not_found") {
        return reply.status(404).send({ error: "Not found", requestId: request.id });
      }
      if (outcome.kind === "wrong_state") {
        return reply.status(409).send({ error: WRONG_DEAL_STATE, requestId: request.id });
      }
      const deal = await findDeal(db, buyerId, request.params.id);
      if (deal === undefined) throw new Error("The cancelled Deal cannot be read");
      return deal;
    },
  );

  app.get(
    "/deals/:id/notes",
    {
      onRequest: participant,
      schema: { params: DealIdParams, response: { 200: NotesResponse, 404: ErrorResponse } },
    },
    async (request, reply) => {
      const notes = await listNotes(db, request.user?.id ?? "", request.params.id);
      if (notes === undefined) {
        return reply.status(404).send({ error: "Not found", requestId: request.id });
      }
      return { notes };
    },
  );

  app.post(
    "/deals/:id/notes",
    {
      config: { rateLimit: { max: ADD_NOTE_LIMIT, timeWindow: "1 minute" } },
      onRequest: [participant, csrf],
      schema: {
        params: DealIdParams,
        body: AddNoteRequest,
        response: { 201: NoteResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const note = await addNote(db, request.user?.id ?? "", request.params.id, request.body.text);
      if (note === undefined) {
        return reply.status(404).send({ error: "Not found", requestId: request.id });
      }
      return reply.status(201).send(note);
    },
  );
  done();
};
