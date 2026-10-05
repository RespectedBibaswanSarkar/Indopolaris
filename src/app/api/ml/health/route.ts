import { NextResponse } from "next/server";

import { mlHealth } from "@/lib/ml";

/**
 * `GET /api/ml/health` — Section 9.
 *
 * Proxies the Python service's `/health` so the browser and the admin dashboard
 * never talk to port 8000 directly. That matters beyond convenience: the ML
 * service is an internal hop on the Docker network, and exposing it to the
 * browser would hand out an unauthenticated endpoint that runs inference.
 *
 * Returns 200 when the ML service is reachable and healthy, 503 when it is not,
 * so this route can be scraped by an external monitor with a single rule.
 *
 * Deliberately unauthenticated for the same reason `GET /api/health` is: an
 * operator checking whether the pipeline is up should not have to log in. It
 * exposes service status and the model version — no archive content.
 */
export async function GET() {
  const startedAt = performance.now();
  const health = await mlHealth();

  // A reachable-but-degraded service is still a working endpoint; the
  // distinction matters because "degraded" means the classifier artifact is
  // missing and uploads will save with tagging pending.
  const healthy = health.reachable && health.modelLoaded === true;

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      service: "indopolaris-ml",
      reachable: health.reachable,
      modelLoaded: health.modelLoaded ?? false,
      modelVersion: health.modelVersion ?? null,
      detail: health.detail,
      latencyMs: Math.round(performance.now() - startedAt),
      checks: health.checks ?? {},
    },
    { status: healthy ? 200 : 503 },
  );
}
