import { z } from "zod";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const ZERO_KEY = "0".repeat(64);

const ConfigSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    SESSION_KEY: z.string().regex(/^[0-9a-f]{64}$/i),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(41030),
    CORS_ORIGINS: z
      .string()
      .default("http://127.0.0.1:41073")
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0),
      ),
    LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  })
  // The dev script uses the all-zero key. It is not a secret, so production refuses it.
  .refine((config) => config.NODE_ENV !== "production" || config.SESSION_KEY !== ZERO_KEY, {
    path: ["SESSION_KEY"],
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const names = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${names}`);
  }
  return result.data;
}
