import { schema, type Database } from "@escrow-lab/db";
import type { SessionUser } from "@escrow-lab/shared";
import { asc, eq } from "drizzle-orm";

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

export async function findUser(db: Database, id: string): Promise<SessionUser | undefined> {
  const [user] = await db.select(columns).from(schema.users).where(eq(schema.users.id, id));
  return user;
}
