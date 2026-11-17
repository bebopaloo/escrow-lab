import { schema, type Database } from "@escrow-lab/db";
import type { MismatchItem } from "@escrow-lab/shared";
import { and, asc, count, eq, isNull, lt } from "drizzle-orm";

const OLD_AFTER_MS = 24 * 60 * 60 * 1000;

export interface MismatchPage {
  items: MismatchItem[];
  total: number;
  oldCount: number;
}

/** The open mismatches, oldest first, and the count of those found more than 24 hours ago. */
export async function listOpenMismatches(
  db: Database,
  limit: number,
  offset: number,
  now: Date = new Date(),
): Promise<MismatchPage> {
  const open = isNull(schema.mismatches.closedAt);
  const oldBefore = new Date(now.getTime() - OLD_AFTER_MS);
  const [rows, totals, olds] = await Promise.all([
    db
      .select({
        id: schema.mismatches.id,
        kind: schema.mismatches.kind,
        dealId: schema.mismatches.dealId,
        dealTitle: schema.deals.title,
        payoutId: schema.mismatches.payoutId,
        chainTxId: schema.mismatches.chainTxId,
        ledgerAmountMinor: schema.mismatches.ledgerAmountMinor,
        chainAmountMinor: schema.mismatches.chainAmountMinor,
        foundAt: schema.mismatches.foundAt,
      })
      .from(schema.mismatches)
      .innerJoin(schema.deals, eq(schema.deals.id, schema.mismatches.dealId))
      .where(open)
      .orderBy(asc(schema.mismatches.foundAt), asc(schema.mismatches.id))
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(schema.mismatches).where(open),
    db
      .select({ n: count() })
      .from(schema.mismatches)
      .where(and(open, lt(schema.mismatches.foundAt, oldBefore))),
  ]);
  return {
    items: rows.map((row) => ({ ...row, foundAt: row.foundAt.toISOString() })),
    total: totals[0]?.n ?? 0,
    oldCount: olds[0]?.n ?? 0,
  };
}
