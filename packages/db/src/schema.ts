// Drizzle tables go here. Run `pnpm db:generate` after each change and commit the
// generated migration with it.
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    displayName: text("display_name").notNull(),
    role: text("role", { enum: ["buyer", "seller", "approver"] }).notNull(),
    /** Goes up on sign-out. A session made at an older version is refused. */
    sessionVersion: integer("session_version").notNull().default(0),
  },
  (table) => [check("users_role_check", sql`${table.role} in ('buyer', 'seller', 'approver')`)],
);

/** Insert only: the migration adds a trigger that refuses UPDATE and DELETE. */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    action: text("action").notNull(),
    // No foreign key yet: the deals table does not exist.
    dealId: uuid("deal_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_events_user_id_idx").on(table.userId)],
);

export const deals = pgTable(
  "deals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    buyerId: uuid("buyer_id")
      .notNull()
      .references(() => users.id),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => users.id),
    totalMinor: integer("total_minor").notNull(),
    currency: text("currency", { enum: ["GBP"] })
      .notNull()
      .default("GBP"),
    state: text("state", {
      enum: ["draft", "funding", "funding_failed", "funded", "completed"],
    })
      .notNull()
      .default("draft"),
    fundingIdempotencyKey: text("funding_idempotency_key"),
    fundingAttempts: integer("funding_attempts").notNull().default(0),
    nextFundingTryAt: timestamp("next_funding_try_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("deals_buyer_id_idx").on(table.buyerId),
    index("deals_seller_id_idx").on(table.sellerId),
    check("deals_total_check", sql`${table.totalMinor} between 1 and 100000000`),
    check("deals_currency_check", sql`${table.currency} = 'GBP'`),
    check(
      "deals_state_check",
      sql`${table.state} in ('draft', 'funding', 'funding_failed', 'funded', 'completed')`,
    ),
  ],
);

export const milestones = pgTable(
  "milestones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id")
      .notNull()
      .references(() => deals.id),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    state: text("state", {
      enum: ["pending", "awaiting_evidence", "evidence_sent", "accepted", "paid"],
    })
      .notNull()
      .default("pending"),
    evidenceText: text("evidence_text"),
    rejectionReason: text("rejection_reason"),
  },
  (table) => [
    unique("milestones_deal_position_unique").on(table.dealId, table.position),
    check("milestones_amount_check", sql`${table.amountMinor} >= 1`),
    check(
      "milestones_state_check",
      sql`${table.state} in ('pending', 'awaiting_evidence', 'evidence_sent', 'accepted', 'paid')`,
    ),
  ],
);
