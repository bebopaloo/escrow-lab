import type { Result } from "../fake-core.ts";

export type { Failure, Result as ChainResult } from "../fake-core.ts";

export interface Chain {
  lock(deal: string, amount: number, key: string): Promise<Result>;
  transfer(seller: string, amount: number, key: string): Promise<Result>;
}
