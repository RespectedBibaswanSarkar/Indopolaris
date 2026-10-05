"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge, buttonClass } from "@/components/ui";

export type ReviewDraft = {
  id: string;
  status: string;
  draftText: string;
  draftCaption: string;
  targetChannel: string;
  sourceType: string;
  createdAt: string;
  reviewedByName: string | null;
  sourceTitle: string | null;
};

const STATUS_TONE: Record<string, "amber" | "good" | "bad" | "neutral" | "ice"> = {
  pending_review: "amber",
  approved: "ice",
  rejected: "bad",
  published: "good",
};

/**
 * Review queue.
 *
 * The human-in-the-loop gate as a working list. Each row is a real
 * `OutreachDraft`; approving or rejecting writes through the API, which
 * re-checks the role on the server and refuses any status other than
 * `pending_review`.
 */
export function ReviewQueue({ drafts, canReview }: { drafts: ReviewDraft[]; canReview: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, decision: "approved" | "rejected") {
    setBusy(`${id}:${decision}`);
    setError(null);
    try {
      const response = await fetch(`/api/drafts/${id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? `Failed (${response.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach the app.");
    } finally {
      setBusy(null);
    }
  }

  if (drafts.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line bg-surface/40 p-10 text-center">
        <p className="font-display text-lg font-semibold">Queue is empty</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">
          Submit something in the{" "}
          <a href="/studio" className="text-ice underline">
            studio
          </a>{" "}
          to generate a draft for review.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error ? (
        <div className="rounded-xl border border-bad/50 bg-bad/10 p-3 text-sm text-bad">
          {error}
        </div>
      ) : null}

      {!canReview ? (
        <p className="rounded-xl border border-amber/40 bg-amber/10 p-3 text-sm">
          Reviewing requires the <strong>editor</strong> role. Sign in as an editor
          to act on these — the buttons below will return <code>403</code> otherwise.
        </p>
      ) : null}

      <ul className="space-y-4">
        {drafts.map((draft) => (
          <li key={draft.id} className="rounded-xl border border-line bg-surface p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={STATUS_TONE[draft.status] ?? "neutral"}>{draft.status}</Badge>
                  <Badge>{draft.sourceType}</Badge>
                  <span className="text-xs text-muted">
                    target: {draft.targetChannel}
                  </span>
                </div>
                <p className="mt-2 font-display font-semibold">{draft.draftCaption}</p>
                {draft.sourceTitle ? (
                  <p className="text-xs text-muted">source: {draft.sourceTitle}</p>
                ) : null}
              </div>
              <div className="text-right text-xs text-muted">
                <p>{new Date(draft.createdAt).toISOString().slice(0, 16).replace("T", " ")}</p>
                {draft.reviewedByName ? (
                  <p className="text-ice">reviewed by {draft.reviewedByName}</p>
                ) : null}
              </div>
            </div>

            <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-surface-2 p-3 text-xs leading-relaxed text-ink/90">
              {draft.draftText}
            </pre>

            {draft.status === "pending_review" ? (
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => decide(draft.id, "approved")}
                  disabled={busy !== null}
                  className={buttonClass("good")}
                >
                  {busy === `${draft.id}:approved` ? "Approving…" : "Approve"}
                </button>
                <button
                  type="button"
                  onClick={() => decide(draft.id, "rejected")}
                  disabled={busy !== null}
                  className={buttonClass("danger")}
                >
                  {busy === `${draft.id}:rejected` ? "Rejecting…" : "Reject"}
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
