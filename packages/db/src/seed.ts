import { createDatabase } from "./index.ts";
import { seedUsers } from "./seed-data.ts";

const DEFAULT_URL = "postgres://app@127.0.0.1:41032/app";

/** Writes the seed users to the database at `url`, then closes the pool. */
export async function runSeed(url: string): Promise<void> {
  const { db, close } = createDatabase(url);
  try {
    await seedUsers(db);
  } finally {
    await close();
  }
}

if (import.meta.main) {
  await runSeed(process.env.DATABASE_URL ?? DEFAULT_URL);
}
