import { createServer, type Server } from "node:net";
import { defineConfig, devices } from "@playwright/test";
import { CHECKOUT_FOLDER, worktreeDatabaseUrl } from "./worktree-env.ts";

// E2E_BASE_URL points the tests at a running preview. Without it, Playwright
// starts the dev servers itself, on free ports and on a database of its own
// (`app_e2e_<folder>`, new for each run), so two worktrees can run their
// end-to-end tests at the same time. A DATABASE_URL from the caller (CI) is
// used as it is, and only migrated. The specs and the dev servers share it
// through the environment.
const previewURL = process.env.E2E_BASE_URL;
const ci = process.env.CI !== undefined;

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("No port"));
      else resolve(address.port);
    });
  });
}

// All servers stay open until every port is known, so the ports differ.
async function freePorts(count: number): Promise<string[]> {
  const servers = Array.from({ length: count }, () => createServer());
  try {
    const ports = await Promise.all(servers.map(listen));
    return ports.map(String);
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

// Playwright loads this file again in each worker. The first load keeps the
// ports in the environment, which the workers inherit.
if (
  previewURL === undefined &&
  (process.env.E2E_WEB_PORT === undefined || process.env.E2E_API_PORT === undefined)
) {
  const [webPort, apiPort] = await freePorts(2);
  process.env.E2E_WEB_PORT ??= webPort;
  process.env.E2E_API_PORT ??= apiPort;
}

// The first load derives the database of this worktree and keeps it in the
// environment, so the dev servers, the workers and the commands that a spec runs
// (a seed, for example) all use it. A DATABASE_URL from the caller stays as it is.
if (previewURL === undefined && process.env.DATABASE_URL === undefined) {
  process.env.DATABASE_URL = worktreeDatabaseUrl(
    "e2e",
    CHECKOUT_FOLDER,
    process.env.DB_PORT ?? "41032",
  );
  process.env.E2E_RECREATE_DATABASE = "1";
}

const devURL = `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? ""}`;
const baseURL = previewURL ?? devURL;

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: ci,
  // The specs share the seeded users. A sign-out voids every session of its user, so two specs
  // that use one user must not run at the same time.
  workers: 1,
  retries: ci ? 1 : 0,
  reporter: ci ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  ...(previewURL
    ? {}
    : {
        webServer: {
          command: "pnpm --filter @escrow-lab/api e2e:db && pnpm dev",
          url: devURL,
          reuseExistingServer: !ci,
          timeout: 60_000,
          // WEB_PORT is the Vite port. PORT is the API port, which the Vite
          // proxy also reads.
          env: {
            WEB_PORT: process.env.E2E_WEB_PORT ?? "",
            PORT: process.env.E2E_API_PORT ?? "",
            CORS_ORIGINS: devURL,
          },
        },
      }),
});
