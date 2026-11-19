import { createDatabase, migrateDatabase } from "@escrow-lab/db";
import { sql } from "drizzle-orm";
import {
  CHECKOUT_FOLDER,
  worktreeDatabaseName as nameOf,
  worktreeDatabaseUrl as urlOf,
} from "../../../worktree-env.ts";
import { loadConfig } from "../src/config.ts";

const DEFAULT_DB_PORT = "41032";
const DUPLICATE_DATABASE = "42P04";

/**
 * The test database for a checkout folder: `app_test_<slug>`, so that each git
 * worktree has its own database on the shared local server.
 */
export function worktreeDatabaseName(folder: string): string {
  return nameOf("test", folder);
}

export function worktreeDatabaseUrl(folder: string, dbPort = DEFAULT_DB_PORT): string {
  return urlOf("test", folder, dbPort);
}

const callerDatabaseUrl = process.env.TEST_DATABASE_URL;

export const TEST_DATABASE_URL =
  callerDatabaseUrl ?? worktreeDatabaseUrl(CHECKOUT_FOLDER, process.env.DB_PORT);

export const testConfig = loadConfig({
  DATABASE_URL: TEST_DATABASE_URL,
  SESSION_KEY: "5e".repeat(32), // a fixed fake key, for tests only
  LOG_LEVEL: "silent",
});

function errorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error) return error.code;
  return "cause" in error ? errorCode(error.cause) : undefined;
}

async function withMaintenance<T>(
  databaseUrl: string,
  run: (db: ReturnType<typeof createDatabase>["db"], name: string) => Promise<T>,
): Promise<T> {
  const server = new URL(databaseUrl);
  const name = server.pathname.slice(1);
  server.pathname = "/postgres";
  const maintenance = createDatabase(server.toString());
  try {
    return await run(maintenance.db, name);
  } finally {
    await maintenance.close();
  }
}

// A database that TEST_DATABASE_URL names belongs to the caller, so only the
// derived database is created here. Two test runs can race to create it.
async function createTestDatabaseIfMissing(): Promise<void> {
  if (callerDatabaseUrl !== undefined) return;
  await withMaintenance(TEST_DATABASE_URL, async (db, name) => {
    try {
      await db.execute(sql`create database ${sql.identifier(name)}`);
    } catch (error) {
      if (errorCode(error) !== DUPLICATE_DATABASE) throw error;
    }
  });
}

/**
 * Drops the derived test database and creates it again, so that a test run
 * starts with no rows from an earlier run. A database that TEST_DATABASE_URL
 * names belongs to the caller (CI has a new server for each job), so it stays.
 * Run only one test run at a time in a worktree: the drop closes the
 * connections of any other run.
 */
export async function recreateTestDatabase(): Promise<void> {
  if (callerDatabaseUrl !== undefined) return;
  await withMaintenance(TEST_DATABASE_URL, async (db, name) => {
    await db.execute(sql`drop database if exists ${sql.identifier(name)} with (force)`);
  });
  await createTestDatabaseIfMissing();
}

/**
 * A real Postgres database with the migrations applied. Start the server with
 * `docker compose up -d --wait db`. Without TEST_DATABASE_URL, the database is
 * `app_test_<folder>` and is created when it does not exist.
 */
export async function openTestDatabase() {
  await createTestDatabaseIfMissing();
  const database = createDatabase(TEST_DATABASE_URL);
  await migrateDatabase(database.db);
  return database;
}
