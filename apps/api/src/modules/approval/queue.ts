import { schema, type Database } from "@escrow-lab/db";
import type { ApprovalItem } from "@escrow-lab/shared";
import { and, count, eq, notExists, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";

export interface QueuePage {
  items: ApprovalItem[];
  total: number;
}

/**
 * The work that waits for an Approver: accepted Milestones, failed Payouts, Deals in
 * `funding_failed`, funded Deals with no Payout (`refundable`) and Deals in `refund_failed`. One
 * query pages the five sources together.
 */
export async function listApprovalQueue(
  db: Database,
  limit: number,
  offset: number,
): Promise<QueuePage> {
  // A Milestone with a Payout is not approvable: a failed Payout shows as its own item.
  const hasNoPayout = notExists(
    db
      .select({ one: sql`1` })
      .from(schema.payouts)
      .where(eq(schema.payouts.milestoneId, schema.milestones.id)),
  );
  const milestoneRows = db
    .select({
      kind: sql<string>`'milestone'`.as("kind"),
      id: sql<string>`${schema.milestones.id}`.as("id"),
      dealId: sql<string>`${schema.deals.id}`.as("deal_id"),
      dealTitle: sql<string>`${schema.deals.title}`.as("deal_title"),
      title: sql<string | null>`${schema.milestones.title}`.as("title"),
      position: sql<number | null>`${schema.milestones.position}`.as("position"),
      amountMinor: sql<number>`${schema.milestones.amountMinor}`.as("amount_minor"),
    })
    .from(schema.milestones)
    .innerJoin(schema.deals, eq(schema.deals.id, schema.milestones.dealId))
    .where(and(eq(schema.milestones.state, "accepted"), hasNoPayout));
  const payoutRows = db
    .select({
      kind: sql<string>`'failed_payout'`.as("kind"),
      id: sql<string>`${schema.payouts.id}`.as("id"),
      dealId: sql<string>`${schema.deals.id}`.as("deal_id"),
      dealTitle: sql<string>`${schema.deals.title}`.as("deal_title"),
      title: sql<string | null>`${schema.milestones.title}`.as("title"),
      position: sql<number | null>`${schema.milestones.position}`.as("position"),
      amountMinor: sql<number>`${schema.milestones.amountMinor}`.as("amount_minor"),
    })
    .from(schema.payouts)
    .innerJoin(schema.milestones, eq(schema.milestones.id, schema.payouts.milestoneId))
    .innerJoin(schema.deals, eq(schema.deals.id, schema.milestones.dealId))
    .where(eq(schema.payouts.state, "failed"));
  const dealRows = db
    .select({
      kind: sql<string>`'funding_failed'`.as("kind"),
      id: sql<string>`${schema.deals.id}`.as("id"),
      dealId: sql<string>`${schema.deals.id}`.as("deal_id"),
      dealTitle: sql<string>`${schema.deals.title}`.as("deal_title"),
      title: sql<string | null>`null`.as("title"),
      position: sql<number | null>`null`.as("position"),
      amountMinor: sql<number>`${schema.deals.totalMinor}`.as("amount_minor"),
    })
    .from(schema.deals)
    .where(eq(schema.deals.state, "funding_failed"));

  const dealItems = (kind: string, where: SQL | undefined) =>
    db
      .select({
        kind: sql<string>`${kind}`.as("kind"),
        id: sql<string>`${schema.deals.id}`.as("id"),
        dealId: sql<string>`${schema.deals.id}`.as("deal_id"),
        dealTitle: sql<string>`${schema.deals.title}`.as("deal_title"),
        title: sql<string | null>`null`.as("title"),
        position: sql<number | null>`null`.as("position"),
        amountMinor: sql<number>`${schema.deals.totalMinor}`.as("amount_minor"),
      })
      .from(schema.deals)
      .where(where);
  const refundableWhere = and(
    eq(schema.deals.state, "funded"),
    notExists(
      db
        .select({ one: sql`1` })
        .from(schema.payouts)
        .innerJoin(schema.milestones, eq(schema.milestones.id, schema.payouts.milestoneId))
        .where(eq(schema.milestones.dealId, schema.deals.id)),
    ),
  );
  const refundFailedWhere = eq(schema.deals.state, "refund_failed");

  const [rows, milestoneCount, payoutCount, dealCount, refundableCount, refundFailedCount] =
    await Promise.all([
      unionAll(
        milestoneRows,
        payoutRows,
        dealRows,
        dealItems("refundable", refundableWhere),
        dealItems("refund_failed", refundFailedWhere),
      )
        .orderBy(sql`"kind"`, sql`"deal_title"`, sql`"id"`)
        .limit(limit)
        .offset(offset),
      db
        .select({ n: count() })
        .from(schema.milestones)
        .where(and(eq(schema.milestones.state, "accepted"), hasNoPayout)),
      db.select({ n: count() }).from(schema.payouts).where(eq(schema.payouts.state, "failed")),
      db.select({ n: count() }).from(schema.deals).where(eq(schema.deals.state, "funding_failed")),
      db.select({ n: count() }).from(schema.deals).where(refundableWhere),
      db.select({ n: count() }).from(schema.deals).where(refundFailedWhere),
    ]);

  const items = rows.map((row): ApprovalItem => {
    const base = { id: row.id, dealId: row.dealId, dealTitle: row.dealTitle };
    if (
      row.kind === "funding_failed" ||
      row.kind === "refundable" ||
      row.kind === "refund_failed"
    ) {
      return { kind: row.kind, ...base, totalMinor: row.amountMinor };
    }
    if (row.title === null || row.position === null) {
      throw new Error("A queue row has no Milestone");
    }
    return {
      kind: row.kind === "milestone" ? "milestone" : "failed_payout",
      ...base,
      title: row.title,
      position: row.position,
      amountMinor: row.amountMinor,
    };
  });
  const total = [milestoneCount, payoutCount, dealCount, refundableCount, refundFailedCount]
    .map((counted) => counted[0]?.n ?? 0)
    .reduce((sum, n) => sum + n, 0);
  return { items, total };
}
