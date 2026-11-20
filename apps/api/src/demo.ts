import { SEED_USERS, schema, type Database } from "@escrow-lab/db";
import { and, asc, eq, exists, isNull, notExists, or } from "drizzle-orm";
import type { Chain } from "./adapters/chain/index.ts";
import { approvePayout } from "./modules/approval/index.ts";

const INTERVAL_MS = 30_000;
const BATCH_SIZE = 50;
/** Erin Approver, the seeded user that demo Payouts name as approver. */
const DEMO_APPROVER_ID = SEED_USERS[4]?.id ?? "";

export interface DemoLoopOptions {
  db: Database;
  chain: Chain;
  log: { warn: (message: string) => void };
  /** The Approver that the demo Payouts name. The default is Erin Approver. */
  approverId?: string;
  intervalMs?: number;
  /** Called when a timed run throws. The next run still happens. */
  onError?: (error: unknown) => void;
}

/**
 * Demo mode. Each run pays every `accepted` Milestone on a `funded` Deal that has no Payout, or that has an express Payout with no approver, with
 * the seeded Approver as approver. It uses `approvePayout`, so a demo Payout has the same
 * Idempotency key, ledger entry and `approve_payout` audit event as a real one.
 */
export function createDemoLoop(options: DemoLoopOptions) {
  const { db, chain, log } = options;
  const approverId = options.approverId ?? DEMO_APPROVER_ID;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> = Promise.resolve();

  async function run(): Promise<void> {
    const [approver] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.id, approverId), eq(schema.users.role, "approver")));
    if (approver === undefined) {
      log.warn("Demo mode: the seeded Approver is missing, so no Milestone is paid.");
      return;
    }
    const due = await db
      .select({ id: schema.milestones.id })
      .from(schema.milestones)
      .innerJoin(schema.deals, eq(schema.deals.id, schema.milestones.dealId))
      .where(
        and(
          eq(schema.milestones.state, "accepted"),
          eq(schema.deals.state, "funded"),
          or(
            notExists(
              db
                .select({ id: schema.payouts.id })
                .from(schema.payouts)
                .where(eq(schema.payouts.milestoneId, schema.milestones.id)),
            ),
            // An express Payout waits for an approver. `approvePayout` claims it for the demo Approver.
            exists(
              db
                .select({ id: schema.payouts.id })
                .from(schema.payouts)
                .where(
                  and(
                    eq(schema.payouts.milestoneId, schema.milestones.id),
                    eq(schema.payouts.express, true),
                    eq(schema.payouts.state, "pending"),
                    isNull(schema.payouts.approvedBy),
                  ),
                ),
            ),
          ),
        ),
      )
      .orderBy(asc(schema.milestones.id))
      .limit(BATCH_SIZE);
    for (const { id } of due) await approvePayout(db, chain, approverId, id);
  }

  const loop = {
    /** One pass over the accepted Milestones. */
    runOnce(): Promise<void> {
      const pass = running.then(run);
      running = pass.catch(() => undefined);
      return pass;
    },
    start(): void {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        loop.runOnce().catch(options.onError ?? (() => undefined));
      }, options.intervalMs ?? INTERVAL_MS);
    },
    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
  return loop;
}

/**
 * Starts the demo loop only when the setting is on (`CTRL-PAY-03`). Returns the running loop, or
 * `undefined` when the setting is off, so the server never creates a timer in that case.
 */
export function startDemoLoopWhenOn(enabled: boolean, options: DemoLoopOptions) {
  if (!enabled) return undefined;
  const loop = createDemoLoop(options);
  loop.start();
  return loop;
}
