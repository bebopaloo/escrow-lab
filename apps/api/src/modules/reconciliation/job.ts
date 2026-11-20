import { schema, type Database } from "@escrow-lab/db";
import { and, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Chain, ChainStatus } from "../../adapters/chain/index.ts";

const INTERVAL_MS = 3_600_000;

export interface ReconciliationOptions {
  db: Database;
  chain: Chain;
  /** The job checks only Payouts and Deals created at or after this time, and never closes an older mismatch. */
  startedAt: Date;
  /** The clock. Tests pass their own. */
  now?: () => Date;
  intervalMs?: number;
  /** Called when a timed run throws. The next run still happens. */
  onError?: (error: unknown) => void;
}

type Kind = (typeof schema.mismatches.$inferInsert)["kind"];

interface Target {
  type: "payout" | "deal";
  id: string;
  key: string;
}

interface Finding {
  kind: Kind;
  chainTxId: string;
  ledgerAmountMinor: number | null;
  chainAmountMinor: number | null;
}

interface Locked {
  dealId: string;
  payoutId: string | null;
  /** The chain transaction id that the ledger row of a Payout carries, when the Payout has one. */
  chainTxId: string | null;
}

interface LedgerRow {
  amountMinor: number;
  chainTxId: string;
}

/** Compares what the chain says about a key with the ledger row for it. Null means no difference. */
function compare(
  status: Extract<ChainStatus, { state: "confirmed" | "unknown" }>,
  ledgerRow: LedgerRow | undefined,
): Finding | null {
  if (status.state === "confirmed") {
    if (ledgerRow === undefined) {
      return {
        kind: "missing_in_ledger",
        chainTxId: status.txId,
        ledgerAmountMinor: null,
        chainAmountMinor: status.amount,
      };
    }
    if (ledgerRow.amountMinor === status.amount) return null;
    return {
      kind: "amount_differs",
      chainTxId: status.txId,
      ledgerAmountMinor: ledgerRow.amountMinor,
      chainAmountMinor: status.amount,
    };
  }
  if (ledgerRow === undefined) return null;
  return {
    kind: "missing_on_chain",
    chainTxId: ledgerRow.chainTxId,
    ledgerAmountMinor: ledgerRow.amountMinor,
    chainAmountMinor: null,
  };
}

/**
 * The hourly job. For each Payout and Deal that the retry job no longer owns, it asks the chain
 * about the Idempotency key, compares the answer with the ledger and opens or closes the mismatch.
 */
export function createReconciliationJob(options: ReconciliationOptions) {
  const { db, chain, startedAt } = options;
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> = Promise.resolve();

  async function targets(): Promise<Target[]> {
    const payouts = await db
      .select({ id: schema.payouts.id, key: schema.payouts.idempotencyKey })
      .from(schema.payouts)
      .where(
        and(
          inArray(schema.payouts.state, ["confirmed", "failed"]),
          gte(schema.payouts.createdAt, startedAt),
        ),
      );
    const deals = await db
      .select({ id: schema.deals.id, key: schema.deals.fundingIdempotencyKey })
      .from(schema.deals)
      .where(
        and(
          inArray(schema.deals.state, ["funded", "completed", "funding_failed"]),
          isNotNull(schema.deals.fundingIdempotencyKey),
          gte(schema.deals.createdAt, startedAt),
        ),
      );
    return [
      ...payouts.map((row) => ({ type: "payout" as const, ...row })),
      ...deals.flatMap((row) =>
        row.key === null ? [] : [{ type: "deal" as const, id: row.id, key: row.key }],
      ),
    ];
  }

  /** Locks the row, skips it when another transaction holds it, and reads its state again. */
  async function lock(tx: Pick<Database, "select">, target: Target): Promise<Locked | undefined> {
    if (target.type === "deal") {
      const [deal] = await tx
        .select({ id: schema.deals.id })
        .from(schema.deals)
        .where(
          and(
            eq(schema.deals.id, target.id),
            inArray(schema.deals.state, ["funded", "completed", "funding_failed"]),
          ),
        )
        .for("update", { skipLocked: true });
      return deal === undefined ? undefined : { dealId: deal.id, payoutId: null, chainTxId: null };
    }
    const [payout] = await tx
      .select({
        id: schema.payouts.id,
        chainTxId: schema.payouts.chainTxId,
        dealId: schema.milestones.dealId,
      })
      .from(schema.payouts)
      .innerJoin(schema.milestones, eq(schema.milestones.id, schema.payouts.milestoneId))
      .where(
        and(
          eq(schema.payouts.id, target.id),
          inArray(schema.payouts.state, ["confirmed", "failed"]),
        ),
      )
      .for("update", { of: schema.payouts, skipLocked: true });
    return payout === undefined
      ? undefined
      : { dealId: payout.dealId, payoutId: payout.id, chainTxId: payout.chainTxId };
  }

  async function ledgerRowOf(
    tx: Pick<Database, "select">,
    locked: Locked,
    chainTxId: string | null,
  ): Promise<LedgerRow | undefined> {
    const where =
      locked.payoutId === null
        ? and(
            eq(schema.ledgerEntries.dealId, locked.dealId),
            eq(schema.ledgerEntries.kind, "deposit"),
          )
        : chainTxId === null
          ? undefined
          : and(
              eq(schema.ledgerEntries.dealId, locked.dealId),
              eq(schema.ledgerEntries.kind, "payout"),
              eq(schema.ledgerEntries.chainTxId, chainTxId),
            );
    if (where === undefined) return undefined;
    const [row] = await tx
      .select({
        amountMinor: schema.ledgerEntries.amountMinor,
        chainTxId: schema.ledgerEntries.chainTxId,
      })
      .from(schema.ledgerEntries)
      .where(where);
    return row;
  }

  async function reconcile(target: Target): Promise<void> {
    const status = await chain.status(target.key);
    if (status.state === "failed") return;
    await db.transaction(async (tx) => {
      const locked = await lock(tx, target);
      if (locked === undefined) return;
      const chainTxId = locked.chainTxId ?? (status.state === "confirmed" ? status.txId : null);
      const finding = compare(status, await ledgerRowOf(tx, locked, chainTxId));
      const [open] = await tx
        .select()
        .from(schema.mismatches)
        .where(
          and(eq(schema.mismatches.idempotencyKey, target.key), isNull(schema.mismatches.closedAt)),
        );
      if (open !== undefined) {
        if (open.foundAt < startedAt || open.kind === finding?.kind) return;
        await tx
          .update(schema.mismatches)
          .set({ closedAt: now() })
          .where(eq(schema.mismatches.id, open.id));
      }
      if (finding === null) return;
      await tx.insert(schema.mismatches).values({
        ...finding,
        dealId: locked.dealId,
        payoutId: locked.payoutId,
        idempotencyKey: target.key,
        foundAt: now(),
      });
    });
  }

  async function run(): Promise<void> {
    for (const target of await targets()) await reconcile(target);
  }

  const job = {
    /** One pass over every Payout and Deal that the job checks. Passes never overlap. */
    runOnce(): Promise<void> {
      const pass = running.then(run);
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
