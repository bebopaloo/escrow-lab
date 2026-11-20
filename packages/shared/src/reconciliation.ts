import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./deals.ts";

export const MismatchKind = z.enum(["missing_in_ledger", "missing_on_chain", "amount_differs"]);
export type MismatchKind = z.infer<typeof MismatchKind>;

/** One open difference between the ledger and the chain. */
export const MismatchItem = z
  .object({
    id: z.uuid(),
    kind: MismatchKind,
    dealId: z.uuid(),
    dealTitle: z.string(),
    payoutId: z.uuid().nullable(),
    chainTxId: z.string(),
    ledgerAmountMinor: z.number().int().nullable(),
    chainAmountMinor: z.number().int().nullable(),
    foundAt: z.iso.datetime(),
  })
  .strict();
export type MismatchItem = z.infer<typeof MismatchItem>;

export const MismatchListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type MismatchListQuery = z.infer<typeof MismatchListQuery>;

export const MismatchListResponse = z
  .object({
    items: z.array(MismatchItem),
    total: z.number().int(),
    /** The open mismatches that were found more than 24 hours ago. */
    oldCount: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .strict();
export type MismatchListResponse = z.infer<typeof MismatchListResponse>;

export const WRONG_FIX_STATE = "Only an open mismatch with a failed Payout can be fixed.";

export const MismatchIdParams = z.object({ id: z.uuid() }).strict();

/** The body of a fix request: no fields. The amount and the transaction come from the mismatch. */
export const FixMismatchRequest = z.object({}).strict();

export const FixMismatchResponse = z.object({ mismatchId: z.uuid(), payoutId: z.uuid() }).strict();
export type FixMismatchResponse = z.infer<typeof FixMismatchResponse>;
