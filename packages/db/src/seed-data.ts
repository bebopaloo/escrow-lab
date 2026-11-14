import type { Database } from "./index.ts";
import { users } from "./schema.ts";

export interface SeedUser {
  id: string;
  displayName: string;
  role: "buyer" | "seller" | "approver";
}

/** Synthetic users with fixed ids. `pnpm db:seed` and the tests use this one set. */
export const SEED_USERS: readonly SeedUser[] = [
  { id: "00000000-0000-4000-8000-000000000001", displayName: "Alice Buyer", role: "buyer" },
  { id: "00000000-0000-4000-8000-000000000002", displayName: "Bob Buyer", role: "buyer" },
  { id: "00000000-0000-4000-8000-000000000003", displayName: "Carol Seller", role: "seller" },
  { id: "00000000-0000-4000-8000-000000000004", displayName: "Dan Seller", role: "seller" },
  { id: "00000000-0000-4000-8000-000000000005", displayName: "Erin Approver", role: "approver" },
  { id: "00000000-0000-4000-8000-000000000006", displayName: "Frank Approver", role: "approver" },
];

export async function seedUsers(db: Database): Promise<void> {
  await db
    .insert(users)
    .values([...SEED_USERS])
    .onConflictDoNothing();
}
