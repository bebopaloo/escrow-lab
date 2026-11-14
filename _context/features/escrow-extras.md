# Escrow extras

**Status:** Approved
**Work items:** #32

## Problem

The escrow core covers one happy journey and its failures. People who use escrow-lab every day hit gaps around it:

- Buyers with many Deals cannot find one, cannot leave a note for the Seller, cannot drop a Deal they set up by mistake, and cannot get their money back when a funded Deal falls through.
- Buyers who trust a Seller wait for the approval queue on every Milestone, even for small amounts.
- Sellers cannot see what they were paid in one place, cannot match a Payout to their invoice, and cannot fix their display name.
- A person who demos escrow-lab alone must sign in as three users in turn to finish one Deal.
- Operators have a thin health check, no run guide, and a set of small open findings from the core.
- The API test files copy the same sign-in helper, and two retry tests fail about one CI run in ten.

## Users

- **Buyer**: searches Deals, adds notes, cancels a draft Deal, chooses express Deals, exports the audit trail of a Deal.
- **Seller**: adds notes, sees the Payout history, adds a reference to each Payout, changes the display name, exports the audit trail of a Deal.
- **Approver**: refunds a funded Deal.
- **Operator**: runs the app, reads the health check, runs demos.

## Acceptance criteria

### Search the Deal list
- **Given** a Buyer with Deals titled "Kitchen refit" and "Garden wall"
- **When** the Buyer searches for "kitchen"
- **Then** the list shows only "Kitchen refit"
- [ ] The search matches the Deal title, ignores case, treats `%` and `_` as plain characters, and returns only the user's own Deals.
- [ ] `q` is at most 100 characters. The list can also filter by Deal state. An unknown state returns 400.
- [ ] Search and filter keep the existing pagination, and `total` counts the filtered Deals.

### Add a note to a Deal
- **Given** a Deal between a Buyer and a Seller
- **When** either of them adds a note of up to 1,000 characters
- **Then** both see the note on the Deal page, with its author and time, newest first
- [ ] Another Buyer or Seller gets 404. An Approver gets 403. An empty note or a note over 1,000 characters is refused.
- [ ] Adding a note writes the `add_note` audit event.

### Cancel a draft Deal
- **Given** a Deal in "draft"
- **When** its Buyer cancels it
- **Then** the Deal is "cancelled", it leaves the default Deal list, and nobody can fund it
- [ ] The state filter `cancelled` shows cancelled Deals.
- [ ] Cancel is a conditional update on `state = 'draft'`. A Deal in any other state, or one that a fund request moves first, returns 409 and changes nothing.
- [ ] Cancelling writes the `cancel_deal` audit event.

### Express Deals
- **Given** a new Deal, which is express by default
- **When** the Buyer accepts the evidence of a Milestone
- **Then** the app pays the Milestone at once: the Payout goes to the chain in the same request, and on confirmation the Milestone is "paid" and the next Milestone opens
- [ ] The Buyer can turn express off when they create the Deal. A Deal that is not express keeps the approval queue. The Deal page shows the setting, and nobody can change it after creation.
- [ ] Deals that exist before this change are not express.
- [ ] When the first transfer does not confirm, the accept returns the Milestone as "accepted", the Payout stays "pending", and the retry job carries on, as for any Payout.
- [ ] The Payout records the Buyer as its approver. The accept writes the `accept` and `express_payout` audit events.
- [ ] Test set-ups that create a Deal for the approval path send `express: false`. The e2e journey keeps the approval path, and a new e2e spec covers an express Deal.

### Refund a funded Deal
- **Given** a funded Deal with no Payout
- **When** an Approver refunds it from the approval queue
- **Then** the chain returns the locked money to the Buyer, the ledger has one refund for the full total, and the Deal is "refunded"
- [ ] A Deal with a Payout in any state, or in any state but "funded", returns 409 and changes nothing.
- [ ] The refund keeps one Idempotency key for all its tries, and a lost chain reply does not refund twice.
- [ ] A timeout or a lost reply leaves the Deal "refunding". The retry job tries again with the same key. After 5 tries the Deal is "refund failed" and shows in the queue.
- [ ] The refund writes the `refund_deal` audit event. Only an Approver can refund. A Buyer or a Seller gets 403.
- [ ] Evidence, accept and reject need a "funded" Deal. On a Deal in any other state they return 409.

### Show the refund on the Deal page
- **Given** a refunded Deal
- **When** the Buyer or the Seller opens it
- **Then** the page says that the Deal was refunded, with the amount and the date, and shows no Milestone actions

### Show each Payout in plain words
- **Given** a Deal with one paid Milestone, one Milestone whose Payout is pending, one whose Payout failed, and one accepted Milestone with no Payout
- **When** the Buyer or the Seller opens the Deal page
- **Then** the Milestones show "Paid on <date>", "Payment to the Seller is on its way", "Payment to the Seller failed. An Approver will retry it." and "Waiting for an Approver"

### Add a reference to a Payout
- **Given** a Seller with a Payout on a Deal
- **When** the Seller enters a reference of up to 40 characters, such as "INV-2041", on the Deal page
- **Then** the reference shows next to the Payout for the Buyer and the Seller
- [ ] Only the Seller of the Deal can set it. The Seller can change it at any time. An empty value clears it.
- [ ] A Milestone with no Payout returns 404.

### Change the display name
- **Given** a signed-in user
- **When** the user changes their display name to a value of 1 to 60 characters
- **Then** the new name shows on every page and to the other party of each Deal
- [ ] The app trims the name. An empty name, a name of only spaces, a name over 60 characters, or the name of another user is refused.
- [ ] The sign-in page lists the new name. The change writes the `change_display_name` audit event.

### See the Payout history
- **Given** a Seller with Payouts on three Deals
- **When** the Seller opens the Payout history page
- **Then** the page lists each Payout with the Deal title, the Milestone title, the amount, the state and the time, newest first, paginated
- [ ] A Seller sees only their own Payouts. A Buyer or an Approver gets 403.

### Report more in the health check
- [ ] `GET /api/health` also returns the number of applied migrations and the database round-trip time in milliseconds.
- [ ] It still returns 503 when the database does not answer.

### Share one sign-in helper across the API tests
- [ ] `apps/api/test/harness.ts` exports `signIn(app, userId)` and `cookieOf`. Every API test file except `session.test.ts` uses them, and no other copy is left.
- [ ] Each test checks the same things as before. This change does not lower the test count.

### Remove the flaky retry tests
- [ ] The tests "skips a Deal that another try holds with a row lock" in `apps/api/test/funding-retry.test.ts` and "skips a Payout that another try holds with a row lock" in `apps/api/test/payout-retry.test.ts` are removed. The end-to-end suite covers retries.
- [ ] `pnpm test` passes in ten CI runs in a row.

### Demo mode
- **Given** `DEMO_AUTO_APPROVE` is on
- **When** a Buyer accepts the evidence of a Milestone
- **Then** on the next demo loop run the app pays the Milestone, with Erin Approver (`00000000-0000-4000-8000-000000000005`) as its approver
- [ ] `DEMO_AUTO_APPROVE` is on by default when `NODE_ENV` is not `production`. Config refuses `DEMO_AUTO_APPROVE=true` when `NODE_ENV` is `production`, and a test proves it.
- [ ] The Playwright config sets `DEMO_AUTO_APPROVE=false` for the API that the e2e tests start.
- [ ] When the seeded Approver is missing, the loop logs a warning and pays nothing.
- [ ] Each demo Payout writes the `approve_payout` audit event for the seeded Approver.

### Export the audit trail of a Deal
- **Given** a Buyer or a Seller of a Deal
- **When** they press "Export audit trail" on the Deal page
- **Then** the browser downloads a CSV with one row for each audit event of the Deal: time, the user's current display name and action
- [ ] Another Buyer or Seller gets 404. An Approver gets 403.
- [ ] Each field is quoted as RFC 4180 says. A field that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`. The response has `Content-Type: text/csv` and `Content-Disposition: attachment`.

### Write the local run guide
- [ ] `README.md` explains how to start the database, migrate, seed, run the API and the web app, and run each test suite, with the exact commands.

### Fix the open findings from the core
- [ ] Removing a Milestone on the create page also removes its amount error, so the error marks the right inputs.
- [ ] The evidence form clears its text and its old notice when the Milestone state changes.
- [ ] The Deal list pagination test checks the exact total for one user and that a second page returns other Deals.
- [ ] A test sends more requests than the approve limit and expects 429 and no new Payout.
- [ ] A test proves the lease of the funding retry job: a second job run inside the lease skips the Deal.
- [ ] The doc comment of the funding retry job says that a Deal try sends the charge and the lock, and a Payout try sends the transfer.

## Design

### Data model

- `deals`: state gains `cancelled`, `refunding`, `refund_failed` and `refunded`. New columns `express` (boolean, not null), `refund_idempotency_key` (text, null), `refund_attempts` (integer, default 0) and `next_refund_try_at` (time, null). The migration sets `express` to `false` on the existing rows, and the default to `true` for new rows. An index supports the title search.
- `deal_notes` (new): id, Deal id, author id, text, time. Insert only.
- `ledger_entries`: kind gains `refund`. A partial unique index allows one `refund` row for each Deal.
- `payouts`: new column `seller_reference` (text, null, at most 40 characters).
- `audit_events`: new actions `add_note`, `cancel_deal`, `express_payout`, `refund_deal`, `change_display_name`.
- `packages/shared`: the Deal state enum gains the new states in the first issue that adds them.

Every migration only adds a column, a table, an index or an allowed value.

### API

| Route | Who | Module | Does |
|---|---|---|---|
| `GET /api/deals?q=&state=` | Buyer, Seller | `deals` | Search by title and filter by state, own Deals only |
| `GET /api/deals/:id/notes`, `POST /api/deals/:id/notes` | Buyer, Seller of the Deal | `deals` | List and add notes |
| `POST /api/deals/:id/cancel` | Buyer of the Deal | `deals` | `draft` to `cancelled` |
| `POST /api/deals` | Buyer | `deals` | Gains an optional `express` field, default `true` |
| `POST /api/deals/:id/refund` | Approver | `approval` | Start the refund |
| `GET /api/approvals` | Approver | `approval` | Gains the kinds `refundable` (each `funded` Deal with no Payout) and `refund_failed`, counted in `total` |
| `GET /api/deals/:id` | Buyer, Seller | `deals` | Gains each Milestone's Payout state, paid time and Seller reference, and the refund |
| `PUT /api/deals/:id/milestones/:milestoneId/reference` | Seller of the Deal | `deals` | Set or clear `payouts.seller_reference` |
| `PATCH /api/session/user` | signed in | `identity` | Change the display name |
| `GET /api/payouts/mine` | Seller | `deals` | The Seller's Payout history, paginated |
| `GET /api/deals/:id/audit.csv` | Buyer, Seller of the Deal | `deals` | The Deal's audit events as CSV, read through `audit` |
| `GET /api/health` | public | `routes/health.ts` | Gains the migration count and the round-trip time |

Every state-changing route keeps the existing CSRF check, rate limit and strict body.

### Express Payouts

The accept action in `milestones` checks the Deal's `express` column after it marks the Milestone `accepted`. For an express Deal it creates the Payout with `createPendingPayout` from `payout`, with the Buyer as its approver, sends the transfer through the chain with the Payout's Idempotency key, and on confirmation calls `confirmPayout` from `payout`. A transfer that does not confirm leaves the Payout `pending` for the retry job.

### Refunds

The chain port gains `refund(buyer, amount, key)`, and the fake chain implements it like `transfer`. The refund action in `approval` runs in three steps:

1. One transaction locks the Deal row, checks that it is `funded` with no Payout in any state, sets it `refunding` and stores a new refund key.
2. The chain call runs outside any transaction.
3. On confirmation, one transaction writes the ledger refund, sets the Deal `refunded` and writes the audit event.

The retry job in `payout` also retries each Deal in `refunding` whose next try time has passed, with the same key, with the same backoff, and after 5 tries sets `refund_failed`.

The approve action, the express accept, the demo loop, `confirmPayout` and the Payout retry each check that the Deal is `funded` before they write or send a Payout.

### Demo mode

`config.ts` gains `DEMO_AUTO_APPROVE` (boolean). Its default is `true` unless `NODE_ENV` is `production`, and the config refuses `true` in production. When it is on, `server.ts` starts a loop in a new file `apps/api/src/demo.ts` that runs every 30 seconds. The loop finds each `accepted` Milestone with no Payout on a `funded` Deal and pays it with `createPendingPayout`, the chain transfer and `confirmPayout` from `payout`, with Erin Approver as its approver.

### Web pages

- Deal list: a search box and a state filter.
- Deal detail: notes, the cancel button for a draft, the express setting (view only), the Payout words and references, the refund notice and the export link.
- Create Deal: an "Express" checkbox, on by default.
- New pages: Payout history (Seller) and Profile (display name).
- Approval queue: a Refund button on each `refundable` item, and the `refund_failed` items.

## Gating and rollout

- **Gating:** per-Deal setting `express`, default on for new Deals and off for existing Deals, scope one Deal, removed never (it is a product setting). Config value `DEMO_AUTO_APPROVE`, default on outside production and refused in production, scope one running app, removed never. Refunds: existing scoping (`requireRole(db, "approver")`) keeps the action to Approvers. Cancel changes the default Deal list, and the `cancelled` filter keeps the Deals visible. Everything else: not required — it only adds behaviour, and existing scoping (`requireRole` and the Deal owner checks) keeps each action to its users.
- **Rollout:** Incremental issues into `main`. The first issue that adds a Deal state adds all the new states in the migration and in `packages/shared`, and is never reverted. Each later issue can be reverted on its own. A revert never removes a migration.

## Data and compliance

Notes, references and display names are free text from synthetic users. The app holds no real personal data, and `.claude/factory.json` names no Compliance regime.

## Out of scope

- Partial refunds and refunds after a Payout.
- A Buyer's request for a refund.
- Editing or deleting a note.
- Notifications.
- More than one currency.

## Risks

- A refund and a Payout on the same Deal at the same time. The refund locks the Deal row and refuses a Deal with any Payout, and every Payout path checks that the Deal is `funded`.
- A large Deal list makes the title search slow. The search has its own index and uses the existing pagination.

## Open questions

- none
