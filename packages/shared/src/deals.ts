import { z } from "zod";

export const MAX_MILESTONES = 10;
/** £1,000,000 in minor units. */
export const MAX_TOTAL_MINOR = 100_000_000;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

export const MILESTONES_MUST_ADD_UP = "The Milestones must add up to the total.";
export const SELLER_MUST_BE_SELLER = "The Seller must be a user with the Seller role.";

const Minor = z.number().int().min(1).max(MAX_TOTAL_MINOR);

export const DealState = z.enum([
  "draft",
  "funding",
  "funding_failed",
  "funded",
  "completed",
  "cancelled",
  "refunding",
  "refund_failed",
  "refunded",
]);
export type DealState = z.infer<typeof DealState>;

export const MilestoneState = z.enum([
  "pending",
  "awaiting_evidence",
  "evidence_sent",
  "accepted",
  "paid",
]);
export type MilestoneState = z.infer<typeof MilestoneState>;

export const CreateDealRequest = z
  .object({
    sellerId: z.uuid(),
    title: z.string().trim().min(1).max(100),
    totalMinor: Minor,
    milestones: z
      .array(z.object({ title: z.string().trim().min(1).max(100), amountMinor: Minor }).strict())
      .min(1)
      .max(MAX_MILESTONES),
  })
  .strict();
export type CreateDealRequest = z.infer<typeof CreateDealRequest>;

export const MilestoneResponse = z
  .object({
    id: z.uuid(),
    position: z.number().int().min(1),
    title: z.string(),
    amountMinor: z.number().int(),
    state: MilestoneState,
    evidenceText: z.string().nullable(),
    rejectionReason: z.string().nullable(),
  })
  .strict();
export type MilestoneResponse = z.infer<typeof MilestoneResponse>;

export const DealSummary = z
  .object({
    id: z.uuid(),
    title: z.string(),
    buyerId: z.uuid(),
    buyerName: z.string(),
    sellerId: z.uuid(),
    sellerName: z.string(),
    totalMinor: z.number().int(),
    currency: z.literal("GBP"),
    state: DealState,
    createdAt: z.string(),
  })
  .strict();
export type DealSummary = z.infer<typeof DealSummary>;

export const DealResponse = DealSummary.extend({
  milestones: z.array(MilestoneResponse),
}).strict();
export type DealResponse = z.infer<typeof DealResponse>;

export const ListDealsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ListDealsQuery = z.infer<typeof ListDealsQuery>;

export const DealListResponse = z
  .object({
    deals: z.array(DealSummary),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .strict();
export type DealListResponse = z.infer<typeof DealListResponse>;

export const DealIdParams = z.object({ id: z.uuid() }).strict();

export const PAYMENT_FAILED = "The payment failed. Try again.";
export const WRONG_DEAL_STATE = "The Deal is not in the right state for this action.";

export const MAX_EVIDENCE_LENGTH = 2000;
export const MAX_REJECTION_REASON_LENGTH = 500;

export const MilestoneIdParams = z.object({ id: z.uuid() }).strict();

export const SendEvidenceRequest = z
  .object({ evidenceText: z.string().trim().min(1).max(MAX_EVIDENCE_LENGTH) })
  .strict();
export type SendEvidenceRequest = z.infer<typeof SendEvidenceRequest>;

export const RejectEvidenceRequest = z
  .object({ reason: z.string().trim().min(1).max(MAX_REJECTION_REASON_LENGTH) })
  .strict();
export type RejectEvidenceRequest = z.infer<typeof RejectEvidenceRequest>;

/** The body of an accept request: no fields. */
export const AcceptEvidenceRequest = z.object({}).strict();

export const WRONG_MILESTONE_STATE = "The Milestone is not in the right state for this action.";
