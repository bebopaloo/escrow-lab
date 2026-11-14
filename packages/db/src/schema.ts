// Drizzle tables go here. Run `pnpm db:generate` after each change and commit the
// generated migration with it.
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    displayName: text("display_name").notNull(),
    role: text("role", { enum: ["buyer", "seller", "approver"] }).notNull(),
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
