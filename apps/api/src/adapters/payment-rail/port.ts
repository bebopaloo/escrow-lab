import type { Result } from "../fake-core.ts";

export type { Failure, Result as PaymentRailResult } from "../fake-core.ts";

export interface PaymentRail {
  charge(buyer: string, amount: number, key: string): Promise<Result>;
}
