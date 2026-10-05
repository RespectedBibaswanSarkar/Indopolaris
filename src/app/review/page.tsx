import { connection } from "next/server";

import { ReviewQueue } from "@/components/review-queue";
import { SectionHeading } from "@/components/ui";
import { currentUser, hasRole } from "@/lib/session";

export const metadata = { title: "Review queue" };

/**
 * `/review` — the outreach draft queue.
 *
 * Section 5.3's human-in-the-loop requirement, made operable. Only
 * `pending_review` and `approved` drafts are listed: `published` and `rejected`
 * are terminal and belong on the expedition pages, not in a work queue.
 */
export default async function ReviewPage() {
  await connection();

  const { prisma } = await import("@/lib/db");

  const user = await currentUser().catch(() => null);
  const canReview = Boolean(user && hasRole(user.role, "editor"));

  const drafts = await prisma.outreachDraft
    .findMany({
      where: { status: { in: ["pending_review", "approved"] } },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        status: true,
        draftText: true,
        draftCaption: true,
        targetChannel: true,
        sourceType: true,
        createdAt: true,
        reviewedBy: { select: { name: true } },
        report: { select: { title: true } },
        dataset: { select: { title: true } },
        publication: { select: { title: true } },
      },
    })
    .catch(() => []);

  return (
    <div className="space-y-6">
      <SectionHeading
        eyebrow="Section 5.3"
        title="Outreach review queue"
        description="Nothing reaches the public without a named editor. Approving moves a draft on to publication; publishing then asks the bandit where and when to post it."
      />
      <ReviewQueue
        canReview={canReview}
        drafts={drafts.map((draft) => ({
          id: draft.id,
          status: draft.status,
          draftText: draft.draftText,
          draftCaption: draft.draftCaption,
          targetChannel: draft.targetChannel,
          sourceType: draft.sourceType,
          createdAt: draft.createdAt.toISOString(),
          reviewedByName: draft.reviewedBy?.name ?? null,
          sourceTitle:
            draft.report?.title ?? draft.dataset?.title ?? draft.publication?.title ?? null,
        }))}
      />
    </div>
  );
}
