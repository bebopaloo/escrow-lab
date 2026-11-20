import { createDatabase } from "@escrow-lab/db";
import { createChain } from "./adapters/chain/index.ts";
import { createPaymentRail } from "./adapters/payment-rail/index.ts";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { startDemoLoopWhenOn } from "./demo.ts";
import { createFundingRetryJob } from "./modules/payout/index.ts";

const config = loadConfig();
const database = createDatabase(config.DATABASE_URL);
const chain = createChain();
const paymentRail = createPaymentRail();
const app = await buildApp({ config, db: database.db, chain, paymentRail });
const fundingRetry = createFundingRetryJob({
  db: database.db,
  chain,
  paymentRail,
  onError: (error) => {
    app.log.error({ err: error }, "funding retry failed");
  },
});
fundingRetry.start();
const demoLoop = startDemoLoopWhenOn(config.DEMO_AUTO_APPROVE, {
  db: database.db,
  chain,
  log: app.log,
  onError: (error) => {
    app.log.error({ err: error }, "demo loop failed");
  },
});
app.addHook("onClose", async () => {
  fundingRetry.stop();
  demoLoop?.stop();
  await database.close();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close();
  });
}

await app.listen({ host: config.HOST, port: config.PORT });
