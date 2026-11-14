# escrow-lab

TypeScript end to end: a React web app, a Fastify API and a Postgres database with Drizzle, in a pnpm workspace.

| Folder            | Holds                                                      |
| ----------------- | ---------------------------------------------------------- |
| `apps/web`        | React with Vite and TanStack Query                         |
| `apps/api`        | Fastify API, run by Node with type stripping               |
| `packages/db`     | Drizzle schema, migrations and the database client         |
| `packages/shared` | Zod schemas that the web app and the API share             |
| `e2e`             | Playwright end-to-end tests with an axe accessibility scan |

## Start

You need Node 26, pnpm 12 (`npm install --global pnpm@12.18.0`) and Docker.

```bash
pnpm install
docker compose up -d --wait db
pnpm db:migrate
pnpm db:seed
pnpm dev
```

`pnpm db:seed` writes the seed users to the database. `pnpm dev` starts the API and the web app together. To run one of them alone, use these commands:

```bash
pnpm --filter @escrow-lab/api dev
pnpm --filter @escrow-lab/web dev
```

The web app runs at http://127.0.0.1:41073 and calls the API at http://127.0.0.1:41030 through the Vite proxy.

The local database listens on `127.0.0.1:41032`. Set `DB_PORT` before `docker compose up` to use another port, and set the same `DB_PORT` when you run the tests. It accepts local connections without a password; never use these settings for a shared database.

## Ports

This project has its own block of 100 localhost ports, from 41000, so it can run next to other projects and local services. The ports inside the preview containers are not published, so they keep their usual numbers.

- `41030`: the dev API (`PORT`)
- `41032`: the local database (`DB_PORT`)
- `41073`: the Vite dev server (`WEB_PORT`)
- `41074`: `vite preview` of the built web app
- `41080` to the next 19 ports: the previews of the branches (`PREVIEW_PORT`)

To move the project to a different block, change all these numbers together.

## Parallel worktrees

Two git worktrees of this repo can run their tests at the same time:

- The API tests use the database `app_test_<folder>`, where `<folder>` is the name of the checkout folder. The tests create it when it does not exist. Set `TEST_DATABASE_URL` to use a different database.
- `pnpm test:e2e` starts the dev servers on free ports. Set `E2E_WEB_PORT` and `E2E_API_PORT` to choose the ports.

## Run each test suite

Start the database and migrate first (see [Start](#start)). Then run the suite that you need:

```bash
pnpm test
pnpm --filter @escrow-lab/api test
pnpm --filter @escrow-lab/web test
pnpm --filter @escrow-lab/api exec vitest run <file> -t "<name>"
pnpm exec playwright install chromium
pnpm test:e2e
```

`pnpm test` runs the tests of every package. The `playwright install` command is only for the first end-to-end run.

## Check

| Command             | Does                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `pnpm typecheck`    | Type check every package                                                                                                 |
| `pnpm lint`         | ESLint with the type-checked rules                                                                                       |
| `pnpm format:check` | Prettier                                                                                                                 |
| `pnpm test`         | Unit, component and API integration tests. The API tests need the database.                                              |
| `pnpm test:e2e`     | Playwright. Starts the dev servers unless `E2E_BASE_URL` is set. Run `pnpm exec playwright install chromium` once first. |

CI runs all of these, a secret scan and a dependency audit on every pull request.

## Preview

`compose.preview.yaml` runs a production-like build of the current checkout on this machine: the API image, the built web app behind Caddy on one origin, and its own database. Only the web port is published, on `127.0.0.1`.

```bash
PREVIEW_PORT=41080 docker compose -f compose.preview.yaml -p escrow-lab-preview up -d --build --wait
E2E_BASE_URL=http://127.0.0.1:41080 pnpm test:e2e
docker compose -f compose.preview.yaml -p escrow-lab-preview down --volumes
```

The stack-ts `preview` skill does the same with one project and a stable port per branch, from the preview ports in [Ports](#ports).

## Database changes

Change `packages/db/src/schema.ts`, run `pnpm db:generate`, read the generated SQL in `packages/db/migrations/`, and commit both.

## Configuration

The API reads these variables at start-up and stops if one is invalid.

| Variable       | Default                                                  |
| -------------- | -------------------------------------------------------- |
| `DATABASE_URL` | none; `pnpm dev` uses the local database                 |
| `HOST`         | `127.0.0.1`                                              |
| `PORT`         | the dev API port in [Ports](#ports)                      |
| `CORS_ORIGINS` | the Vite dev server origin; a comma-separated allow-list |
| `LOG_LEVEL`    | `info`                                                   |
