import { schema, type Database } from "@escrow-lab/db";
import { and, asc, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { Chain } from "../../adapters/chain/index.ts";
import { recordAuditEvent } from "../audit/index.ts";
import { confirmPayout } from "./store.ts";

export const MAX_PAYOUT_TRIES = 5;
const FIRST_WAIT_MS = 1_000;
const LEASE_MS = 30_000;
const BATCH_SIZE = 50;

interface Claimed {
  id: string;
  key: string;
  attempts: number;
  sellerId: string;
  amountMinor: number;
}

export interface PayoutRetryOptions {
  db: Database;
  chain: Chain;
  now: () => Date;
}

/**
 * The part of the retry job for Payouts in `pending`. Each try sends the transfer again with the
 * Payout's stored Idempotency key, so the chain returns its first transfer.
 */
export function createPayoutRetry({ db, chain, now }: PayoutRetryOptions) {
  const due = (at: Date) =>
    and(
      eq(schema.payouts.state, "pending"),
      // An express Payout has no approver until an Approver approves it: the job never sends it.
      isNotNull(schema.payouts.approvedBy),
      or(isNull(schema.payouts.nextTryAt), lte(schema.payouts.nextTryAt, at)),
    );

  /** Takes a row lock on the Payout, skips it when another try holds it, and leases it. */
  async function claim(payoutId: string): Promise<Claimed | undefined> {
    const at = now();
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: schema.payouts.id,
          key: schema.payouts.idempotencyKey,
          attempts: schema.payouts.attempts,
          sellerId: schema.deals.sellerId,
          amountMinor: schema.milestones.amountMinor,
        })
        .from(schema.payouts)
        .innerJoin(schema.milestones, eq(schema.milestones.id, schema.payouts.milestoneId))
        .innerJoin(schema.deals, eq(schema.deals.id, schema.milestones.dealId))
        .where(and(eq(schema.payouts.id, payoutId), due(at)))
        .for("update", { of: schema.payouts, skipLocked: true });
      if (row === undefined) return undefined;
      await tx
        .update(schema.payouts)
        .set({ nextTryAt: new Date(at.getTime() + LEASE_MS) })
        .where(eq(schema.payouts.id, row.id));
      return row;
    });
  }

  async function recordFailure(payout: Claimed): Promise<void> {
    const attempts = payout.attempts + 1;
    const waitMs = FIRST_WAIT_MS * 2 ** (attempts - 1);
    await db.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.payouts)
        .set(
          attempts >= MAX_PAYOUT_TRIES
            ? { state: "failed", attempts, nextTryAt: null }
            : { attempts, nextTryAt: new Date(now().getTime() + waitMs) },
        )
        .where(
          and(
            eq(schema.payouts.id, payout.id),
            eq(schema.payouts.state, "pending"),
            eq(schema.payouts.idempotencyKey, payout.key),
          ),
        )
        .returning({
          approvedBy: schema.payouts.approvedBy,
          milestoneId: schema.payouts.milestoneId,
        });
      if (row?.approvedBy == null || attempts < MAX_PAYOUT_TRIES) return;
      const [milestone] = await tx
        .select({ dealId: schema.milestones.dealId })
        .from(schema.milestones)
        .where(eq(schema.milestones.id, row.milestoneId));
      await recordAuditEvent(tx, {
        userId: row.approvedBy,
        action: "payout_failed",
        ...(milestone === undefined ? {} : { dealId: milestone.dealId }),
      });
    });
  }

  async function tryPayout(payout: Claimed): Promise<void> {
    const transfer = await chain.transfer(payout.sellerId, payout.amountMinor, payout.key);
    if (!transfer.ok) {
      await recordFailure(payout);
      return;
    }
    await confirmPayout(db, { payoutId: payout.id, chainTxId: transfer.txId });
  }

  return {
    /** One pass over the Payouts that are due. `dealIds` limits it to these Deals. */
    async run(dealIds?: string[]): Promise<void> {
      const rows = await db
        .select({ id: schema.payouts.id })
        .from(schema.payouts)
        .innerJoin(schema.milestones, eq(schema.milestones.id, schema.payouts.milestoneId))
        .where(
          and(
            due(now()),
            dealIds === undefined ? undefined : inArray(schema.milestones.dealId, dealIds),
          ),
        )
        .orderBy(asc(schema.payouts.nextTryAt))
        .limit(BATCH_SIZE);
      for (const { id } of rows) {
        const payout = await claim(id);
        if (payout !== undefined) await tryPayout(payout);
      }
    },
  };
}
