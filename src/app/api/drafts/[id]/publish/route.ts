import { NextResponse } from "next/server";
import { z } from "zod";

import { recommendArm } from "@/lib/ml";
import { ForbiddenError, requireUser } from "@/lib/session";

/**
 * `POST /api/drafts/[id]/publish` — human approval plus bandit arm choice.
 *
 * Section 5.3 / the `outreach_draft_published_requires_review` CHECK mean
 * nothing reaches `published` without a named reviewer, so this route records
 * `reviewedById` in the same update that sets `status = 'published'`. There is
 * no code path that publishes anonymously — that is enforced by the database,
 * and re-asserted here so the reviewer is whoever actually signed in.
 *
 * `channel` and `timeSlot` default to the bandit's recommendation. An operator
 * may override both (an Instagram partner asked for a specific evening).
 *
 * Two things this route deliberately does *not* claim:
 *  - It does not store the time slot. `OutreachDraft` has no `timeSlot` column,
 *    so the slot is returned for the caller's own bookkeeping and the response
 *    sets `timeSlotPersisted: false`. Adding the column means a migration.
 *  - It does not itself constitute the review. A draft must already be
 *    `approved`; this route only records *which* editor pressed publish.
 */
const BODY = z.object({
  channel: z.enum(["website", "twitter", "instagram"]).optional(),
  timeSlot: z.enum(["morning", "afternoon", "evening"]).optional(),
  /** Set when the human overrode the suggestion, so the arm is excluded next time. */
  overrodeSuggestion: z.boolean().default(false),
});

const CHANNELS = ["website", "twitter", "instagram"] as const;
const SLOTS = ["morning", "afternoon", "evening"] as const;

type Channel = (typeof CHANNELS)[number];
type Slot = (typeof SLOTS)[number];

function toChannel(value: string): Channel | undefined {
  return CHANNELS.find((c) => c === value);
}

function toSlot(value: string): Slot | undefined {
  return SLOTS.find((s) => s === value);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const user = await requireUser("editor").catch((error: unknown) => {
    if (error instanceof ForbiddenError) return null;
    throw error;
  });
  if (!user) {
    return NextResponse.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "Publishing requires the editor role or above",
        },
      },
      { status: 403 },
    );
  }

  let raw: unknown = {};
  try {
    raw = await request.json();
  } catch {
    // An empty body is valid: it means "accept the band's recommendation".
    raw = {};
  }

  const parsed = BODY.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_INPUT",
          message: parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; "),
        },
      },
      { status: 400 },
    );
  }

  const { prisma } = await import("@/lib/db");
  const draft = await prisma.outreachDraft.findUnique({
    where: { id },
    select: { id: true, status: true, targetChannel: true },
  });

  if (!draft) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "No such draft" } },
      { status: 404 },
    );
  }
  if (draft.status === "published") {
    return NextResponse.json(
      { error: { code: "INVALID_INPUT", message: "This draft is already published" } },
      { status: 409 },
    );
  }
  // The human-in-the-loop gate, enforced here rather than trusted to the UI.
  // The database CHECK only insists that *some* reviewer exists, so without this
  // a single authenticated editor could jump the queue and publish a draft that
  // nobody reviewed. `rejected` and `pending_review` both stop here.
  if (draft.status !== "approved") {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_INPUT",
          message:
            draft.status === "pending_review"
              ? "This draft has not been approved yet — approve it in the review queue first"
              : `A ${draft.status} draft cannot be published`,
        },
      },
      { status: 409 },
    );
  }

  // Ask the bandit unless the human already chose. A 503 here is not fatal:
  // publishing with a human's explicit choice must work even when the bandit
  // is down, so the fallback is the row's existing targetChannel.
  let recommendation = null;
  let channel: Channel | undefined = parsed.data.channel;
  let timeSlot: Slot | undefined = parsed.data.timeSlot;
  let banditUnavailable: string | null = null;

  if (!channel || !timeSlot) {
    const outcome = await recommendArm({ draftId: id });
    if (outcome.ok) {
      recommendation = {
        arm: outcome.result.arm,
        channel: outcome.result.channel,
        timeSlot: outcome.result.timeSlot,
        expectedReward: outcome.result.expectedReward,
        exploration: outcome.result.exploration,
        reason: outcome.result.reason,
        arms: outcome.result.arms,
      };
      // The OpenAPI types declare these as plain `string`, so narrow rather than
      // cast: an arm name the service invents outside the 9 valid pairs must fall
      // back to the row's channel, not be written into a Postgres enum column.
      channel ??= toChannel(outcome.result.channel);
      timeSlot ??= toSlot(outcome.result.timeSlot);
    } else {
      banditUnavailable = outcome.detail;
    }
  }

  const finalChannel = channel ?? draft.targetChannel;
  const finalSlot = timeSlot ?? "morning";
  const usedRecommendation = Boolean(recommendation) && !parsed.data.overrodeSuggestion;
  const arm = `${finalChannel}_${finalSlot}`;

  const updated = await prisma.outreachDraft.update({
    where: { id },
    data: {
      status: "published",
      reviewedById: user.id,
      publishedAt: new Date(),
      targetChannel: finalChannel,
    },
    select: {
      id: true,
      status: true,
      targetChannel: true,
      publishedAt: true,
      reviewedBy: { select: { name: true } },
    },
  });

  return NextResponse.json({
    draft: updated,
    arm,
    timeSlot: finalSlot,
    channel: finalChannel,
    recommendation,
    usedRecommendation,
    overrode: parsed.data.overrodeSuggestion,
    banditUnavailable,
    /** Honest about the schema gap: the chosen time slot is returned, not stored. */
    timeSlotPersisted: false,
  });
}
