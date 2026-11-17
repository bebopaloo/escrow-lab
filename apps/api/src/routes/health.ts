import type { Database } from "@escrow-lab/db";
import { HealthResponse } from "@escrow-lab/shared";
import { sql } from "drizzle-orm";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";

export interface HealthOptions {
  db: Database;
}

export const healthRoutes: FastifyPluginCallbackZod<HealthOptions> = (app, { db }, done) => {
  app.get(
    "/health",
    {
      config: { public: true },
      schema: { response: { 200: HealthResponse, 503: HealthResponse } },
    },
    async (request, reply) => {
      try {
        const started = performance.now();
        const rows = await db.execute<{ count: number }>(
          sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
        );
        const databaseMs = Math.round((performance.now() - started) * 100) / 100;
        return { status: "ok" as const, migrations: rows[0]?.count ?? 0, databaseMs };
      } catch (error) {
        request.log.warn({ err: error }, "database check failed");
        return reply.status(503).send({ status: "unavailable" });
      }
    },
  );
  done();
};
