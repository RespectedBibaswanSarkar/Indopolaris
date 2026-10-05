import { NextResponse } from "next/server";
import { z } from "zod";

import { classify } from "@/lib/ml";

/**
 * `POST /api/classify` — browser → ML service, with optional persistence.
 *
 * Two modes:
 *  - `persist: false` (default): a probe. The ML service is called without a
 *    `sourceId`, so no `ClassificationLog` row is written. Used by the lab.
 *  - `persist: true`: requires `sourceType` + `sourceId`. The row is written
 *    with a `sourceId`, so the Python service records the inference. Used by
 *    the studio upload flow.
 *
 * The response is flattened rather than nested under `result` so the lab does
 * not have to unwrap the discriminated outcome — but the failure mode is still
 * explicit: a 503 body carries `error.code` and the page shows it, rather than
 * rendering an empty confidence list that reads as "no tags predicted".
 */
const BODY = z.object({
  text: z.string().min(1, "text is required").max(5000, "text is limited to 5000 characters"),
  sourceType: z.enum(["Report", "Dataset", "Publication"]).default("Report"),
  sourceId: z.string().min(1).optional(),
  persist: z.boolean().default(false),
});

export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_INPUT", message: "Body is not valid JSON" } },
      { status: 400 },
    );
  }

  const parsed = BODY.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_INPUT",
          message: parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; "),
        },
      },
      { status: 400 },
    );
  }

  const { text, sourceType, sourceId, persist } = parsed.data;

  // Persistence is only meaningful with a real row to attach the log to.
  // Refuse rather than silently downgrade, so the caller cannot believe it
  // recorded something it did not.
  if (persist && !sourceId) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_INPUT",
          message: "persist=true requires a sourceId to attach the ClassificationLog row to",
        },
      },
      { status: 400 },
    );
  }

  const outcome = await classify({
    text,
    sourceType,
    sourceId: persist ? sourceId : undefined,
  });

  if (!outcome.ok) {
    // 503 for a missing model (retry later), 502 for an upstream problem. The
    // distinction matters: one is a deploy-state issue, the other a fault.
    const status = outcome.unavailable === "model_not_loaded" ? 503 : 502;
    return NextResponse.json(
      {
        error: {
          code: outcome.unavailable.toUpperCase(),
          message: outcome.detail,
        },
        latencyMs: Math.round(outcome.latencyMs),
        attempts: outcome.attempts,
      },
      { status },
    );
  }

  return NextResponse.json({
    predictedTags: outcome.result.predictedTags,
    confidenceScores: outcome.result.confidenceScores,
    modelVersion: outcome.result.modelVersion,
    latencyMs: Math.round(outcome.latencyMs),
    attempts: outcome.attempts,
    logged: Boolean(persist && sourceId),
  });
}
