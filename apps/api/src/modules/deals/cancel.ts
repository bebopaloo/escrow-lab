import { schema, type Database } from "@escrow-lab/db";
import { and, eq } from "drizzle-orm";
import { recordAuditEvent } from "../audit/index.ts";

export type CancelOutcome =
  /** The Deal is not visible to this Buyer. */
  | { kind: "not_found" }
  /** The Deal is not in `draft`, or a fund request moved it first. */
  | { kind: "wrong_state" }
  /** The Deal is `cancelled` and the `cancel_deal` audit event is written. */
  | { kind: "cancelled" };

/**
 * In one transaction: `draft` to `cancelled` as a conditional update, and the `cancel_deal` audit
 * event. A Deal in any other state is left as it is.
 */
export async function cancelDeal(
  db: Database,
  buyerId: string,
  dealId: string,
): Promise<CancelOutcome> {
  return db.transaction(async (tx) => {
    const [moved] = await tx
      .update(schema.deals)
      .set({ state: "cancelled" })
      .where(
        and(
          eq(schema.deals.id, dealId),
          eq(schema.deals.buyerId, buyerId),
          eq(schema.deals.state, "draft"),
        ),
      )
      .returning({ id: schema.deals.id });
    if (moved !== undefined) {
      await recordAuditEvent(tx, { userId: buyerId, action: "cancel_deal", dealId });
      return { kind: "cancelled" };
    }
    const [existing] = await tx
      .select({ id: schema.deals.id })
      .from(schema.deals)
      .where(and(eq(schema.deals.id, dealId), eq(schema.deals.buyerId, buyerId)));
    return existing === undefined ? { kind: "not_found" } : { kind: "wrong_state" };
  });
}
