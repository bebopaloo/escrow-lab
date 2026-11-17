import type { Database } from "@escrow-lab/db";
import {
  AcceptEvidenceRequest,
  ErrorResponse,
  MilestoneIdParams,
  MilestoneResponse,
  RejectEvidenceRequest,
  SendEvidenceRequest,
  WRONG_MILESTONE_STATE,
} from "@escrow-lab/shared";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import type { Chain } from "../../adapters/chain/index.ts";
import { requireRole } from "../identity/index.ts";
import { applyMilestoneAction, type MilestoneAction } from "./store.ts";

const MILESTONE_ACTION_LIMIT = 30;

export interface MilestonesOptions {
  db: Database;
  chain: Chain;
}

export const milestoneRoutes: FastifyPluginCallbackZod<MilestonesOptions> = (
  app,
  { db, chain },
  done,
) => {
  const csrf: preHandlerHookHandler = (request, reply, next) => {
    app.csrfProtection(request, reply, next);
  };
  const config = { rateLimit: { max: MILESTONE_ACTION_LIMIT, timeWindow: "1 minute" } };
  const response = {
    200: MilestoneResponse,
    404: ErrorResponse,
    409: ErrorResponse,
  };

  async function run(
    request: FastifyRequest,
    reply: FastifyReply,
    milestoneId: string,
    action: MilestoneAction,
  ) {
    const outcome = await applyMilestoneAction(db, chain, milestoneId, action);
    if (outcome.kind === "not_found") {
      return reply.status(404).send({ error: "Not found", requestId: request.id });
    }
    if (outcome.kind === "wrong_state") {
      return reply.status(409).send({ error: WRONG_MILESTONE_STATE, requestId: request.id });
    }
    return outcome.milestone;
  }

  app.post(
    "/milestones/:id/evidence",
    {
      config,
      onRequest: [requireRole(db, "seller"), csrf],
      schema: { params: MilestoneIdParams, body: SendEvidenceRequest, response },
    },
    (request, reply) =>
      run(request, reply, request.params.id, {
        kind: "send_evidence",
        sellerId: request.user?.id ?? "",
        evidenceText: request.body.evidenceText,
      }),
  );

  app.post(
    "/milestones/:id/accept",
    {
      config,
      onRequest: [requireRole(db, "buyer"), csrf],
      schema: { params: MilestoneIdParams, body: AcceptEvidenceRequest, response },
    },
    (request, reply) =>
      run(request, reply, request.params.id, { kind: "accept", buyerId: request.user?.id ?? "" }),
  );

  app.post(
    "/milestones/:id/reject",
    {
      config,
      onRequest: [requireRole(db, "buyer"), csrf],
      schema: { params: MilestoneIdParams, body: RejectEvidenceRequest, response },
    },
    (request, reply) =>
      run(request, reply, request.params.id, {
        kind: "reject",
        buyerId: request.user?.id ?? "",
        reason: request.body.reason,
      }),
  );
  done();
};
