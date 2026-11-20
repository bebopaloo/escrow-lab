import { schema, type Database } from "@escrow-lab/db";
import { eq } from "drizzle-orm";
import type { Chain } from "../../adapters/chain/index.ts";
import { recordAuditEvent } from "../audit/index.ts";
import { confirmPayout, createPendingPayout, hasPayout } from "../payout/index.ts";

export type ApproveOutcome =
  | { kind: "not_found" }
  /** The Milestone is not `accepted`, the Deal is not `funded`, or a Payout exists. */
  | { kind: "wrong_state" }
  /** The Approver is the Buyer or the Seller of the Deal. */
  | { kind: "forbidden" }
  | { kind: "done"; payoutId: string; milestoneId: string; state: "pending" | "confirmed" };

/**
 * Approves the Payout of an accepted Milestone. Transaction one locks the Deal row and the Milestone row, checks
 * Dual control and the state, and writes the `pending` Payout with its Idempotency key and the
 * audit event. The first transfer try then runs outside any transaction, with the Seller and the
 * amount from the database. A confirmed transfer finishes the Payout; any other result leaves it
 * `pending`.
 */
export async function approvePayout(
  db: Database,
  chain: Chain,
  approverId: string,
  milestoneId: string,
): Promise<ApproveOutcome> {
  const claim = await db.transaction(async (tx) => {
    // Lock the Deal row first, as `refundDeal` does, so that a refund and this approval run one
    // after the other. The Milestone row lock comes second in every path.
    const [owner] = await tx
      .select({ dealId: schema.milestones.dealId })
      .from(schema.milestones)
      .where(eq(schema.milestones.id, milestoneId));
    if (owner === undefined) return { kind: "not_found" } as const;
    await tx
      .select({ id: schema.deals.id })
      .from(schema.deals)
      .where(eq(schema.deals.id, owner.dealId))
      .for("update");
    const [found] = await tx
      .select({
        state: schema.milestones.state,
        amountMinor: schema.milestones.amountMinor,
        dealId: schema.milestones.dealId,
        dealState: schema.deals.state,
        buyerId: schema.deals.buyerId,
        sellerId: schema.deals.sellerId,
      })
      .from(schema.milestones)
      .innerJoin(schema.deals, eq(schema.deals.id, schema.milestones.dealId))
      .where(eq(schema.milestones.id, milestoneId))
      .for("update", { of: schema.milestones });
    if (found === undefined) return { kind: "not_found" } as const;
    if (found.buyerId === approverId || found.sellerId === approverId) {
      return { kind: "forbidden" } as const;
    }
    if (
      found.state !== "accepted" ||
      found.dealState !== "funded" ||
      (await hasPayout(tx, milestoneId))
    ) {
      return { kind: "wrong_state" } as const;
    }
    const payout = await createPendingPayout(tx, { milestoneId, approvedBy: approverId });
    await recordAuditEvent(tx, {
      userId: approverId,
      action: "approve_payout",
      dealId: found.dealId,
    });
    return {
      kind: "claimed",
      payout,
      sellerId: found.sellerId,
      amountMinor: found.amountMinor,
    } as const;
  });
  if (claim.kind !== "claimed") return claim;

  const transfer = await chain.transfer(claim.sellerId, claim.amountMinor, claim.payout.key);
  if (!transfer.ok) {
    return { kind: "done", payoutId: claim.payout.id, milestoneId, state: "pending" };
  }
  await confirmPayout(db, { payoutId: claim.payout.id, chainTxId: transfer.txId });
  return { kind: "done", payoutId: claim.payout.id, milestoneId, state: "confirmed" };
}
