import { schema, type Database } from "@escrow-lab/db";
import type { SessionUser } from "@escrow-lab/shared";
import { asc, eq, sql } from "drizzle-orm";

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
