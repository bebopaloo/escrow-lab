import { createFakeCore } from "../fake-core.ts";
import type { FakeEvent, Step } from "../fake-core.ts";
import type { PaymentRail } from "./port.ts";

export interface FakePaymentRail extends PaymentRail {
  readonly moved: number;
  readonly events: readonly FakeEvent[];
}

export function createFakePaymentRail(script: readonly Step[] = []): FakePaymentRail {
  const core = createFakeCore(script);
  return {
    get moved() {
      return core.moved;
    },
    get events() {
      return core.events;
    },
    charge: (buyer, amount, key) => core.run(buyer, amount, key),
  };
}
