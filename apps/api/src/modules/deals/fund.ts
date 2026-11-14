import { randomUUID } from "node:crypto";
import { schema, type Database } from "@escrow-lab/db";
import { and, eq } from "drizzle-orm";
import type { Chain } from "../../adapters/chain/index.ts";
import type { PaymentRail } from "../../adapters/payment-rail/index.ts";
import { recordAuditEvent } from "../audit/index.ts";
import { recordDeposit } from "../ledger/index.ts";
import { openFirstMilestone } from "../milestones/index.ts";

export type FundOutcome =
  /** The Deal is not visible to this Buyer. */
  | { kind: "not_found" }
  /** The Deal is not in `draft`. */
  | { kind: "wrong_state" }
  /** The payment rail refused the charge. The Deal is back in `draft`. */
  | { kind: "refused" }
  /** The chain confirmed the lock and the Deal is `funded`. */
  | { kind: "funded" }
  /** A timeout or a lost reply: the Deal stays in `funding` for the retry job. */
  | { kind: "funding" };

export interface Partners {
  chain: Chain;
  paymentRail: PaymentRail;
}

const REQUEST_LEASE_MS = 30_000;
const FIRST_RETRY_WAIT_MS = 1_000;

interface Claim {
  key: string;
  totalMinor: number;
}

/** In one transaction: `draft` to `funding`, with a new Idempotency key. */
async function claimForFunding(
  db: Database,
  buyerId: string,
  dealId: string,
): Promise<Claim | "not_found" | "wrong_state"> {
  const key = randomUUID();
  const [claimed] = await db
    .update(schema.deals)
    .set({
      state: "funding",
      fundingIdempotencyKey: key,
      fundingAttempts: 0,
      // A lease: the retry job leaves the Deal alone while this request tries.
      nextFundingTryAt: new Date(Date.now() + REQUEST_LEASE_MS),
    })
    .where(
      and(
        eq(schema.deals.id, dealId),
        eq(schema.deals.buyerId, buyerId),
        eq(schema.deals.state, "draft"),
      ),
    )
    .returning({ totalMinor: schema.deals.totalMinor });
  if (claimed !== undefined) return { key, totalMinor: claimed.totalMinor };
  const [existing] = await db
    .select({ id: schema.deals.id })
    .from(schema.deals)
    .where(and(eq(schema.deals.id, dealId), eq(schema.deals.buyerId, buyerId)));
  return existing === undefined ? "not_found" : "wrong_state";
}

export async function backToDraft(db: Database, dealId: string, key: string): Promise<void> {
  await db
    .update(schema.deals)
    .set({ state: "draft", fundingIdempotencyKey: null, nextFundingTryAt: null })
    .where(
      and(
        eq(schema.deals.id, dealId),
        eq(schema.deals.state, "funding"),
        eq(schema.deals.fundingIdempotencyKey, key),
      ),
    );
}

/** In one transaction: the deposit, the Deal `funded`, the first Milestone open and the audit events. */
export async function confirmFunding(
  db: Database,
  input: { buyerId: string; dealId: string; key: string; totalMinor: number; chainTxId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [moved] = await tx
      .update(schema.deals)
      .set({ state: "funded" })
      .where(
        and(
          eq(schema.deals.id, input.dealId),
          eq(schema.deals.state, "funding"),
          eq(schema.deals.fundingIdempotencyKey, input.key),
        ),
      )
      .returning({ id: schema.deals.id });
    if (moved === undefined) return;
    await recordDeposit(tx, {
      dealId: input.dealId,
      amountMinor: input.totalMinor,
      chainTxId: input.chainTxId,
    });
    await openFirstMilestone(tx, input.dealId);
    await recordAuditEvent(tx, { userId: input.buyerId, action: "fund", dealId: input.dealId });
    await recordAuditEvent(tx, {
      userId: input.buyerId,
      action: "funding_confirmed",
      dealId: input.dealId,
    });
  });
}

/** The first try ended without a result: the retry job takes over after the first wait. */
async function scheduleRetry(db: Database, dealId: string, key: string): Promise<void> {
  await db
    .update(schema.deals)
    .set({ nextFundingTryAt: new Date(Date.now() + FIRST_RETRY_WAIT_MS) })
    .where(
      and(
        eq(schema.deals.id, dealId),
        eq(schema.deals.state, "funding"),
        eq(schema.deals.fundingIdempotencyKey, key),
      ),
    );
}

/**
 * Funds a Deal for its Buyer. The calls to the payment rail and the chain run outside any
 * transaction, both with the funding Idempotency key.
 */
export async function fundDeal(
  db: Database,
  partners: Partners,
  buyerId: string,
  dealId: string,
): Promise<FundOutcome> {
  const claim = await claimForFunding(db, buyerId, dealId);
  if (claim === "not_found" || claim === "wrong_state") return { kind: claim };

  const charge = await partners.paymentRail.charge(buyerId, claim.totalMinor, claim.key);
  if (!charge.ok) {
    if (charge.failure === "refused") {
      await backToDraft(db, dealId, claim.key);
      return { kind: "refused" };
    }
    await scheduleRetry(db, dealId, claim.key);
    return { kind: "funding" };
  }

  const lock = await partners.chain.lock(dealId, claim.totalMinor, claim.key);
  if (!lock.ok) {
    await scheduleRetry(db, dealId, claim.key);
    return { kind: "funding" };
  }

  await confirmFunding(db, { buyerId, dealId, ...claim, chainTxId: lock.txId });
  return { kind: "funded" };
}
