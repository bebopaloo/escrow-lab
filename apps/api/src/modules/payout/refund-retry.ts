import { schema, type Database } from "@escrow-lab/db";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { Chain } from "../../adapters/chain/index.ts";
import { confirmRefund } from "./refund.ts";

export const MAX_REFUND_TRIES = 5;
const FIRST_WAIT_MS = 1_000;
const LEASE_MS = 30_000;
const BATCH_SIZE = 50;

interface Claimed {
  id: string;
  key: string;
  attempts: number;
  buyerId: string;
  totalMinor: number;
}

export interface RefundRetryOptions {
  db: Database;
  chain: Chain;
  now: () => Date;
}

/**
 * The part of the retry job for Deals in `refunding`. Each try sends the refund again with the
 * Deal's stored Idempotency key, so the chain returns its first refund. The fifth failed try sets
 * the Deal `refund_failed`.
 */
export function createRefundRetry({ db, chain, now }: RefundRetryOptions) {
  const due = (at: Date) =>
    and(
      eq(schema.deals.state, "refunding"),
      or(isNull(schema.deals.nextRefundTryAt), lte(schema.deals.nextRefundTryAt, at)),
    );

  /** Takes a row lock on the Deal, skips it when another try holds it, and leases it. */
  async function claim(dealId: string): Promise<Claimed | undefined> {
    const at = now();
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: schema.deals.id,
          key: schema.deals.refundIdempotencyKey,
          attempts: schema.deals.refundAttempts,
          buyerId: schema.deals.buyerId,
          totalMinor: schema.deals.totalMinor,
        })
        .from(schema.deals)
        .where(and(eq(schema.deals.id, dealId), due(at)))
        .for("update", { skipLocked: true });
      if (row === undefined || row.key === null) return undefined;
      await tx
        .update(schema.deals)
        .set({ nextRefundTryAt: new Date(at.getTime() + LEASE_MS) })
        .where(eq(schema.deals.id, row.id));
      return { ...row, key: row.key };
    });
  }

  async function recordFailure(deal: Claimed): Promise<void> {
    const attempts = deal.attempts + 1;
    const waitMs = FIRST_WAIT_MS * 2 ** (attempts - 1);
    await db
      .update(schema.deals)
      .set(
        attempts >= MAX_REFUND_TRIES
          ? { state: "refund_failed", refundAttempts: attempts, nextRefundTryAt: null }
          : { refundAttempts: attempts, nextRefundTryAt: new Date(now().getTime() + waitMs) },
      )
      .where(
        and(
          eq(schema.deals.id, deal.id),
          eq(schema.deals.state, "refunding"),
          eq(schema.deals.refundIdempotencyKey, deal.key),
        ),
      );
  }

  async function tryDeal(deal: Claimed): Promise<void> {
    const result = await chain.refund(deal.buyerId, deal.totalMinor, deal.key);
    if (!result.ok) {
      await recordFailure(deal);
      return;
    }
    await confirmRefund(db, { dealId: deal.id, key: deal.key, chainTxId: result.txId });
  }

  return {
    /** One pass over the Deals that are due. `dealIds` limits it to these Deals. */
    async run(dealIds?: string[]): Promise<void> {
      const rows = await db
        .select({ id: schema.deals.id })
        .from(schema.deals)
        .where(
          and(due(now()), dealIds === undefined ? undefined : inArray(schema.deals.id, dealIds)),
        )
        .orderBy(asc(schema.deals.nextRefundTryAt))
        .limit(BATCH_SIZE);
      for (const { id } of rows) {
        const deal = await claim(id);
        if (deal !== undefined) await tryDeal(deal);
      }
    },
  };
}
