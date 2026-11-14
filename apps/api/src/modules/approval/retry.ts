import { schema, type Database } from "@escrow-lab/db";
import { eq } from "drizzle-orm";
import { recordAuditEvent } from "../audit/index.ts";

export type RetryOutcome =
  | { kind: "not_found" }
  /** The Payout is not `failed`. */
  | { kind: "wrong_state" }
  | { kind: "done"; payoutId: string };

/**
 * Retries a `failed` Payout. One transaction locks the Payout row, sets it `pending` with 0 tries
 * and a due next try time, keeps its Idempotency key, and writes the `retry_payout` audit event.
 * The same key makes the chain return its first transfer, so a retry cannot pay twice.
 */
export async function retryPayout(
  db: Database,
  approverId: string,
  payoutId: string,
): Promise<RetryOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ state: schema.payouts.state, dealId: schema.milestones.dealId })
      .from(schema.payouts)
      .innerJoin(schema.milestones, eq(schema.milestones.id, schema.payouts.milestoneId))
      .where(eq(schema.payouts.id, payoutId))
      .for("update", { of: schema.payouts });
    if (row === undefined) return { kind: "not_found" } as const;
    if (row.state !== "failed") return { kind: "wrong_state" } as const;
    await tx
      .update(schema.payouts)
      .set({ state: "pending", attempts: 0, nextTryAt: new Date() })
      .where(eq(schema.payouts.id, payoutId));
    await recordAuditEvent(tx, {
      userId: approverId,
      action: "retry_payout",
      dealId: row.dealId,
    });
    return { kind: "done", payoutId } as const;
  });
}
