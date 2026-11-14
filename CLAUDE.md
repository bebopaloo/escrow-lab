# escrow-lab

escrow-lab is a toy escrow app with milestone Payouts. It exists to prove the bebopaloo factory: Risk tiers from paths, LLM tier escalation, and unattended merges. Build only from the Specs in `_context/features/`. Never copy code from another project.

## Verify

Start the local database first: `docker compose up -d --wait db` (it listens on `127.0.0.1:41032`), then `pnpm db:migrate`.

| Check                         | Command                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| Types                         | `pnpm typecheck`                                                     |
| Lint                          | `pnpm lint`                                                          |
| Format                        | `pnpm format:check`                                                  |
| Unit, component and API tests | `pnpm test`                                                          |
| One API test                  | `pnpm --filter @escrow-lab/api exec vitest run <file> -t "<name>"`   |
| End to end                    | `pnpm test:e2e` (first run: `pnpm exec playwright install chromium`) |
| Preview of the branch         | the `stack-ts:preview` skill                                         |

All of them pass before a commit.

## Constraints

- Every partner service (the chain, the payment rail, the identity check) is an in-memory fake behind an interface. Never add a network call to a partner, and never add a partner SDK.
- Only test code can turn on failure injection in a fake. Production config must not reach it.
- Each domain module is a folder in `apps/api/src/modules/<name>/`. Other code imports a module only through its `index.ts`. The module folder is the Risk tier boundary in `_context/controls/risk-map.toml`, so do not move code between modules to change its tier.
- "Payout" is money that leaves escrow. "Release" means a software release only.
- The API runs TypeScript with Node type stripping: use only erasable syntax (no `enum`, no parameter properties, no `namespace`), and import local files with their `.ts` extension.
- `.claude/rules/` holds the Repo rules from the factory's Rule templates. Change a rule there in its own commit; `.prettierignore` skips the folder so the files stay comparable with the templates.

## Context

- Rules: `.claude/rules/`. Factory settings: `.claude/factory.json`.
- Specs, decisions, terms and controls: `_context/` (`features/`, `adr/`, `terminology.md`, `controls/`).
