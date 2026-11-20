import type { Database } from "@escrow-lab/db";
import {
  ApprovalQueueQuery,
  ApprovalQueueResponse,
  ApprovePayoutRequest,
  ApprovePayoutResponse,
  ErrorResponse,
  DealIdParams,
  MilestoneIdParams,
  PayoutIdParams,
  RefundDealRequest,
  RefundDealResponse,
  RetryPayoutRequest,
  RetryPayoutResponse,
  WRONG_REFUND_STATE,
  WRONG_RETRY_STATE,
  WRONG_PAYOUT_STATE,
} from "@escrow-lab/shared";
import type { preHandlerHookHandler } from "fastify";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import type { Chain } from "../../adapters/chain/index.ts";
import { requireRole } from "../identity/index.ts";
import { approvePayout } from "./approve.ts";
import { refundDeal } from "./refund.ts";
import { retryPayout } from "./retry.ts";
import { listApprovalQueue } from "./queue.ts";

const APPROVE_LIMIT = 30;

export interface ApprovalOptions {
  db: Database;
  chain: Chain;
}

export const approvalRoutes: FastifyPluginCallbackZod<ApprovalOptions> = (
  app,
  { db, chain },
  done,
) => {
  const csrf: preHandlerHookHandler = (request, reply, next) => {
    app.csrfProtection(request, reply, next);
  };

  app.get(
    "/approvals",
    {
      onRequest: requireRole(db, "approver"),
      schema: { querystring: ApprovalQueueQuery, response: { 200: ApprovalQueueResponse } },
    },
    async (request) => {
      const { limit, offset } = request.query;
      const page = await listApprovalQueue(db, limit, offset);
      return { ...page, limit, offset };
    },
  );

  app.post(
    "/milestones/:id/payout",
    {
      config: { rateLimit: { max: APPROVE_LIMIT, timeWindow: "1 minute" } },
      onRequest: [requireRole(db, "approver"), csrf],
      schema: {
        params: MilestoneIdParams,
        body: ApprovePayoutRequest,
        response: {
          200: ApprovePayoutResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const outcome = await approvePayout(db, chain, request.user?.id ?? "", request.params.id);
      if (outcome.kind === "not_found") {
        return reply.status(404).send({ error: "Not found", requestId: request.id });
      }
      if (outcome.kind === "forbidden") {
        return reply.status(403).send({ error: "Forbidden", requestId: request.id });
      }
      if (outcome.kind === "wrong_state") {
        return reply.status(409).send({ error: WRONG_PAYOUT_STATE, requestId: request.id });
      }
      return {
        payoutId: outcome.payoutId,
        milestoneId: outcome.milestoneId,
        state: outcome.state,
      };
    },
  );

  app.post(
    "/payouts/:id/retry",
    {
      config: { rateLimit: { max: APPROVE_LIMIT, timeWindow: "1 minute" } },
      onRequest: [requireRole(db, "approver"), csrf],
      schema: {
        params: PayoutIdParams,
        body: RetryPayoutRequest,
        response: {
          200: RetryPayoutResponse,
          404: ErrorResponse,
          409: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const outcome = await retryPayout(db, request.user?.id ?? "", request.params.id);
      if (outcome.kind === "not_found") {
        return reply.status(404).send({ error: "Not found", requestId: request.id });
      }
      if (outcome.kind === "wrong_state") {
        return reply.status(409).send({ error: WRONG_RETRY_STATE, requestId: request.id });
      }
      return { payoutId: outcome.payoutId, state: "pending" as const };
    },
  );

  app.post(
    "/deals/:id/refund",
    {
      config: { rateLimit: { max: APPROVE_LIMIT, timeWindow: "1 minute" } },
      onRequest: [requireRole(db, "approver"), csrf],
      schema: {
        params: DealIdParams,
        body: RefundDealRequest,
        response: {
          200: RefundDealResponse,
          404: ErrorResponse,
          409: ErrorResponse,
        },
      },
    },
    async (request, reply) => {
      const outcome = await refundDeal(db, chain, request.user?.id ?? "", request.params.id);
      if (outcome.kind === "not_found") {
        return reply.status(404).send({ error: "Not found", requestId: request.id });
      }
      if (outcome.kind === "wrong_state") {
        return reply.status(409).send({ error: WRONG_REFUND_STATE, requestId: request.id });
      }
      return { dealId: outcome.dealId, state: outcome.state };
    },
  );
  done();
};
