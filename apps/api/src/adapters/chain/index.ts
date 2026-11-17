import { createFakeChain } from "./fake.ts";
import type { Chain } from "./port.ts";

export type { Chain, ChainResult, ChainStatus, Failure } from "./port.ts";
export type { FakeChain } from "./fake.ts";
export type { Step } from "../fake-core.ts";

/** Test use only: a lint rule rejects this import and a dynamic import of it in production files. */
export { createFakeChain } from "./fake.ts";

/** Production factory. It takes no argument, so no config can give it a failure script. */
export function createChain(): Chain {
  return createFakeChain();
}
