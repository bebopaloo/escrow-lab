import type { KeyStatus, Result } from "../fake-core.ts";

export type { Failure, KeyStatus as ChainStatus, Result as ChainResult } from "../fake-core.ts";

export interface Chain {
  lock(deal: string, amount: number, key: string): Promise<Result>;
  transfer(seller: string, amount: number, key: string): Promise<Result>;
  /** What the chain knows about an Idempotency key. It moves no money. */
  status(key: string): Promise<KeyStatus>;
}
