import { schema, type Database } from "@escrow-lab/db";
import { and, eq } from "drizzle-orm";

/** `funded` becomes `completed`. Call it in the transaction that pays the last Milestone. */
export async function completeDeal(db: Pick<Database, "update">, dealId: string): Promise<void> {
  await db
    .update(schema.deals)
    .set({ state: "completed" })
    .where(and(eq(schema.deals.id, dealId), eq(schema.deals.state, "funded")));
}
