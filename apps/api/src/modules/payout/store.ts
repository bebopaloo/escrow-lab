import { randomUUID } from "node:crypto";
import { schema, type Database } from "@escrow-lab/db";
import { and, eq } from "drizzle-orm";
import { recordAuditEvent } from "../audit/index.ts";
import { completeDeal } from "../deals/index.ts";
import { recordPayout } from "../ledger/index.ts";
import { markPaidAndOpenNext } from "../milestones/index.ts";

export interface PendingPayout {
  id: string;
  key: string;
}

/**
 * Writes the `pending` Payout of a Milestone with a new Idempotency key. Call it in the
 * transaction that locks the Milestone and writes the `approve_payout` audit event.
 */
export async function createPendingPayout(
  db: Pick<Database, "insert">,
  input: { milestoneId: string; approvedBy: string },
): Promise<PendingPayout> {
  const key = randomUUID();
  const [created] = await db
    .insert(schema.payouts)
    .values({ milestoneId: input.milestoneId, approvedBy: input.approvedBy, idempotencyKey: key })
    .returning({ id: schema.payouts.id });
  if (created === undefined) throw new Error("The Payout was not saved");
  return { id: created.id, key };
}

/** Whether a Payout exists for the Milestone. */
export async function hasPayout(
  db: Pick<Database, "select">,
  milestoneId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.payouts.id })
    .from(schema.payouts)
    .where(eq(schema.payouts.milestoneId, milestoneId));
  return rows.length > 0;
}

/**
 * Call it when the chain confirms the transfer. One transaction: the ledger Payout, the Payout
 * `confirmed`, the Milestone `paid`, the next Milestone open or the Deal `completed`, and the audit
 * event. The amount comes from the Milestone row. A Payout that is not `pending`, or a Deal that is not `funded`, changes nothing.
 */
export async function confirmPayout(
  db: Database,
  input: { payoutId: string; chainTxId: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        milestoneId: schema.payouts.milestoneId,
        approvedBy: schema.payouts.approvedBy,
        amountMinor: schema.milestones.amountMinor,
        dealId: schema.milestones.dealId,
      })
      .from(schema.payouts)
      .innerJoin(schema.milestones, eq(schema.milestones.id, schema.payouts.milestoneId))
      .where(and(eq(schema.payouts.id, input.payoutId), eq(schema.payouts.state, "pending")))
      .for("update", { of: schema.payouts });
    if (row === undefined) return false;
    const [deal] = await tx
      .select({ state: schema.deals.state })
      .from(schema.deals)
      .where(eq(schema.deals.id, row.dealId))
      .for("update");
    if (deal?.state !== "funded") return false;
    await tx
      .update(schema.payouts)
      .set({ state: "confirmed", chainTxId: input.chainTxId, nextTryAt: null })
      .where(eq(schema.payouts.id, input.payoutId));
    await recordPayout(tx, {
      dealId: row.dealId,
      amountMinor: row.amountMinor,
      chainTxId: input.chainTxId,
    });
    const { next } = await markPaidAndOpenNext(tx, row.milestoneId);
    if (next === "last") await completeDeal(tx, row.dealId);
    await recordAuditEvent(tx, {
      userId: row.approvedBy,
      action: "payout_confirmed",
      dealId: row.dealId,
    });
    return true;
  });
}
