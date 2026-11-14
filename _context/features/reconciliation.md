# Reconciliation

**Status:** Approved
**Work items:** #33

## Problem

The ledger and the chain can disagree. A lost chain reply, a retry that ends in a different state, or a fault in the app can leave a transfer on the chain with no ledger Payout, or a ledger row with no transfer. Today nobody sees this. An Approver finds out only when a Seller says they were not paid, or when the totals do not add up.

## Users

- **Approver**: reads the mismatches, fixes the ones that the app can fix, and watches for old ones.

## Acceptance criteria

### Find a transfer with no ledger Payout
- **Given** a `failed` Payout whose key the chain has confirmed, and no ledger Payout with that chain transaction id
- **When** the reconciliation job runs
- **Then** the job records one open mismatch of kind "missing in ledger" with the Deal, the Payout, the chain transaction id and the chain amount

### Find a deposit with no ledger row
- **Given** a Deal in `funding_failed` whose funding key the chain has confirmed, and no ledger deposit
- **When** the reconciliation job runs
- **Then** the job records one open mismatch of kind "missing in ledger" with the Deal, no Payout, the chain transaction id and the chain amount

### Find a ledger row with no transfer
- **Given** a ledger Payout or deposit whose key the chain does not know
- **When** the reconciliation job runs
- **Then** the job records one open mismatch of kind "missing on chain" with the Deal, the Payout or deposit, the chain transaction id and the ledger amount

### Find a different amount
- **Given** a ledger row whose amount differs from the chain's amount for the same key
- **When** the reconciliation job runs
- **Then** the job records one open mismatch of kind "amount differs" with both amounts

### Run again
- **Given** an open mismatch
- **When** the next run checks its key and finds no difference
- **Then** the job closes the mismatch with the time
- [ ] The job runs every hour, and one run at a time. A second run records no duplicate for a mismatch that is still open.
- [ ] When the kind for an open key changes, the job closes the old mismatch and opens one of the new kind.
- [ ] A key that the run skips (a locked row or a chain failure) keeps its open mismatch.
- [ ] The job checks only Payouts and Deals created at or after its `startedAt`, and never closes a mismatch found before `startedAt`.

### See the mismatches
- **Given** open mismatches
- **When** an Approver opens the Reconciliation page
- **Then** the page lists each open mismatch with its kind, the Deal title, the amounts, the chain transaction id and the time it was found, oldest first, paginated
- [ ] A Buyer or a Seller gets 403 on the page and on every reconciliation route.

### Fix a mismatch
- **Given** an open mismatch of kind "missing in ledger" with a `failed` Payout
- **When** an Approver presses "Fix"
- **Then** the app records the Payout from the chain transaction: the ledger has the Payout, the Payout is "confirmed", the Milestone is "paid", the next Milestone opens or the Deal completes, and the mismatch is closed as fixed by that Approver
- [ ] A mismatch of any other kind, or with no Payout, has no Fix button, and the fix route returns 409 for it.
- [ ] If the Payout is no longer `failed`, the fix returns 409 and changes nothing, and the next run closes the mismatch.
- [ ] A second Fix on the same mismatch returns 409 and changes nothing. An unknown mismatch id returns 404.
- [ ] The fix writes the `fix_mismatch` audit event.

### Warn about old mismatches
- **Given** an open mismatch that was found more than 24 hours ago
- **When** an Approver opens the approval queue
- **Then** the page shows a banner with the number of old mismatches and a link to the Reconciliation page

## Design

### Module

A new module `apps/api/src/modules/reconciliation/` holds the job, the routes and the mismatch store. It exposes only `index.ts`, like every module.

### Chain port

The chain port gains `status(key)`. It returns `{ state: "confirmed", txId, amount }` for a key the chain has confirmed, `{ state: "unknown" }` for any other key, or `{ state: "failed", failure }`. The fake chain answers from its seen keys, and its `status` takes the next step of the failure script, like `lock` and `transfer`.

### Data model

- `mismatches` (new): id, kind (`missing_in_ledger`, `missing_on_chain`, `amount_differs`), Deal id, Payout id (null for a deposit), Idempotency key, chain transaction id, ledger amount, chain amount, found at, closed at, fixed by. A partial unique index allows one open row for each key.
- `audit_events`: new action `fix_mismatch`.

A ledger `payout` row belongs to the Payout with the same chain transaction id. A ledger `deposit` row belongs to its Deal.

### Job

An in-process job in `reconciliation`, started from `server.ts` with a `startedAt` time, runs every hour. Tests pass `startedAt` and drive the job with fake timers. It checks each Payout in `confirmed` or `failed`, and each Deal in `funded`, `completed` or `funding_failed`. It skips a Payout in `pending` and a Deal in `funding`, because the retry job owns them.

For each key, the job calls `status(key)` outside any transaction. A chain failure skips the key for this run. Then one short transaction locks the Payout or Deal with `FOR UPDATE SKIP LOCKED`, reads its state and ledger rows again, and opens or closes the mismatch.

### API

| Route | Who | Does |
|---|---|---|
| `GET /api/reconciliation/mismatches` | Approver | The open mismatches, oldest first, paginated, with the count of old ones |
| `POST /api/reconciliation/mismatches/:id/fix` | Approver | Fix a `missing_in_ledger` mismatch with a `failed` Payout |

The fix route has the existing CSRF check, rate limit and strict body. In one transaction it locks the mismatch row and the Payout row, checks that the mismatch is open and `missing_in_ledger` and that the Payout is `failed`, records the ledger Payout with `recordPayout` from `ledger`, sets the Payout `confirmed` with the chain transaction id, marks the Milestone paid with `markPaidAndOpenNext` from `milestones`, completes the Deal with `completeDeal` from `deals` after the last Milestone, closes the mismatch with the Approver as `fixed by`, and writes the audit event.

### Web pages

- New Reconciliation page for the Approver.
- Approval queue: the old-mismatch banner.

## Gating and rollout

- **Gating:** not required — the feature adds a job, a table, two routes, a page, a chain port method and an audit action, and existing scoping (`requireRole(db, "approver")`) keeps it to Approvers.
- **Rollout:** Integrated. The issues merge into `feature/reconciliation`, and one final pull request takes the feature into `main`. Each migration only adds. To undo, revert the final pull request. The `mismatches` table then stays in a migrated database, and no code reads it.

## Data and compliance

All amounts and users are synthetic. The feature adds no personal data.

## Out of scope

- Fixes for "missing on chain", "amount differs" and deposit mismatches.
- Ledger rows that match no Payout or Deal key.
- Refund keys, and reconciliation of the payment rail.
- Alerts outside the app, such as email.

## Risks

- The fake chain keeps its keys in memory, so the job checks only rows created since the API started. A Deal created before a restart is not checked.
- A Fix that runs while an Approver retries the same Payout. The Fix locks the Payout row and needs it `failed`.

## Open questions

- none
