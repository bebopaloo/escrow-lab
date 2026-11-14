import { schema, type Database } from "@escrow-lab/db";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { Chain } from "../../adapters/chain/index.ts";
import type { PaymentRail } from "../../adapters/payment-rail/index.ts";
import { recordAuditEvent } from "../audit/index.ts";
import { backToDraft, confirmFunding } from "../deals/index.ts";

export const MAX_FUNDING_TRIES = 5;
const INTERVAL_MS = 30_000;
const FIRST_WAIT_MS = 1_000;
const LEASE_MS = 30_000;
const BATCH_SIZE = 50;

export interface FundingRetryOptions {
  db: Database;
  chain: Chain;
  paymentRail: PaymentRail;
  /** The clock. Tests pass their own. */
  now?: () => Date;
  intervalMs?: number;
  /** Called when a timed run throws. The next run still happens. */
  onError?: (error: unknown) => void;
}

export interface RunOptions {
  /** Limits a run to these Deals. Tests use it; the timer does not. */
  dealIds?: string[];
}

interface Claimed {
  id: string;
  buyerId: string;
  totalMinor: number;
  key: string;
  attempts: number;
}

/**
 * The retry job for Deals in `funding`. Each try sends the charge and the lock again with the
 * Deal's stored Idempotency key, so the partners return their first result.
 */
export function createFundingRetryJob(options: FundingRetryOptions) {
  const { db, chain, paymentRail } = options;
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> = Promise.resolve();

  /**
   * Takes a row lock on the Deal, skips it when another try holds it, and leases it by moving its
   * next try time forward. The partner calls then run outside the transaction.
   */
  async function claim(dealId: string): Promise<Claimed | undefined> {
    const at = now();
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: schema.deals.id,
          buyerId: schema.deals.buyerId,
          totalMinor: schema.deals.totalMinor,
          key: schema.deals.fundingIdempotencyKey,
          attempts: schema.deals.fundingAttempts,
        })
        .from(schema.deals)
        .where(
          and(
            eq(schema.deals.id, dealId),
            eq(schema.deals.state, "funding"),
            or(isNull(schema.deals.nextFundingTryAt), lte(schema.deals.nextFundingTryAt, at)),
          ),
        )
        .for("update", { skipLocked: true });
      if (row === undefined || row.key === null) return undefined;
      await tx
        .update(schema.deals)
        .set({ nextFundingTryAt: new Date(at.getTime() + LEASE_MS) })
        .where(eq(schema.deals.id, row.id));
      return { ...row, key: row.key };
    });
  }

  async function recordFailure(deal: Claimed): Promise<void> {
    const attempts = deal.attempts + 1;
    const waitMs = FIRST_WAIT_MS * 2 ** (attempts - 1);
    await db.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.deals)
        .set(
          attempts >= MAX_FUNDING_TRIES
            ? { state: "funding_failed", fundingAttempts: attempts, nextFundingTryAt: null }
            : {
                fundingAttempts: attempts,
                nextFundingTryAt: new Date(now().getTime() + waitMs),
              },
        )
        .where(
          and(
            eq(schema.deals.id, deal.id),
            eq(schema.deals.state, "funding"),
            eq(schema.deals.fundingIdempotencyKey, deal.key),
          ),
        )
        .returning({ id: schema.deals.id });
      if (row !== undefined && attempts >= MAX_FUNDING_TRIES) {
        await recordAuditEvent(tx, {
          userId: deal.buyerId,
          action: "funding_failed",
          dealId: deal.id,
        });
      }
    });
  }

  async function tryDeal(deal: Claimed): Promise<void> {
    const charge = await paymentRail.charge(deal.buyerId, deal.totalMinor, deal.key);
    if (!charge.ok) {
      if (charge.failure === "refused") await backToDraft(db, deal.id, deal.key);
      else await recordFailure(deal);
      return;
    }
    const lock = await chain.lock(deal.id, deal.totalMinor, deal.key);
    if (!lock.ok) {
      await recordFailure(deal);
      return;
    }
    await confirmFunding(db, {
      buyerId: deal.buyerId,
      dealId: deal.id,
      key: deal.key,
      totalMinor: deal.totalMinor,
      chainTxId: lock.txId,
    });
  }

  async function run(filter: RunOptions): Promise<void> {
    const at = now();
    const due = await db
      .select({ id: schema.deals.id })
      .from(schema.deals)
      .where(
        and(
          eq(schema.deals.state, "funding"),
          or(isNull(schema.deals.nextFundingTryAt), lte(schema.deals.nextFundingTryAt, at)),
          filter.dealIds === undefined ? undefined : inArray(schema.deals.id, filter.dealIds),
        ),
      )
      .orderBy(asc(schema.deals.nextFundingTryAt))
      .limit(BATCH_SIZE);
    for (const { id } of due) {
      const deal = await claim(id);
      if (deal !== undefined) await tryDeal(deal);
    }
  }

  const job = {
    /** One pass over the Deals that are due. */
    runOnce(filter: RunOptions = {}): Promise<void> {
      const pass = running.then(() => run(filter));
      running = pass.catch(() => undefined);
      return pass;
    },
    start(): void {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        job.runOnce().catch(options.onError ?? (() => undefined));
      }, intervalMs);
    },
    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
  return job;
}
