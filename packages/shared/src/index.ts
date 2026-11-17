import { z } from "zod";

export const HealthResponse = z
  .object({
    status: z.enum(["ok", "unavailable"]),
    migrations: z.number().int().nonnegative().optional(),
    databaseMs: z.number().nonnegative().optional(),
  })
  .strict();

export type HealthResponse = z.infer<typeof HealthResponse>;
export * from "./identity.ts";
export * from "./deals.ts";
export * from "./approvals.ts";
