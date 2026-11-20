import { randomUUID } from "node:crypto";
import { schema, type Database } from "@escrow-lab/db";
import { eq } from "drizzle-orm";
import type { Chain } from "../../adapters/chain/index.ts";
import { recordAuditEvent } from "../audit/index.ts";
import { confirmRefund } from "../payout/index.ts";

export type RefundOutcome =
  | { kind: "not_found" }
  /** The Deal is not `funded`, or one of its Milestones has a Payout. */
  | { kind: "wrong_state" }
  | { kind: "done"; dealId: string; state: "refunding" | "refunded" };

/**
 * Refunds a funded Deal that has no Payout, in three steps. Transaction one locks the Deal row,
 * checks the state and that no Payout exists, sets the Deal `refunding` with a new Idempotency
 * key and writes the `refund_deal` audit event. The chain call runs outside any transaction. A
 * confirmed refund finishes the Deal; any other result leaves it `refunding` for the retry job,
 * which sends the same key.
 */
export async function refundDeal(
  db: Database,
  chain: Chain,
  approverId: string,
  dealId: string,
): Promise<RefundOutcome> {
  const claim = await db.transaction(async (tx) => {
    const [deal] = await tx
      .select({
        state: schema.deals.state,
        buyerId: schema.deals.buyerId,
        totalMinor: schema.deals.totalMinor,
      })
      .from(schema.deals)
      .where(eq(schema.deals.id, dealId))
      .for("update");
    if (deal === undefined) return { kind: "not_found" } as const;
    const [payout] = await tx
      .select({ id: schema.payouts.id })
      .from(schema.payouts)
      .innerJoin(schema.milestones, eq(schema.milestones.id, schema.payouts.milestoneId))
      .where(eq(schema.milestones.dealId, dealId))
      .limit(1);
    if (deal.state !== "funded" || payout !== undefined) return { kind: "wrong_state" } as const;
    const key = randomUUID();
    await tx
      .update(schema.deals)
      .set({ state: "refunding", refundIdempotencyKey: key, refundAttempts: 0 })
      .where(eq(schema.deals.id, dealId));
    await recordAuditEvent(tx, { userId: approverId, action: "refund_deal", dealId });
    return { kind: "claimed", key, buyerId: deal.buyerId, totalMinor: deal.totalMinor } as const;
  });
  if (claim.kind !== "claimed") return claim;

  const result = await chain.refund(claim.buyerId, claim.totalMinor, claim.key);
  if (!result.ok) return { kind: "done", dealId, state: "refunding" };
  await confirmRefund(db, { dealId, key: claim.key, chainTxId: result.txId });
  return { kind: "done", dealId, state: "refunded" };
}
