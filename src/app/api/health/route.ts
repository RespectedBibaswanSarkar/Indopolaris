import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { env, isAiConfigured } from "@/lib/env";

/**
 * Liveness + dependency check.
 *
 * Deliberately does not touch MinIO: a cold `bucketExists()` on every probe
 * would make this endpoint a network-latency benchmark, and a health check that
 * fails because object storage is briefly slow is worse than no health check.
 * Storage is exercised on first upload instead.
 *
 * Returns 200 when the app can serve traffic and the database is reachable,
 * 503 when the database is not, so an orchestrator can act on it.
 */
export async function GET() {
  const startedAt = performance.now();
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  // 1. Database — the only hard dependency for a read-only page render.
  try {
    const [row] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      "SELECT count(*)::bigint AS n FROM \"Expedition\"",
    );
    checks.database = { ok: true, detail: `${row?.n ?? 0} expeditions` };
  } catch (e) {
    checks.database = { ok: false, detail: e instanceof Error ? e.message : "unknown" };
  }

  // 2. Full-text search — present since migration 1_search, but a missing
  //    function means search 500s for users while everything else looks fine.
  try {
    await prisma.$queryRawUnsafe("SELECT count(*) FROM indopolaris_search(NULL)");
    checks.search = { ok: true };
  } catch (e) {
    checks.search = {
      ok: false,
      detail: e instanceof Error ? e.message : "unknown",
    };
  }

  // 3. Config presence. An absent ANTHROPIC_API_KEY is a degraded state, not a
  //    failure — the AI draft button is hidden and the rest of the CMS works.
  const aiConfigured = isAiConfigured();
  checks.aiPipeline = {
    ok: true,
    detail: aiConfigured ? "configured" : "ANTHROPIC_API_KEY unset — drafts disabled",
  };

  const healthy = checks.database?.ok === true;

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      service: "indopolaris",
      version: process.env.npm_package_version ?? "0.1.0",
      latencyMs: Math.round(performance.now() - startedAt),
      aiConfigured,
      storage: { endpoint: env().S3_ENDPOINT, bucket: env().S3_BUCKET },
      checks,
    },
    { status: healthy ? 200 : 503 },
  );
}
