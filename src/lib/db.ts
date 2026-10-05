import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/lib/env";

/**
 * Prisma client singleton.
 *
 * Two things this has to get right:
 *
 *  1. Prisma 7 requires an explicit driver adapter — there is no bundled
 *     engine any more. `PrismaPg` wraps `pg` and speaks the Postgres wire
 *     protocol, which is what lets the identical code run against the
 *     docker-compose `db` service and the PGlite dev fallback.
 *  2. Next.js dev-mode hot reload re-evaluates modules on every change. Without
 *     caching on `globalThis`, each reload opens a fresh connection pool and
 *     Postgres eventually refuses new connections ("too many clients"). The
 *     `globalThis` cache is the standard remedy.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: env().DATABASE_URL,
  });

  return new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * Run independent reads one after another instead of in a `Promise.all`.
 *
 * This exists because of PGlite, not because `Promise.all` is wrong. PGlite is a
 * single WASM instance behind one socket connection, and two overlapping extended
 * protocol messages on it desynchronise — the symptom is
 * `08P01 bind message supplies 1 parameters, but prepared statement "" requires 2`
 * on a query that contains no parameters at all. Against the docker-compose
 * `db` (real Postgres, a pool) the concurrency is harmless.
 *
 * So pages that read several tables use this instead of `Promise.all`. It is
 * marginally slower on a pool and the difference is invisible at this scale; the
 * alternative is a dashboard that silently shows prior values because one query
 * of five was dropped.
 */
export async function reads<T extends readonly unknown[]>(
  ...steps: { [K in keyof T]: () => Promise<T[K]> }
): Promise<{ -readonly [K in keyof T]: T[K] }> {
  const out: unknown[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    out.push(await steps[i]());
  }
  return out as { -readonly [K in keyof T]: T[K] };
}
