import { schema, type Database } from "@escrow-lab/db";
import type { NoteResponse } from "@escrow-lab/shared";
import { and, desc, eq, or } from "drizzle-orm";
import { recordAuditEvent } from "../audit/index.ts";

const participantOf = (dealId: string, userId: string) =>
  and(
    eq(schema.deals.id, dealId),
    or(eq(schema.deals.buyerId, userId), eq(schema.deals.sellerId, userId)),
  );

async function isParticipant(
  db: Pick<Database, "select">,
  userId: string,
  dealId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.deals.id })
    .from(schema.deals)
    .where(participantOf(dealId, userId));
  return row !== undefined;
}

/** The notes of a Deal, newest first, or undefined when the user is not its Buyer or Seller. */
export async function listNotes(
  db: Database,
  userId: string,
  dealId: string,
): Promise<NoteResponse[] | undefined> {
  if (!(await isParticipant(db, userId, dealId))) return undefined;
  const rows = await db
    .select({
      id: schema.dealNotes.id,
      text: schema.dealNotes.text,
      authorId: schema.dealNotes.authorId,
      authorName: schema.users.displayName,
      createdAt: schema.dealNotes.createdAt,
    })
    .from(schema.dealNotes)
    .innerJoin(schema.users, eq(schema.users.id, schema.dealNotes.authorId))
    .where(eq(schema.dealNotes.dealId, dealId))
    .orderBy(desc(schema.dealNotes.createdAt), desc(schema.dealNotes.id));
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

/**
 * Writes the note and the `add_note` audit event in one transaction. Returns the note, or
 * undefined when the user is not the Buyer or the Seller of the Deal.
 */
export async function addNote(
  db: Database,
  userId: string,
  dealId: string,
  text: string,
): Promise<NoteResponse | undefined> {
  return db.transaction(async (tx) => {
    if (!(await isParticipant(tx, userId, dealId))) return undefined;
    const [note] = await tx
      .insert(schema.dealNotes)
      .values({ dealId, authorId: userId, text })
      .returning({
        id: schema.dealNotes.id,
        text: schema.dealNotes.text,
        authorId: schema.dealNotes.authorId,
        createdAt: schema.dealNotes.createdAt,
      });
    const [author] = await tx
      .select({ displayName: schema.users.displayName })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    if (note === undefined || author === undefined) throw new Error("The note was not saved");
    await recordAuditEvent(tx, { userId, action: "add_note", dealId });
    return { ...note, authorName: author.displayName, createdAt: note.createdAt.toISOString() };
  });
}
