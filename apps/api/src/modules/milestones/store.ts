import { schema, type Database } from "@escrow-lab/db";
import type { DealMilestoneResponse, MilestoneResponse } from "@escrow-lab/shared";
import { and, asc, eq } from "drizzle-orm";
import { recordAuditEvent } from "../audit/index.ts";

export interface NewMilestone {
  title: string;
  amountMinor: number;
}

type Writer = Pick<Database, "insert">;

/** Adds the Milestones of a new Deal, in order, all `pending`. */
export async function insertMilestones(
  db: Writer,
  dealId: string,
  items: readonly NewMilestone[],
): Promise<MilestoneResponse[]> {
  return db
    .insert(schema.milestones)
    .values(
      items.map((item, index) => ({
        dealId,
        position: index + 1,
        title: item.title,
        amountMinor: item.amountMinor,
        state: "pending" as const,
      })),
    )
    .returning({
      id: schema.milestones.id,
      position: schema.milestones.position,
      title: schema.milestones.title,
      amountMinor: schema.milestones.amountMinor,
      state: schema.milestones.state,
      evidenceText: schema.milestones.evidenceText,
      rejectionReason: schema.milestones.rejectionReason,
    });
}

/** The Milestones of a Deal with the state of each Payout. A confirmed Payout is paid at its ledger entry time. */
export async function listMilestones(
  db: Database,
  dealId: string,
): Promise<DealMilestoneResponse[]> {
  const rows = await db
    .select({
      id: schema.milestones.id,
      position: schema.milestones.position,
      title: schema.milestones.title,
      amountMinor: schema.milestones.amountMinor,
      state: schema.milestones.state,
      evidenceText: schema.milestones.evidenceText,
      rejectionReason: schema.milestones.rejectionReason,
      payoutState: schema.payouts.state,
      sellerReference: schema.payouts.sellerReference,
      paidAt: schema.ledgerEntries.createdAt,
    })
    .from(schema.milestones)
    .leftJoin(schema.payouts, eq(schema.payouts.milestoneId, schema.milestones.id))
    .leftJoin(
      schema.ledgerEntries,
      and(
        eq(schema.ledgerEntries.dealId, schema.milestones.dealId),
        eq(schema.ledgerEntries.kind, "payout"),
        eq(schema.ledgerEntries.chainTxId, schema.payouts.chainTxId),
      ),
    )
    .where(eq(schema.milestones.dealId, dealId))
    .orderBy(asc(schema.milestones.position));
  return rows.map(({ payoutState, paidAt, sellerReference, ...milestone }) => ({
    ...milestone,
    payout:
      payoutState === null
        ? null
        : { state: payoutState, paidAt: paidAt?.toISOString() ?? null, sellerReference },
  }));
}

/** Opens the first Milestone of a funded Deal: `pending` becomes `awaiting_evidence`. */
export async function openFirstMilestone(
  db: Pick<Database, "update">,
  dealId: string,
): Promise<void> {
  await db
    .update(schema.milestones)
    .set({ state: "awaiting_evidence" })
    .where(and(eq(schema.milestones.dealId, dealId), eq(schema.milestones.position, 1)));
}

const milestoneColumns = {
  id: schema.milestones.id,
  position: schema.milestones.position,
  title: schema.milestones.title,
  amountMinor: schema.milestones.amountMinor,
  state: schema.milestones.state,
  evidenceText: schema.milestones.evidenceText,
  rejectionReason: schema.milestones.rejectionReason,
};

export type MilestoneAction =
  | { kind: "send_evidence"; sellerId: string; evidenceText: string }
  | { kind: "accept"; buyerId: string }
  | { kind: "reject"; buyerId: string; reason: string };

export type MilestoneOutcome =
  { kind: "done"; milestone: MilestoneResponse } | { kind: "not_found" } | { kind: "wrong_state" };

/**
 * Applies one evidence action. The Milestone is found through a Deal that the user owns in the
 * right role, and its row is locked. The state change and the audit event are one transaction.
 */
export async function applyMilestoneAction(
  db: Database,
  milestoneId: string,
  action: MilestoneAction,
): Promise<MilestoneOutcome> {
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({
        dealId: schema.milestones.dealId,
        state: schema.milestones.state,
        dealState: schema.deals.state,
      })
      .from(schema.milestones)
      .innerJoin(schema.deals, eq(schema.deals.id, schema.milestones.dealId))
      .where(
        and(
          eq(schema.milestones.id, milestoneId),
          action.kind === "send_evidence"
            ? eq(schema.deals.sellerId, action.sellerId)
            : eq(schema.deals.buyerId, action.buyerId),
        ),
      )
      .for("update", { of: schema.milestones });
    if (found === undefined) return { kind: "not_found" };
    const required = action.kind === "send_evidence" ? "awaiting_evidence" : "evidence_sent";
    if (found.dealState !== "funded" || found.state !== required) return { kind: "wrong_state" };

    const changes =
      action.kind === "send_evidence"
        ? { state: "evidence_sent" as const, evidenceText: action.evidenceText }
        : action.kind === "accept"
          ? { state: "accepted" as const }
          : { state: "awaiting_evidence" as const, rejectionReason: action.reason };
    const [milestone] = await tx
      .update(schema.milestones)
      .set(changes)
      .where(eq(schema.milestones.id, milestoneId))
      .returning(milestoneColumns);
    if (milestone === undefined) throw new Error("The Milestone was not saved");
    await recordAuditEvent(tx, {
      userId: action.kind === "send_evidence" ? action.sellerId : action.buyerId,
      action: action.kind,
      dealId: found.dealId,
    });
    return { kind: "done", milestone };
  });
}

/**
 * Marks a Milestone `paid` and opens the next one of its Deal. Returns `last` when the Deal has no
 * next Milestone.
 */
export async function markPaidAndOpenNext(
  db: Pick<Database, "update">,
  milestoneId: string,
): Promise<{ dealId: string; next: "opened" | "last" }> {
  const [paid] = await db
    .update(schema.milestones)
    .set({ state: "paid" })
    .where(eq(schema.milestones.id, milestoneId))
    .returning({ dealId: schema.milestones.dealId, position: schema.milestones.position });
  if (paid === undefined) throw new Error("The Milestone was not saved");
  const opened = await db
    .update(schema.milestones)
    .set({ state: "awaiting_evidence" })
    .where(
      and(
        eq(schema.milestones.dealId, paid.dealId),
        eq(schema.milestones.position, paid.position + 1),
        eq(schema.milestones.state, "pending"),
      ),
    )
    .returning({ id: schema.milestones.id });
  return { dealId: paid.dealId, next: opened.length > 0 ? "opened" : "last" };
}
