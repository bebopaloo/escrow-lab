import { createDatabase, migrateDatabase } from "@escrow-lab/db";
import { sql } from "drizzle-orm";
import { z } from "zod";

// Prepares the database for `pnpm test:e2e`. playwright.config.ts runs it before
// the dev servers start. E2E_RECREATE_DATABASE=1 means that the config derived
// the database (`app_e2e_<folder>`) for this worktree: it drops the database and
// creates it again, so a run starts with no rows from an earlier run. A
// DATABASE_URL from the caller is only migrated.
const url = new URL(z.url({ protocol: /^postgres(ql)?$/ }).parse(process.env.DATABASE_URL));

if (process.env.E2E_RECREATE_DATABASE === "1") {
  const name = url.pathname.slice(1);
  const server = new URL(url);
  server.pathname = "/postgres";
  const maintenance = createDatabase(server.toString());
  try {
    await maintenance.db.execute(sql`drop database if exists ${sql.identifier(name)} with (force)`);
    await maintenance.db.execute(sql`create database ${sql.identifier(name)}`);
  } finally {
    await maintenance.close();
  }
}

const database = createDatabase(url.toString());
try {
  await migrateDatabase(database.db);
} finally {
  await database.close();
}
