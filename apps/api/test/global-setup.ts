import { recreateTestDatabase } from "./database.ts";

// Vitest runs this once before all test files. Each run starts with an empty
// database, so no assertion depends on a row from an earlier run.
export default async function setup(): Promise<void> {
  await recreateTestDatabase();
}
