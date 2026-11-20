import type { Result } from "../fake-core.ts";

export type { Failure, Result as ChainResult } from "../fake-core.ts";

export interface Chain {
  lock(deal: string, amount: number, key: string): Promise<Result>;
  transfer(seller: string, amount: number, key: string): Promise<Result>;
  /** Returns the locked money of a Deal to its Buyer. The key makes a repeat return the first result. */
  refund(buyer: string, amount: number, key: string): Promise<Result>;
}
