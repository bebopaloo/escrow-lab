import { schema, type Database } from "@escrow-lab/db";
import { and, eq } from "drizzle-orm";
import { recordRefund } from "../ledger/index.ts";

/**
 * Call it when the chain confirms the refund. One transaction: the ledger refund and the Deal
 * `refunded`. The amount comes from the Deal row. A Deal that is not `refunding`, or that holds
 * another key, changes nothing.
 */
export async function confirmRefund(
  db: Database,
  input: { dealId: string; key: string; chainTxId: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [deal] = await tx
      .update(schema.deals)
      .set({ state: "refunded", nextRefundTryAt: null })
      .where(
        and(
          eq(schema.deals.id, input.dealId),
          eq(schema.deals.state, "refunding"),
          eq(schema.deals.refundIdempotencyKey, input.key),
        ),
      )
      .returning({ totalMinor: schema.deals.totalMinor });
    if (deal === undefined) return false;
    await recordRefund(tx, {
      dealId: input.dealId,
      amountMinor: deal.totalMinor,
      chainTxId: input.chainTxId,
    });
    return true;
  });
}
