import { NextResponse } from "next/server";

import { z } from "zod";

import { recordEngagement } from "@/lib/ml";

/**
 * `POST /api/ml/feedback` — Section 6.
 *
 * Records impressions/clicks for a published draft and folds the reward into the
 * arm's Beta posterior.
 *
 * Validation happens here, at the edge, before the request reaches Postgres.
 * Two reasons beyond catching typos:
 *
 *  - `clicks > impressions` is a 1.1 reward and permanently inflates an arm's
 *    `alpha`. The service clamps as defence in depth, but a clamped row is
 *    indistinguishable from a real one later, so it is better rejected loudly.
 *  - `isSimulated` defaults to `false` and is never inferred. Section 6 requires
 *    synthetic feedback to stay permanently separable from real analytics; a
 *    missing flag must mean "real", never "guess".
 *
 * `recordEngagement` deliberately does not retry: a retried POST writes a second
 * EngagementEvent and double-counts a pull. So this route also never retries, and
 * the client is expected to re-submit only on a definite failure it observed.
 */
const FEEDBACK_BODY = z
  .object({
    draftId: z.string().min(1),
    channel: z.enum(["website", "twitter", "instagram"]),
    timeSlot: z.enum(["morning", "afternoon", "evening"]),
    impressions: z.number().int().min(1),
    clicks: z.number().int().min(0),
    isSimulated: z.boolean().optional(),
  })
  .refine((body) => body.clicks <= body.impressions, {
    message: "clicks cannot exceed impressions",
    path: ["clicks"],
  });

export async function POST(request: Request) {
  const startedAt = performance.now();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_INPUT", message: "Request body is not valid JSON" } },
      { status: 400 },
    );
  }

  const parsed = FEEDBACK_BODY.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_INPUT",
          message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
        },
      },
      { status: 400 },
    );
  }

  const outcome = await recordEngagement(parsed.data);
  if (!outcome.ok) {
    // 502: the request was well-formed and the caller should retry it, but we
    // cannot promise it was not already written. The service writes the
    // EngagementEvent and the posterior in one transaction, so a transport
    // failure after the commit lands is the only ambiguous case.
    return NextResponse.json(
      { error: { code: "FEEDBACK_NOT_RECORDED", message: outcome.detail } },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ...outcome.result,
    latencyMs: Math.round(performance.now() - startedAt),
  });
}