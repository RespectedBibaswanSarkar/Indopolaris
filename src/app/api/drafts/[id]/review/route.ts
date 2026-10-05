import { NextResponse } from "next/server";
import { z } from "zod";

import { ForbiddenError, requireUser } from "@/lib/session";

/**
 * `POST /api/drafts/[id]/review` — approve or reject a pending draft.
 *
 * The human-in-the-loop gate. `approved` moves the draft to `approved` (ready
 * to publish); `rejected` sends it back. Neither publishes — publishing is a
 * separate route that also consults the bandit, so the decision to publish and
 * the choice of when/where stay separable steps.
 */
const BODY = z.object({
  decision: z.enum(["approved", "rejected"]),
});

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
      { error: { code: "FORBIDDEN", message: "Reviewing requires the editor role" } },
      { status: 403 },
    );
  }

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
          message: parsed.error.issues.map((i) => i.message).join("; "),
        },
      },
      { status: 400 },
    );
  }

  const { prisma } = await import("@/lib/db");
  const draft = await prisma.outreachDraft.findUnique({
    where: { id },
    select: { id: true, status: true },
  });

  if (!draft) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "No such draft" } },
      { status: 404 },
    );
  }
  if (draft.status !== "pending_review") {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_INPUT",
          message: `Only pending_review drafts can be reviewed (this one is ${draft.status})`,
        },
      },
      { status: 409 },
    );
  }

  const updated = await prisma.outreachDraft.update({
    where: { id },
    data: {
      status: parsed.data.decision,
      reviewedById: user.id,
    },
    select: { id: true, status: true, reviewedBy: { select: { name: true } } },
  });

  return NextResponse.json({ draft: updated });
}
