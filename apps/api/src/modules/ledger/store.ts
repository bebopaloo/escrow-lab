import { schema, type Database } from "@escrow-lab/db";

export interface NewDeposit {
  dealId: string;
  amountMinor: number;
  chainTxId: string;
}

/**
 * Appends the deposit of a Deal. Call it only when the chain has confirmed the lock.
 * Pass a transaction to write it with the other rows of the funding step.
 */
export async function recordDeposit(
  db: Pick<Database, "insert">,
  deposit: NewDeposit,
): Promise<void> {
  await db.insert(schema.ledgerEntries).values({ ...deposit, kind: "deposit" });
}

export interface NewPayout {
  dealId: string;
  amountMinor: number;
  chainTxId: string;
}

/**
 * Appends a Payout. Call it only when the chain has confirmed the transfer, in the transaction that
 * marks the Milestone paid.
 */
export async function recordPayout(db: Pick<Database, "insert">, payout: NewPayout): Promise<void> {
  await db.insert(schema.ledgerEntries).values({ ...payout, kind: "payout" });
}
