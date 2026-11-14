import { schema, type Database } from "@escrow-lab/db";

export type AuditAction =
  | "sign_in"
  | "create_deal"
  | "fund"
  | "send_evidence"
  | "accept"
  | "reject"
  | "approve_payout"
  | "retry_payout"
  | "payout_confirmed"
  | "payout_failed"
  | "funding_confirmed"
  | "funding_failed";

export interface AuditEvent {
  userId: string;
  action: AuditAction;
  dealId?: string;
}

/** Appends one audit event. The table refuses UPDATE and DELETE. */
export async function recordAuditEvent(db: Database, event: AuditEvent): Promise<void> {
  await db.insert(schema.auditEvents).values({
    userId: event.userId,
    action: event.action,
    dealId: event.dealId ?? null,
  });
}
