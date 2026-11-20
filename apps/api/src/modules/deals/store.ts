import { schema, type Database } from "@escrow-lab/db";
import type {
  CreateDealRequest,
  DealResponse,
  DealSummary,
  PayoutHistoryItem,
} from "@escrow-lab/shared";
import { and, count, desc, eq, inArray, ne, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { recordAuditEvent } from "../audit/index.ts";
import { insertMilestones, listMilestones } from "../milestones/index.ts";

const buyers = alias(schema.users, "buyers");
const sellers = alias(schema.users, "sellers");

const summaryColumns = {
  id: schema.deals.id,
  title: schema.deals.title,
  buyerId: schema.deals.buyerId,
  buyerName: buyers.displayName,
  sellerId: schema.deals.sellerId,
  sellerName: sellers.displayName,
  totalMinor: schema.deals.totalMinor,
  currency: schema.deals.currency,
  state: schema.deals.state,
  createdAt: schema.deals.createdAt,
};

type SummaryRow = {
  [K in keyof typeof summaryColumns]: K extends "createdAt" ? Date : unknown;
} & Omit<DealSummary, "createdAt">;

function toSummary(row: SummaryRow): DealSummary {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

const ownedBy = (userId: string) =>
  or(eq(schema.deals.buyerId, userId), eq(schema.deals.sellerId, userId));

/** The default Deal list hides cancelled Deals. */
const inDefaultList = ne(schema.deals.state, "cancelled");

/** True when the user exists and has the Seller role. */
export async function isSeller(db: Database, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.id, userId), eq(schema.users.role, "seller")));
  return row !== undefined;
}

/** Writes the Deal, its Milestones and the `create_deal` audit event in one transaction. The Deal starts in `draft`. */
export async function createDeal(
  db: Database,
  buyerId: string,
  request: CreateDealRequest,
): Promise<string> {
  return db.transaction(async (tx) => {
    const [deal] = await tx
      .insert(schema.deals)
      .values({
        buyerId,
        sellerId: request.sellerId,
        title: request.title,
        totalMinor: request.totalMinor,
        state: "draft",
      })
      .returning({ id: schema.deals.id });
    if (deal === undefined) throw new Error("The Deal was not saved");
    await insertMilestones(tx, deal.id, request.milestones);
    await recordAuditEvent(tx, { userId: buyerId, action: "create_deal", dealId: deal.id });
    return deal.id;
  });
}

/** One page of the Deals where the user is the Buyer or the Seller, newest first. */
export async function listDeals(
  db: Database,
  userId: string,
  limit: number,
  offset: number,
): Promise<{ deals: DealSummary[]; total: number }> {
  const rows = await db
    .select(summaryColumns)
    .from(schema.deals)
    .innerJoin(buyers, eq(buyers.id, schema.deals.buyerId))
    .innerJoin(sellers, eq(sellers.id, schema.deals.sellerId))
    .where(and(ownedBy(userId), inDefaultList))
    .orderBy(desc(schema.deals.createdAt), desc(schema.deals.id))
    .limit(limit)
    .offset(offset);
  const [totals] = await db
    .select({ total: count() })
    .from(schema.deals)
    .where(and(ownedBy(userId), inDefaultList));
  return { deals: rows.map(toSummary), total: totals?.total ?? 0 };
}

/** The Deal with its Milestones, or undefined when the user is not its Buyer or Seller. */
export async function findDeal(
  db: Database,
  userId: string,
  dealId: string,
): Promise<DealResponse | undefined> {
  const [row] = await db
    .select(summaryColumns)
    .from(schema.deals)
    .innerJoin(buyers, eq(buyers.id, schema.deals.buyerId))
    .innerJoin(sellers, eq(sellers.id, schema.deals.sellerId))
    .where(and(eq(schema.deals.id, dealId), ownedBy(userId)));
  if (row === undefined) return undefined;
  return { ...toSummary(row), milestones: await listMilestones(db, dealId) };
}

/** One page of the Payouts on the Seller's own Deals, newest first. */
export async function listSellerPayouts(
  db: Database,
  sellerId: string,
  limit: number,
  offset: number,
): Promise<{ payouts: PayoutHistoryItem[]; total: number }> {
  const mine = eq(schema.deals.sellerId, sellerId);
  const rows = await db
    .select({
      id: schema.payouts.id,
      dealId: schema.deals.id,
      dealTitle: schema.deals.title,
      milestoneTitle: schema.milestones.title,
      amountMinor: schema.milestones.amountMinor,
      state: schema.payouts.state,
      createdAt: schema.payouts.createdAt,
    })
    .from(schema.payouts)
    .innerJoin(schema.milestones, eq(schema.milestones.id, schema.payouts.milestoneId))
    .innerJoin(schema.deals, eq(schema.deals.id, schema.milestones.dealId))
    .where(mine)
    .orderBy(desc(schema.payouts.createdAt), desc(schema.payouts.id))
    .limit(limit)
    .offset(offset);
  const [totals] = await db
    .select({ total: count() })
    .from(schema.payouts)
    .innerJoin(schema.milestones, eq(schema.milestones.id, schema.payouts.milestoneId))
    .innerJoin(schema.deals, eq(schema.deals.id, schema.milestones.dealId))
    .where(mine);
  return {
    payouts: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    total: totals?.total ?? 0,
  };
}

/**
 * Sets the Seller reference of the Payout of a Milestone, or clears it when `reference` is empty.
 * Returns false when the Seller has no such Payout on that Deal.
 */
export async function setPayoutReference(
  db: Database,
  sellerId: string,
  dealId: string,
  milestoneId: string,
  reference: string,
): Promise<boolean> {
  const owned = db
    .select({ id: schema.milestones.id })
    .from(schema.milestones)
    .innerJoin(schema.deals, eq(schema.deals.id, schema.milestones.dealId))
    .where(
      and(
        eq(schema.milestones.id, milestoneId),
        eq(schema.deals.id, dealId),
        eq(schema.deals.sellerId, sellerId),
      ),
    );
  const updated = await db
    .update(schema.payouts)
    .set({ sellerReference: reference === "" ? null : reference })
    .where(
      and(eq(schema.payouts.milestoneId, milestoneId), inArray(schema.payouts.milestoneId, owned)),
    )
    .returning({ id: schema.payouts.id });
  return updated.length > 0;
}
