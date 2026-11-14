import cors from "@fastify/cors";
import csrfProtection from "@fastify/csrf-protection";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import secureSession from "@fastify/secure-session";
import type { Database } from "@escrow-lab/db";
import Fastify, { type FastifyServerOptions } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { createChain, type Chain } from "./adapters/chain/index.ts";
import { createPaymentRail, type PaymentRail } from "./adapters/payment-rail/index.ts";
import type { Config } from "./config.ts";
import { dealRoutes } from "./modules/deals/index.ts";
import { identityRoutes } from "./modules/identity/index.ts";
import { milestoneRoutes } from "./modules/milestones/index.ts";
import { healthRoutes } from "./routes/health.ts";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Marks a route that needs no sign-in. Every other route needs an `onRequest` auth hook. */
    public?: boolean;
  }
}

export interface AppOptions {
  config: Config;
  db: Database;
  logger?: FastifyServerOptions["logger"];
  /** Defaults to `createChain()`. Tests pass a scripted fake. */
  chain?: Chain;
  /** Defaults to `createPaymentRail()`. Tests pass a scripted fake. */
  paymentRail?: PaymentRail;
}

const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const SESSION_COOKIE_NAME = "__Host-session";

const REDACTED_KEYS = ["req.headers.authorization", "req.headers.cookie", "*.password", "*.token"];

export async function buildApp({
  config,
  db,
  logger,
  chain = createChain(),
  paymentRail = createPaymentRail(),
}: AppOptions) {
  const app = Fastify({
    logger: logger ?? { level: config.LOG_LEVEL, redact: REDACTED_KEYS },
  }).withTypeProvider<ZodTypeProvider>();

  app.decorateRequest("user", null);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error, request, reply) => {
    const status = statusOf(error);
    if (status >= 500) {
      request.log.error({ err: error }, "request failed");
    }
    return reply
      .status(status)
      .send({ error: status >= 500 ? "Internal error" : "Bad request", requestId: request.id });
  });

  await app.register(helmet);
  await app.register(cors, { origin: config.CORS_ORIGINS });
  await app.register(secureSession, {
    key: Buffer.from(config.SESSION_KEY, "hex"),
    cookieName: SESSION_COOKIE_NAME,
    // The server refuses a session older than the cookie lifetime, even with a copied cookie.
    expiry: SESSION_MAX_AGE_SECONDS,
    cookie: {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE_SECONDS,
    },
  });
  await app.register(rateLimit, { global: false });
  await app.register(csrfProtection, { sessionPlugin: "@fastify/secure-session" });

  // Deny by default: an app route without an auth decision fails at start-up.
  // Added after the CORS plugin, whose preflight route needs no sign-in.
  app.addHook("onRoute", (route) => {
    if (route.config?.public !== true && route.onRequest === undefined) {
      throw new Error(`Route ${route.method.toString()} ${route.url} has no auth decision`);
    }
  });

  await app.register(healthRoutes, { prefix: "/api", db });
  await app.register(identityRoutes, { prefix: "/api", db });
  await app.register(dealRoutes, { prefix: "/api", db, chain, paymentRail });
  await app.register(milestoneRoutes, { prefix: "/api", db });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;

function statusOf(error: unknown): number {
  if (typeof error !== "object" || error === null) {
    return 500;
  }
  if ("validation" in error && error.validation) {
    return 400;
  }
  if ("statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  return 500;
}
