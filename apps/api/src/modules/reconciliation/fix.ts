import { schema, type Database } from "@escrow-lab/db";
import { eq } from "drizzle-orm";
import { recordAuditEvent } from "../audit/index.ts";
import { completeDeal } from "../deals/index.ts";
import { recordPayout } from "../ledger/index.ts";
import { markPaidAndOpenNext } from "../milestones/index.ts";

export type FixOutcome =
  | { kind: "not_found" }
  /** The mismatch is closed, has another kind or no Payout, or the Payout is not `failed`. */
  | { kind: "wrong_state" }
  | { kind: "done"; mismatchId: string; payoutId: string };

/**
 * Fixes a `missing_in_ledger` mismatch of a `failed` Payout. One transaction locks the mismatch and
 * the Payout rows, records the ledger Payout from the chain transaction, sets the Payout
 * `confirmed`, marks the Milestone `paid`, opens the next Milestone or completes the Deal, closes
 * the mismatch as fixed by the Approver, and writes the `fix_mismatch` audit event.
 */
export async function fixMismatch(
  db: Database,
  approverId: string,
  mismatchId: string,
): Promise<FixOutcome> {
  return db.transaction(async (tx) => {
    const [mismatch] = await tx
      .select()
      .from(schema.mismatches)
      .where(eq(schema.mismatches.id, mismatchId))
      .for("update");
    if (mismatch === undefined) return { kind: "not_found" } as const;
    if (
      mismatch.closedAt !== null ||
      mismatch.kind !== "missing_in_ledger" ||
      mismatch.payoutId === null ||
      mismatch.chainAmountMinor === null
    ) {
      return { kind: "wrong_state" } as const;
    }
    const [payout] = await tx
      .select({ state: schema.payouts.state, milestoneId: schema.payouts.milestoneId })
      .from(schema.payouts)
      .where(eq(schema.payouts.id, mismatch.payoutId))
      .for("update");
    if (payout?.state !== "failed") return { kind: "wrong_state" } as const;

    await recordPayout(tx, {
      dealId: mismatch.dealId,
      amountMinor: mismatch.chainAmountMinor,
      chainTxId: mismatch.chainTxId,
    });
    await tx
      .update(schema.payouts)
      .set({ state: "confirmed", chainTxId: mismatch.chainTxId, nextTryAt: null })
      .where(eq(schema.payouts.id, mismatch.payoutId));
    const { next } = await markPaidAndOpenNext(tx, payout.milestoneId);
    if (next === "last") await completeDeal(tx, mismatch.dealId);
    await tx
      .update(schema.mismatches)
      .set({ closedAt: new Date(), fixedBy: approverId })
      .where(eq(schema.mismatches.id, mismatchId));
    await recordAuditEvent(tx, {
      userId: approverId,
      action: "fix_mismatch",
      dealId: mismatch.dealId,
    });
    return { kind: "done", mismatchId, payoutId: mismatch.payoutId } as const;
  });
}
