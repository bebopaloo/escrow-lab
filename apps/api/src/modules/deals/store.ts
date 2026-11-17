import { schema, type Database } from "@escrow-lab/db";
import type { CreateDealRequest, DealResponse, DealSummary } from "@escrow-lab/shared";
import { and, count, desc, eq, ne, or } from "drizzle-orm";
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
