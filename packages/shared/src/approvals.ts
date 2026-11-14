import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./deals.ts";

export const WRONG_PAYOUT_STATE = "The Payout cannot be approved in this state.";

export const WRONG_RETRY_STATE = "Only a failed Payout can be retried.";

export const PayoutState = z.enum(["pending", "confirmed", "failed"]);
export type PayoutState = z.infer<typeof PayoutState>;

/** The body of an approve request: no fields. The amount and the Seller come from the database. */
export const ApprovePayoutRequest = z.object({}).strict();

export const ApprovePayoutResponse = z
  .object({
    payoutId: z.uuid(),
    milestoneId: z.uuid(),
    state: PayoutState,
  })
  .strict();
export type ApprovePayoutResponse = z.infer<typeof ApprovePayoutResponse>;

export const PayoutIdParams = z.object({ id: z.uuid() }).strict();

/** The body of a retry request: no fields. The Payout keeps its Idempotency key. */
export const RetryPayoutRequest = z.object({}).strict();

export const RetryPayoutResponse = z.object({ payoutId: z.uuid(), state: PayoutState }).strict();
export type RetryPayoutResponse = z.infer<typeof RetryPayoutResponse>;

const QueueBase = { dealId: z.uuid(), dealTitle: z.string() };

/** One entry of the approval queue. */
export const ApprovalItem = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("milestone"),
      id: z.uuid(),
      ...QueueBase,
      title: z.string(),
      position: z.number().int().min(1),
      amountMinor: z.number().int(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("failed_payout"),
      id: z.uuid(),
      ...QueueBase,
      title: z.string(),
      position: z.number().int().min(1),
      amountMinor: z.number().int(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("funding_failed"),
      id: z.uuid(),
      ...QueueBase,
      totalMinor: z.number().int(),
    })
    .strict(),
]);
export type ApprovalItem = z.infer<typeof ApprovalItem>;

export const ApprovalQueueQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ApprovalQueueQuery = z.infer<typeof ApprovalQueueQuery>;

export const ApprovalQueueResponse = z
  .object({
    items: z.array(ApprovalItem),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .strict();
export type ApprovalQueueResponse = z.infer<typeof ApprovalQueueResponse>;
