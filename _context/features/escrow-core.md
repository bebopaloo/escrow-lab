# Escrow core

**Status:** Approved
**Work items:** #2

## Problem

The factory has no proof that Risk tiers from paths, LLM tier escalation and unattended merges work on code that moves money. escrow-lab needs a money-moving core with clear `authority`, `sensitive` and `general` modules, so that the seeded backlog has real code to change. Without it, every later feature has nothing to build on.

## Users

- **Buyer**: creates a Deal, funds its Escrow, accepts or rejects the evidence for each Milestone.
- **Seller**: sends the evidence for each Milestone and receives each Payout.
- **Approver**: approves each Payout after the Buyer accepts the evidence (Dual control).

All users are synthetic and seeded. Each user has exactly one role.

## Acceptance criteria

### Sign in
- **Given** the seeded users
- **When** a person opens the sign-in page and chooses a user
- **Then** the app signs them in as that user. A Buyer or a Seller sees the Deal list. An Approver sees the approval queue.

### Create a Deal
- **Given** a signed-in Buyer
- **When** the Buyer creates a Deal with a Seller, a total of £1,000 and Milestones of £400 and £600
- **Then** the Deal is in "draft" and the Seller can see it

### Refuse a Deal whose Milestones do not add up
- **Given** a Buyer who enters a total of £1,000 and Milestones of £400 and £500
- **When** the Buyer creates the Deal
- **Then** the app refuses it and says that the Milestones must add up to the total

### Refuse a Deal outside the limits
- [ ] A Deal has 1 to 10 Milestones.
- [ ] Each Milestone is at least £0.01, and the total is at most £1,000,000.
- [ ] The Seller is a user with the Seller role. Any other user is refused.

### Fund a Deal
- **Given** a Deal in "draft"
- **When** the Buyer funds it, the payment rail accepts the charge and the chain confirms the lock
- **Then** the ledger has one deposit of £1,000, the Deal is "funded" and its first Milestone is "awaiting evidence"

### The payment rail refuses the charge
- **Given** a Deal in "draft" and a payment rail that refuses the charge
- **When** the Buyer funds it
- **Then** the Deal goes back to "draft", the ledger has no entry and the Buyer sees that the payment failed. The next try to fund it gets a new Idempotency key.

### The payment rail times out
- **Given** a Deal in "draft" and a payment rail that charges the Buyer but loses the reply
- **When** the Buyer funds it
- **Then** the Deal is "funding", the retry job sends the charge again with the same Idempotency key, and the Buyer is charged once

### The chain lock fails after the charge
- **Given** a payment rail that accepts the charge and a chain that times out on the lock
- **When** the Buyer funds the Deal
- **Then** the Deal is "funding", the app retries the lock with the same Idempotency key, and the ledger writes the deposit only when the chain confirms it

### Funding keeps failing
- **Given** a Deal in "funding" and a chain that fails every lock
- **When** the retry job has tried 5 times
- **Then** the Deal is "funding failed", the ledger has no deposit, and the Approver sees the Deal in the queue

### Send evidence
- **Given** a funded Deal whose current Milestone is "awaiting evidence"
- **When** the Seller sends evidence text of up to 2,000 characters
- **Then** the Milestone is "evidence sent" and the Buyer can see the evidence

### Reject the evidence
- **Given** a Milestone in "evidence sent"
- **When** the Buyer rejects it with a reason of up to 500 characters
- **Then** the Milestone goes back to "awaiting evidence", and the Seller sees the reason and can send new evidence

### Accept the evidence
- **Given** a Milestone in "evidence sent"
- **When** the Buyer accepts it
- **Then** the Milestone is "accepted" and is in the Approver's queue

### Approve a Payout
- **Given** an accepted Milestone of £400
- **When** an Approver approves the Payout and the chain confirms the transfer
- **Then** the ledger has one Payout of £400, the Milestone is "paid", and the next Milestone is "awaiting evidence"

### A lost chain reply does not pay twice
- **Given** an approved Payout and a chain that makes the transfer but loses the reply
- **When** the retry job sends the transfer again
- **Then** the chain returns the first transfer, and the ledger has exactly one Payout for the Milestone

### The chain keeps failing
- **Given** an approved Payout and a chain that fails every transfer
- **When** the retry job has tried 5 times
- **Then** the Payout is "failed", the ledger has no Payout, and the Approver sees the failure in the queue

### Retry a failed Payout
- **Given** a "failed" Payout
- **When** an Approver retries it
- **Then** the Payout is "pending" with its try count at 0 and the same Idempotency key, so the chain cannot pay twice

### Complete a Deal
- **Given** a Deal whose last Milestone becomes "paid"
- **Then** the Deal is "completed"

### Access control
- [ ] A Buyer or a Seller sees only the Deals where they are the Buyer or the Seller. Another Deal gives 404.
- [ ] Only the Buyer of a Deal can fund it, and accept or reject its evidence.
- [ ] Only the Seller of a Deal can send evidence.
- [ ] Only an Approver can see the approval queue and approve a Payout. A Buyer or a Seller gets 403.
- [ ] An Approver cannot approve a Payout for a Milestone that the Buyer has not accepted.
- [ ] Each of these actions writes one audit event with the user, the action, the Deal and the time: sign in, create a Deal, fund, send evidence, accept, reject, approve a Payout, retry a Payout, Payout confirmed, Payout failed, funding confirmed, funding failed.

### State rules
- [ ] An action on a Deal, a Milestone or a Payout in the wrong state returns 409 and changes nothing. For example, a second accept, a second approval, or evidence for a Milestone that is not "awaiting evidence".
- [ ] When the chain confirms a Payout, one database transaction writes the ledger entry, marks the Milestone "paid", opens the next Milestone or completes the Deal, and writes the audit event.

### Fakes
- [ ] Production config cannot turn on failure injection in any fake. A test proves this.
- [ ] Each fake rejects a known Idempotency key that comes with a different amount or party.

## Design

### Modules and Risk tiers

Each module is a folder in `apps/api/src/modules/<name>/` that exposes only `index.ts`. Adapters are in `apps/api/src/adapters/<name>/`. The Operator writes the Risk map in `_context/controls/risk-map.toml` from this table.

| Module or adapter | Risk tier | Holds |
|---|---|---|
| `payout` | `authority` | Payout state, Idempotency keys, the retry job |
| `approval` | `authority` | Dual control: the Approver queue and the approve action |
| `ledger` | `authority` | Append-only deposits and Payouts |
| `adapters/chain` | `authority` | Chain port, fake chain |
| `adapters/payment-rail` | `authority` | Payment rail port, fake payment rail |
| `identity` | `sensitive` | Seeded users, fake sign-in, sessions, role checks |
| `audit` | `sensitive` | Append-only audit events |
| `packages/db/migrations` | `sensitive` | Database migrations |
| `deals` | `general` | Deals and funding orchestration |
| `milestones` | `general` | Milestones, evidence, accept and reject |
| `apps/web` | `general` | The web pages |

### Data model

- `users`: id, display name, role (`buyer`, `seller`, `approver`). Seeded.
- `deals`: id, Buyer id, Seller id, total in minor units, currency (`GBP` only), state (`draft`, `funding`, `funding_failed`, `funded`, `completed`), funding Idempotency key, funding attempts, next funding try time. The app makes the funding key when the Deal goes from `draft` to `funding`, in the same transaction.
- `milestones`: id, Deal id, position, title, amount in minor units, state (`pending`, `awaiting_evidence`, `evidence_sent`, `accepted`, `paid`), evidence text, rejection reason.
- `payouts`: id, Milestone id (unique), Idempotency key (unique), state (`pending`, `confirmed`, `failed`), attempts, next try time, approved by, chain transaction id.
- `ledger_entries`: id, Deal id, kind (`deposit`, `payout`), amount in minor units, chain transaction id, time. Insert only.
- `audit_events`: id, user id, action, Deal id, time. Insert only.

Milestones run in order: only one Milestone of a Deal is open at one time.

### API

| Route | Who | Does |
|---|---|---|
| `GET /api/users` | public | The seeded users for the sign-in page |
| `POST /api/session`, `DELETE /api/session` | public, signed in | Sign in as a seeded user, sign out |
| `GET /api/deals`, `GET /api/deals/:id` | Buyer, Seller | Own Deals only, paginated |
| `POST /api/deals` | Buyer | Create a Deal with its Milestones |
| `POST /api/deals/:id/fund` | Buyer of the Deal | Charge, lock, write the deposit |
| `POST /api/milestones/:id/evidence` | Seller of the Deal | Send evidence |
| `POST /api/milestones/:id/accept`, `/reject` | Buyer of the Deal | Accept or reject evidence |
| `GET /api/approvals` | Approver | Accepted Milestones, failed Payouts and Deals in `funding_failed` |
| `POST /api/milestones/:id/payout` | Approver | Approve the Payout and make its first try |
| `POST /api/payouts/:id/retry` | Approver | Retry a failed Payout with its Idempotency key |

### Ports and fakes

- Chain port: `lock(deal, amount, key)` and `transfer(seller, amount, key)`. Each returns a transaction id or a typed failure.
- Payment rail port: `charge(buyer, amount, key)`.
- Each fake keeps its seen keys and their results in memory. A test can give a fake a failure script: delay, fail, lose the reply, or send a duplicate event. The composition root in `buildApp` builds the fakes with no script, and the config schema has no field for one.

### Retry job

The approve action writes the Payout as `pending` and makes the first try. An in-process job in `payout` runs every 30 seconds and makes the later tries. It tries each `pending` Payout whose next try time has passed, with the same Idempotency key, and doubles the wait after each failure, from 1 second. After 5 tries it marks the Payout `failed`. The same job retries the charge and the lock of a Deal in `funding`, and after 5 tries marks it `funding_failed`.

Before each try, the request or the job takes a row lock on the Payout or the Deal and skips a row that another try holds (`FOR UPDATE SKIP LOCKED`). Only a definite refusal from the payment rail returns a Deal to `draft`; a timeout or a lost reply keeps it in `funding`. Tests drive the job with fake timers.

### Config and seed data

- `SESSION_KEY`: the key for the signed session cookie, read and validated in the config module at start-up.
- `pnpm db:seed`: writes a fixed set of synthetic users: two Buyers, two Sellers and two Approvers. Tests use the same set.

### Web pages

Sign-in, Deal list, create Deal, Deal detail (with the actions for the signed-in role), and the approval queue.

## Gating and rollout

- **Gating:** not required — escrow-lab is new, has no users and no data, and is not deployed.
- **Rollout:** Incremental issues into `main`. The first issue creates an empty folder with an `index.ts` for each module and adapter in the Risk tier table. After it merges, the Operator adds the Risk map and the `controls` key in one pull request, and no other issue starts before that pull request merges. Every migration only adds. To undo a merged issue, revert its pull request.

## Data and compliance

All users and amounts are synthetic. The app holds no personal data, and `.claude/factory.json` names no Compliance regime.

## Out of scope

- Refunds, disputes and cancellation after funding.
- The Seller's acceptance of Deal terms.
- More than one currency.
- File uploads as evidence.
- Passwords, password reset and notifications.
- Real partner services.
- Reconciliation between the ledger and the chain (a later Integrated feature).

## Risks

- A double Payout. Idempotency keys and the unique Payout per Milestone defend against it.
- Drift between the ledger and the fake chain. Reconciliation answers it later.
- The Spec is large for one feature. `to-issues` must cut it into PR-sized slices.

## Open questions

- none
