import { NextResponse } from "next/server";

import { recommendArm } from "@/lib/ml";

/**
 * `GET /api/ml/recommend` — Section 6.
 *
 * Proxies the Python service's `/recommend`, the Thompson-sampled
 * (channel, time-slot) pick for the next outreach post. The browser must not call
 * port 8000 directly, for the same reason as `/api/ml/health`: it is an internal
 * hop and exposes an unauthenticated endpoint that mutates nothing but should
 * not be publicly reachable.
 *
 * `draftId` and `exclude` are forwarded so the review screen can ask "what do
 * you recommend for *this* draft" and can suppress arms a human already
 * rejected in this session.
 *
 * Returns 503 (not 200 with a null arm) when the service is unreachable. The
 * caller must decide what to do; silently substituting a "default" arm here
 * would hide a broken posterior from the operator, and `expectedReward: 0.5` from
 * a uniform prior looks exactly like a real, confident recommendation.
 */
export async function GET(request: Request) {
  const startedAt = performance.now();
  const url = new URL(request.url);

  const draftId = url.searchParams.get("draftId") ?? undefined;
  const exclude = url.searchParams
    .get("exclude")
    ?.split(",")
    .map((arm) => arm.trim())
    .filter(Boolean);

  const outcome = await recommendArm({ draftId, exclude });

  if (!outcome.ok) {
    return NextResponse.json(
      {
        error: {
          code: "RECOMMENDATION_UNAVAILABLE",
          message: outcome.detail,
        },
        latencyMs: Math.round(performance.now() - startedAt),
      },
      // 503 keeps the browser's `fetch` rejection path identical to the health
      // proxy's, so one client-side handler covers both.
      { status: 503 },
    );
  }

  return NextResponse.json({
    ...outcome.result,
    latencyMs: Math.round(performance.now() - startedAt),
  });
}