import { createHash } from "node:crypto";
import path from "node:path";

// Postgres keeps 63 bytes of a name. The longest prefix, `app_e2e_`, takes 8 of
// them, and `app_test_` takes 9. The slug keeps the rest.
const MAX_SLUG = 54;

/**
 * The name of a checkout folder as a database name part: lower-case letters,
 * digits and underscores. A long name keeps its start and gets a hash of the
 * whole folder name, so two long names stay apart.
 */
export function worktreeSlug(folder: string): string {
  const slug = folder
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (slug === "") {
    throw new Error(
      `Cannot name a database from the folder "${folder}". Set TEST_DATABASE_URL (tests) or DATABASE_URL (e2e).`,
    );
  }
  if (slug.length <= MAX_SLUG) return slug;
  const hash = createHash("sha256").update(folder).digest("hex").slice(0, 8);
  return `${slug.slice(0, MAX_SLUG - hash.length - 1)}_${hash}`;
}

/** `app_test_<slug>` for the API tests, `app_e2e_<slug>` for the end-to-end tests. */
export function worktreeDatabaseName(kind: "test" | "e2e", folder: string): string {
  return `app_${kind}_${worktreeSlug(folder)}`;
}

export function worktreeDatabaseUrl(kind: "test" | "e2e", folder: string, dbPort: string): string {
  return `postgres://app@127.0.0.1:${dbPort}/${worktreeDatabaseName(kind, folder)}`;
}

/** The checkout folder: the folder that holds this file. */
export const CHECKOUT_FOLDER = path.basename(import.meta.dirname);
