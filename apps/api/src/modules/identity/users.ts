import { schema, type Database } from "@escrow-lab/db";
import type { SessionUser } from "@escrow-lab/shared";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { recordAuditEvent } from "../audit/index.ts";

const columns = {
  id: schema.users.id,
  displayName: schema.users.displayName,
  role: schema.users.role,
};

export async function listUsers(db: Database): Promise<SessionUser[]> {
  return db
    .select(columns)
    .from(schema.users)
    .orderBy(asc(schema.users.role), asc(schema.users.displayName));
}

export interface UserWithVersion {
  user: SessionUser;
  sessionVersion: number;
}

export async function findUserWithVersion(
  db: Database,
  id: string,
): Promise<UserWithVersion | undefined> {
  const [row] = await db
    .select({ ...columns, sessionVersion: schema.users.sessionVersion })
    .from(schema.users)
    .where(eq(schema.users.id, id));
  if (row === undefined) return undefined;
  const { sessionVersion, ...user } = row;
  return { user, sessionVersion };
}

/** Makes every session that was signed in before this call invalid. */
export async function bumpSessionVersion(db: Database, id: string): Promise<void> {
  await db
    .update(schema.users)
    .set({ sessionVersion: sql`${schema.users.sessionVersion} + 1` })
    .where(eq(schema.users.id, id));
}

/** One lock for all name changes: two users cannot take the same name at the same time. */
const NAME_LOCK_KEY = 4_900_049;

/**
 * Sets the display name of a user, with the audit event, in one transaction. The name is `taken`
 * when another user has it, whatever the case. A user can change the case of their own name.
 */
export async function changeDisplayName(
  db: Database,
  id: string,
  displayName: string,
): Promise<SessionUser | "taken"> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${NAME_LOCK_KEY})`);
    const [other] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(
        and(
          sql`lower(${schema.users.displayName}) = lower(${displayName})`,
          ne(schema.users.id, id),
        ),
      )
      .limit(1);
    if (other !== undefined) return "taken";
    const [row] = await tx
      .update(schema.users)
      .set({ displayName })
      .where(eq(schema.users.id, id))
      .returning(columns);
    if (row === undefined) throw new Error("The signed-in user does not exist");
    await recordAuditEvent(tx, { userId: id, action: "change_display_name" });
    return row;
  });
}
