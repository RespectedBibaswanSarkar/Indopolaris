import "server-only";

import { z } from "zod";

/**
 * Centralised, validated environment access.
 *
 * Everything that touches the network or a secret goes through here so that a
 * missing variable fails at the first request with an actionable message,
 * rather than as `undefined` three layers deep in a query.
 *
 * Note: this module is `server-only`. Client components must never import it —
 * the only variables that reach the browser are the NEXT_PUBLIC_* ones, and
 * those are read directly from `process.env` at build time in the components
 * that need them (Next.js inlines them).
 */

const serverSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (v) => v.startsWith("postgres://") || v.startsWith("postgresql://"),
      "DATABASE_URL must be a Postgres connection string",
    ),

  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Base URL the *browser* uses to fetch objects. */
  S3_PUBLIC_URL: z.string().min(1),

  AUTH_SECRET: z.string().min(1, "AUTH_SECRET is required"),
  AUTH_URL: z.string().url().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-5"),

  /**
   * Base URL of the Python ML service. Optional: without it, `classify()`
   * degrades immediately instead of spending 5s + a retry on every upload
   * waiting for a service that was never configured.
   */
  ML_SERVICE_URL: z.string().url().default("http://127.0.0.1:8000"),
  /** Per-request timeout for Node -> ML calls (Section 6: 5 seconds). */
  ML_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | undefined;

/**
 * Parse and memoise the server environment.
 *
 * @throws {z.ZodError} with a readable `issues` list on misconfiguration.
 */
export function env(): ServerEnv {
  if (cached) return cached;

  const parsed = serverSchema.safeParse({
    DATABASE_URL: process.env.DATABASE_URL,
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_REGION: process.env.S3_REGION,
    S3_BUCKET: process.env.S3_BUCKET,
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
    S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE,
    S3_PUBLIC_URL: process.env.S3_PUBLIC_URL,
    AUTH_SECRET: process.env.AUTH_SECRET,
    AUTH_URL: process.env.AUTH_URL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    ML_SERVICE_URL: process.env.ML_SERVICE_URL,
    ML_TIMEOUT_MS: process.env.ML_TIMEOUT_MS,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  });

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${detail}\n\n` +
        `Copy .env.example to .env and fill in the missing values.`,
    );
  }

  cached = parsed.data;
  return cached;
}

/** True when the Claude pipeline is configured; gates the "Generate draft" UI. */
export function isAiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
