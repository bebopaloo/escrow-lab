import { randomUUID } from "node:crypto";
import { schema, type Database } from "@escrow-lab/db";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
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
 * transaction that locks the Milestone. An Approver's Payout has its approver and goes with the
 * `approve_payout` audit event. An express Payout has no approver: `approveExpressPayout` sets it.
 */
export async function createPendingPayout(
  db: Pick<Database, "insert">,
  input: { milestoneId: string; approvedBy: string } | { milestoneId: string; express: true },
): Promise<PendingPayout> {
  const key = randomUUID();
  const [created] = await db
    .insert(schema.payouts)
    .values(
      "express" in input
        ? { milestoneId: input.milestoneId, express: true, idempotencyKey: key }
        : { milestoneId: input.milestoneId, approvedBy: input.approvedBy, idempotencyKey: key },
    )
    .returning({ id: schema.payouts.id });
  if (created === undefined) throw new Error("The Payout was not saved");
  return { id: created.id, key };
}

/**
 * Sets the approver of an express Payout that has none. It changes the row only while the Payout
 * is `pending` with no approver, so two Approvers cannot both claim it. Returns the Payout, or
 * `undefined` when there is nothing to approve.
 */
export async function approveExpressPayout(
  db: Pick<Database, "update">,
  input: { milestoneId: string; approverId: string },
): Promise<PendingPayout | undefined> {
  const [row] = await db
    .update(schema.payouts)
    .set({ approvedBy: input.approverId })
    .where(
      and(
        eq(schema.payouts.milestoneId, input.milestoneId),
        eq(schema.payouts.express, true),
        eq(schema.payouts.state, "pending"),
        isNull(schema.payouts.approvedBy),
      ),
    )
    .returning({ id: schema.payouts.id, key: schema.payouts.idempotencyKey });
  return row;
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
 * event. The amount comes from the Milestone row. A Payout that is not `pending` changes nothing.
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
      .where(
        and(
          eq(schema.payouts.id, input.payoutId),
          eq(schema.payouts.state, "pending"),
          // An express Payout with no approver never confirms ([CTRL-PAY-01]).
          isNotNull(schema.payouts.approvedBy),
        ),
      )
      .for("update", { of: schema.payouts });
    if (row === undefined || row.approvedBy === null) return false;
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
