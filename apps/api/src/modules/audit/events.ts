import { schema, type Database } from "@escrow-lab/db";
import { asc, eq } from "drizzle-orm";

export interface DealAuditRow {
  createdAt: Date;
  /** The current display name of the user, not the name at the time of the event. */
  displayName: string;
  action: string;
}

/** Each audit event of a Deal, oldest first. */
export async function listDealAuditEvents(db: Database, dealId: string): Promise<DealAuditRow[]> {
  return db
    .select({
      createdAt: schema.auditEvents.createdAt,
      displayName: schema.users.displayName,
      action: schema.auditEvents.action,
    })
    .from(schema.auditEvents)
    .innerJoin(schema.users, eq(schema.users.id, schema.auditEvents.userId))
    .where(eq(schema.auditEvents.dealId, dealId))
    .orderBy(asc(schema.auditEvents.createdAt), asc(schema.auditEvents.id));
}
