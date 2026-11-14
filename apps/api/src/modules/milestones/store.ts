import { schema, type Database } from "@escrow-lab/db";
import type { MilestoneResponse } from "@escrow-lab/shared";
import { and, asc, eq } from "drizzle-orm";

export interface NewMilestone {
  title: string;
  amountMinor: number;
}

type Writer = Pick<Database, "insert">;

/** Adds the Milestones of a new Deal, in order, all `pending`. */
export async function insertMilestones(
  db: Writer,
  dealId: string,
  items: readonly NewMilestone[],
): Promise<MilestoneResponse[]> {
  return db
    .insert(schema.milestones)
    .values(
      items.map((item, index) => ({
        dealId,
        position: index + 1,
        title: item.title,
        amountMinor: item.amountMinor,
        state: "pending" as const,
      })),
    )
    .returning({
      id: schema.milestones.id,
      position: schema.milestones.position,
      title: schema.milestones.title,
      amountMinor: schema.milestones.amountMinor,
      state: schema.milestones.state,
    });
}

export async function listMilestones(db: Database, dealId: string): Promise<MilestoneResponse[]> {
  return db
    .select({
      id: schema.milestones.id,
      position: schema.milestones.position,
      title: schema.milestones.title,
      amountMinor: schema.milestones.amountMinor,
      state: schema.milestones.state,
    })
    .from(schema.milestones)
    .where(eq(schema.milestones.dealId, dealId))
    .orderBy(asc(schema.milestones.position));
}

/** Opens the first Milestone of a funded Deal: `pending` becomes `awaiting_evidence`. */
export async function openFirstMilestone(
  db: Pick<Database, "update">,
  dealId: string,
): Promise<void> {
  await db
    .update(schema.milestones)
    .set({ state: "awaiting_evidence" })
    .where(and(eq(schema.milestones.dealId, dealId), eq(schema.milestones.position, 1)));
}
