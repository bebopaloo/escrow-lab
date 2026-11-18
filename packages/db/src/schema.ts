// Drizzle tables go here. Run `pnpm db:generate` after each change and commit the
// generated migration with it.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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
      enum: [
        "draft",
        "funding",
        "funding_failed",
        "funded",
        "completed",
        "cancelled",
        "refunding",
        "refund_failed",
        "refunded",
      ],
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
      sql`${table.state} in ('draft', 'funding', 'funding_failed', 'funded', 'completed', 'cancelled', 'refunding', 'refund_failed', 'refunded')`,
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

/** Insert only: the migration adds a trigger that refuses UPDATE and DELETE. */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id")
      .notNull()
      .references(() => deals.id),
    kind: text("kind", { enum: ["deposit", "payout"] }).notNull(),
    amountMinor: integer("amount_minor").notNull(),
    chainTxId: text("chain_tx_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("ledger_entries_deal_id_idx").on(table.dealId),
    // A Deal has one deposit.
    uniqueIndex("ledger_entries_one_deposit_idx")
      .on(table.dealId)
      .where(sql`${table.kind} = 'deposit'`),
    check("ledger_entries_kind_check", sql`${table.kind} in ('deposit', 'payout')`),
    check("ledger_entries_amount_check", sql`${table.amountMinor} >= 1`),
  ],
);

/** One Payout for each Milestone. The key goes to the chain on every try, so it cannot pay twice. */
export const payouts = pgTable(
  "payouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    milestoneId: uuid("milestone_id")
      .notNull()
      .references(() => milestones.id),
    idempotencyKey: text("idempotency_key").notNull(),
    state: text("state", { enum: ["pending", "confirmed", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextTryAt: timestamp("next_try_at", { withTimezone: true }),
    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => users.id),
    chainTxId: text("chain_tx_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("payouts_milestone_unique").on(table.milestoneId),
    unique("payouts_idempotency_key_unique").on(table.idempotencyKey),
    index("payouts_approved_by_idx").on(table.approvedBy),
    index("payouts_state_idx").on(table.state),
    check("payouts_state_check", sql`${table.state} in ('pending', 'confirmed', 'failed')`),
  ],
);

/** Insert only: a note cannot be edited or deleted. */
export const dealNotes = pgTable(
  "deal_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id")
      .notNull()
      .references(() => deals.id),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("deal_notes_deal_id_created_at_idx").on(table.dealId, table.createdAt),
    index("deal_notes_author_id_idx").on(table.authorId),
    check("deal_notes_text_check", sql`char_length(${table.text}) between 1 and 1000`),
  ],
);
