import { schema, type Database } from "@escrow-lab/db";
import type { ApprovalItem } from "@escrow-lab/shared";
import { and, count, eq, isNull, lt, notExists, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";

export interface QueuePage {
  items: ApprovalItem[];
  total: number;
}

/**
 * The work that waits for an Approver: accepted Milestones, failed Payouts and Deals in
 * `funding_failed`. One query pages the three sources together.
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

  const [rows, milestoneCount, payoutCount, dealCount] = await Promise.all([
    unionAll(milestoneRows, payoutRows, dealRows)
      .orderBy(sql`"kind"`, sql`"deal_title"`, sql`"id"`)
      .limit(limit)
      .offset(offset),
    db
      .select({ n: count() })
      .from(schema.milestones)
      .where(and(eq(schema.milestones.state, "accepted"), hasNoPayout)),
    db.select({ n: count() }).from(schema.payouts).where(eq(schema.payouts.state, "failed")),
    db.select({ n: count() }).from(schema.deals).where(eq(schema.deals.state, "funding_failed")),
  ]);

  const items = rows.map((row): ApprovalItem => {
    const base = { id: row.id, dealId: row.dealId, dealTitle: row.dealTitle };
    if (row.kind === "funding_failed") {
      return { kind: "funding_failed", ...base, totalMinor: row.amountMinor };
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
  const total = (milestoneCount[0]?.n ?? 0) + (payoutCount[0]?.n ?? 0) + (dealCount[0]?.n ?? 0);
  return { items, total };
}

const OLD_MISMATCH_MS = 24 * 60 * 60 * 1000;

/** The open mismatches that were found more than 24 hours before `now`. */
export async function countOldMismatches(db: Database, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - OLD_MISMATCH_MS);
  const [row] = await db
    .select({ n: count() })
    .from(schema.mismatches)
    .where(and(isNull(schema.mismatches.closedAt), lt(schema.mismatches.foundAt, cutoff)));
  return row?.n ?? 0;
}
