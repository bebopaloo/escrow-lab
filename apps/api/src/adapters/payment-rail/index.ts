import { createFakePaymentRail } from "./fake.ts";
import type { PaymentRail } from "./port.ts";

export type { Failure, PaymentRail, PaymentRailResult } from "./port.ts";
export type { FakePaymentRail } from "./fake.ts";
export type { Step } from "../fake-core.ts";

/** Test use only: a lint rule rejects this import and a dynamic import of it in production files. */
export { createFakePaymentRail } from "./fake.ts";

/** Production factory. It takes no argument, so no config can give it a failure script. */
export function createPaymentRail(): PaymentRail {
  return createFakePaymentRail();
}
