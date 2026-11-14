import { createFakeCore } from "../fake-core.ts";
import type { FakeEvent, Step } from "../fake-core.ts";
import type { Chain } from "./port.ts";

export interface FakeChain extends Chain {
  readonly moved: number;
  readonly events: readonly FakeEvent[];
}

export function createFakeChain(script: readonly Step[] = []): FakeChain {
  const core = createFakeCore(script);
  return {
    get moved() {
      return core.moved;
    },
    get events() {
      return core.events;
    },
    lock: (deal, amount, key) => core.run(deal, amount, key),
    transfer: (seller, amount, key) => core.run(seller, amount, key),
    status: (key) => core.status(key),
  };
}
