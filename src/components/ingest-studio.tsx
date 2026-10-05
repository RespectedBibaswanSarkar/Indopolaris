"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge, Meter, Mono, buttonClass, cx } from "@/components/ui";

type Expedition = { slug: string; title: string };

type Prediction = {
  predictedTags: string[];
  confidenceScores: Record<string, number>;
  modelVersion: string;
  latencyMs: number;
};

type IngestResult = {
  report: { id: string; title: string; createdAt: string; fileUrl?: string; fileType?: string };
  draftId: string | null;
  prediction: Prediction | null;
  taggingPending: boolean;
  expedition: { title: string; slug: string };
};

/** `POST /api/studio/upload` response. */
type Uploaded = {
  fileUrl: string;
  storageKey: string;
  fileType: string;
  sizeBytes: number;
  driver: "s3" | "local";
};

type PublishResult = {
  draft: {
    id: string;
    status: string;
    targetChannel: string;
    publishedAt: string | null;
    reviewedBy: { name: string } | null;
  };
  arm: string;
  timeSlot: string;
  channel: string;
  recommendation: {
    arm: string;
    channel: string;
    timeSlot: string;
    expectedReward: number;
    exploration: number;
    reason: string;
    arms: {
      arm: string;
      channel: string;
      timeSlot: string;
      alpha: number;
      beta: number;
      mean: number;
      observedMean: number;
      totalPulls: number;
      totalReward: number;
    }[];
  } | null;
  usedRecommendation: boolean;
  overrode: boolean;
  banditUnavailable: string | null;
};

const CHANNELS = ["website", "twitter", "instagram"] as const;
const SLOTS = ["morning", "afternoon", "evening"] as const;

/**
 * Ingest studio.
 *
 * Walks the pipeline in the order a real upload takes it and shows each stage's
 * output, so the ML and RL steps are observable rather than implied:
 *
 *   1. submit  → Report row + ClassificationLog (written by the ML service)
 *   2. inspect → every label with its confidence, and whether a tag was applied
 *   3. review  → the pending draft a human must approve
 *   4. publish → the bandit's (channel, slot) pick and all 9 posteriors
 *   5. feedback→ fold impressions/clicks back into the chosen arm
 *
 * Stage 4 is where the human-in-the-loop rule is visible: publishing records
 * the signed-in editor by name, and there is no way to publish without them.
 */
export function IngestStudio({ expeditions, canUpload }: { expeditions: Expedition[]; canUpload: boolean }) {
  const router = useRouter();

  const [expeditionSlug, setExpeditionSlug] = useState(expeditions[0]?.slug ?? "");
  const [title, setTitle] = useState("");
  const [abstract, setAbstract] = useState("");
  const [autoTag, setAutoTag] = useState(true);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [ingest, setIngest] = useState<IngestResult | null>(null);
  const [publish, setPublish] = useState<PublishResult | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [uploaded, setUploaded] = useState<Uploaded | null>(null);

  const [override, setOverride] = useState(false);
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]>("website");
  const [slot, setSlot] = useState<(typeof SLOTS)[number]>("morning");

  const [impressions, setImpressions] = useState(1000);
  const [clicks, setClicks] = useState(140);
  const [feedback, setFeedback] = useState<{ arm: string; reward: number; totalPulls: number } | null>(null);

  async function postJson(url: string, body: unknown) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      const message =
        (data?.error as { message?: string } | undefined)?.message ??
        `Request failed (${response.status})`;
      throw new Error(message);
    }
    return data;
  }

  async function submit() {
    setError(null);
    setPublish(null);
    setFeedback(null);

    // 1. Attachment first. Kept out of the ingest call so that a 503 from object
    //    storage retries here instead of creating a Report with no file.
    let attachment: Uploaded | null = uploaded;
    if (file && !attachment) {
      setBusy("upload");
      try {
        const form = new FormData();
        form.append("file", file);
        const response = await fetch("/api/studio/upload", {
          method: "POST",
          body: form,
        });
        const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (!response.ok) {
          throw new Error(
            (data?.error as { message?: string } | undefined)?.message ??
              `Upload failed (${response.status})`,
          );
        }
        attachment = data as unknown as Uploaded;
        setUploaded(attachment);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(null);
        return;
      }
    }

    // 2. Metadata + classification + draft.
    setBusy("ingest");
    try {
      const data = (await postJson("/api/studio/ingest", {
        title,
        abstract,
        expeditionSlug,
        autoTag,
        generateDraft: true,
        ...(attachment
          ? { storageKey: attachment.storageKey, fileType: attachment.fileType }
          : {}),
      })) as unknown as IngestResult;
      setIngest(data);
      setFile(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    if (!ingest?.draftId) return;
    setBusy("review");
    setError(null);
    try {
      await postJson(`/api/drafts/${ingest.draftId}/review`, { decision: "approved" });
      router.refresh();
      // Publishing needs an approved draft, so chain straight through with the
      // bandit's suggestion.
      await doPublish(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function doPublish(didOverride: boolean) {
    if (!ingest?.draftId) return;
    setBusy("publish");
    try {
      const data = (await postJson(`/api/drafts/${ingest.draftId}/publish`, {
        ...(didOverride ? { channel, timeSlot: slot } : {}),
        overrodeSuggestion: didOverride,
      })) as unknown as PublishResult;
      setPublish(data);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function submitFeedback() {
    if (!publish) return;
    setBusy("feedback");
    setError(null);
    try {
      const data = (await postJson("/api/ml/feedback", {
        draftId: ingest?.draftId,
        channel: publish.channel,
        timeSlot: publish.timeSlot,
        impressions,
        clicks,
        isSimulated: true,
      })) as { arm?: string; reward?: number; totalPulls?: number; error?: { message: string } };

      if (data.error) throw new Error(data.error.message);
      setFeedback({
        arm: data.arm ?? publish.arm,
        reward: data.reward ?? 0,
        totalPulls: data.totalPulls ?? 0,
      });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const stage = ingest ? (publish ? 5 : 4) : 1;

  return (
    <div className="space-y-6">
      <ol className="flex flex-wrap gap-2 text-xs" aria-label="Pipeline stages">
        {[
          "1 · Submit",
          "2 · Classification",
          "3 · Draft queued",
          "4 · Bandit pick",
          "5 · Feedback",
        ].map((label, index) => {
          const current = index + 1;
          const done = current < stage;
          const active = current === stage;
          return (
            <li
              key={label}
              className={cx(
                "rounded-full border px-3 py-1",
                active
                  ? "border-ice/60 bg-ice/10 text-ice"
                  : done
                    ? "border-good/40 bg-good/10 text-good"
                    : "border-line bg-surface-2 text-muted",
              )}
            >
              {label}
            </li>
          );
        })}
      </ol>

      {error ? (
        <div className="rounded-xl border border-bad/50 bg-bad/10 p-4 text-sm text-bad">
          {error}
        </div>
      ) : null}

      {!canUpload ? (
        <div className="rounded-xl border border-amber/40 bg-amber/10 p-4 text-sm">
          Sign in as a contributor or above to run the ingest pipeline.{" "}
          <a href="/signin" className="font-semibold text-ice underline">
            Choose an account
          </a>
        </div>
      ) : null}

      {/* Stage 1 ---------------------------------------------------------- */}
      <section className="rounded-xl border border-line bg-surface p-5">
        <h3 className="font-display text-lg font-semibold">1 · Submit a report</h3>
        <p className="mt-1 text-sm text-muted">
          Creates a draft <code>Report</code>, classifies it, and queues an outreach
          draft for review. The report row is written <em>before</em> the classifier
          is called, so a broken ML service cannot lose the submission.
        </p>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="block text-sm">
            Expedition
            <select
              value={expeditionSlug}
              onChange={(e) => setExpeditionSlug(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-surface-2 px-3 py-2"
            >
              {expeditions.map((e) => (
                <option key={e.slug} value={e.slug}>
                  {e.title}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm">
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. First direct measurements of sea-ice thickness"
              className="mt-1 w-full rounded-lg border border-line bg-surface-2 px-3 py-2"
            />
          </label>
        </div>

        <label className="mt-4 block text-sm">
          Abstract
          <textarea
            value={abstract}
            onChange={(e) => setAbstract(e.target.value)}
            rows={4}
            placeholder="Paste the report abstract…"
            className="mt-1 w-full rounded-lg border border-line bg-surface-2 px-3 py-2"
          />
        </label>

        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={autoTag}
            onChange={(e) => setAutoTag(e.target.checked)}
          />
          Run the classifier
        </label>

        {/* Attachment. Uploaded first, on its own route, so a storage failure
            retries without creating a second Report row. */}
        <div className="mt-4">
          <label className="block text-sm">
            Attachment <span className="text-muted">(optional, 25 MB max)</span>
            <input
              type="file"
              onChange={(e) => {
                const picked = e.target.files?.[0] ?? null;
                setFile(picked);
                setUploaded(null);
                setError(null);
              }}
              accept=".pdf,.csv,.txt,.json,.nc,.nc4,.png,.jpg,.jpeg,.webp"
              className="mt-1 w-full text-sm text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-ice/15 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-ice"
            />
          </label>

          {file ? (
            <p className="mt-2 text-xs text-muted">
              {file.name} · {(file.size / 1024).toFixed(1)} KB
              {uploaded ? (
                <>
                  {" "}
                  · stored as <Mono>{uploaded.storageKey}</Mono> via{" "}
                  {uploaded.driver} driver
                </>
              ) : (
                " · will upload on submit"
              )}
            </p>
          ) : null}
        </div>

        <button
          type="button"
          onClick={submit}
          disabled={
            !canUpload ||
            busy !== null ||
            title.length < 3 ||
            abstract.length < 10
          }
          className={buttonClass("primary", "mt-4")}
        >
          {busy === "upload"
            ? "Uploading…"
            : busy === "ingest"
              ? "Ingesting…"
              : "Submit and classify"}
        </button>
      </section>

      {/* Stage 2 ---------------------------------------------------------- */}
      {ingest ? (
        <section className="rounded-xl border border-line bg-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display text-lg font-semibold">2 · Classification</h3>
            <div className="flex items-center gap-2">
              {ingest.prediction ? (
                <Badge tone="ice">v{ingest.prediction.modelVersion}</Badge>
              ) : null}
              {ingest.taggingPending ? (
                <Badge tone="amber" title="No label cleared the threshold, or the ML service was unavailable">
                  tagging pending
                </Badge>
              ) : (
                <Badge tone="good">tagged</Badge>
              )}
            </div>
          </div>

          <p className="mt-2 text-sm text-muted">
            <Mono>{ingest.report.id}</Mono> · added to{" "}
            {ingest.expedition.title}
            {ingest.prediction ? ` · ${ingest.prediction.latencyMs}ms` : ""}
          </p>

          {ingest.report.fileUrl ? (
            <p className="mt-1 text-xs text-muted">
              file{" "}
              <a href={ingest.report.fileUrl} className="text-ice underline">
                {ingest.report.fileType}
              </a>
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted">
              filed from metadata only — no attachment
            </p>
          )}

          {ingest.prediction ? (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {Object.entries(ingest.prediction.confidenceScores)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([label, score]) => (
                  <div key={label}>
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="truncate">{label}</span>
                      <span className="font-mono text-ice">{score.toFixed(4)}</span>
                    </div>
                    <div className="mt-1">
                      <Meter value={score} tone={score >= 0.25 ? "good" : "neutral"} />
                    </div>
                  </div>
                ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-amber">
              No prediction was returned. The report was still saved and the draft
              still queued — this is the degradation path working as designed.
            </p>
          )}
        </section>
      ) : null}

      {/* Stage 3 ---------------------------------------------------------- */}
      {ingest?.draftId ? (
        <section className="rounded-xl border border-line bg-surface p-5">
          <h3 className="font-display text-lg font-semibold">3 · Human review</h3>
          <p className="mt-1 text-sm text-muted">
            An editor must approve this draft before it can be published, and the
            reviewer is recorded against it. There is no code path that publishes
            anonymously.
          </p>
          <button
            type="button"
            onClick={approve}
            disabled={busy === "review" || Boolean(publish)}
            className={buttonClass("good", "mt-4")}
          >
            {busy === "review" ? "Approving…" : publish ? "Approved" : "Approve draft"}
          </button>
        </section>
      ) : null}

      {/* Stage 4 ---------------------------------------------------------- */}
      {ingest?.draftId && !publish ? (
        <section className="rounded-xl border border-line bg-surface p-5">
          <h3 className="font-display text-lg font-semibold">4 · Bandit pick</h3>
          <p className="mt-1 text-sm text-muted">
            Approving above publishes with the bandit&apos;s suggestion. Or override
            it here and publish directly — the override is recorded, and the arm
            actually used is the one attributed.
          </p>

          <div className="mt-4 flex flex-wrap items-end gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={override}
                onChange={(e) => setOverride(e.target.checked)}
              />
              Override the suggestion
            </label>

            {override ? (
              <>
                <label className="text-sm">
                  Channel
                  <select
                    value={channel}
                    onChange={(e) => setChannel(e.target.value as typeof channel)}
                    className="mt-1 block rounded-lg border border-line bg-surface-2 px-3 py-2"
                  >
                    {CHANNELS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  Time slot
                  <select
                    value={slot}
                    onChange={(e) => setSlot(e.target.value as typeof slot)}
                    className="mt-1 block rounded-lg border border-line bg-surface-2 px-3 py-2"
                  >
                    {SLOTS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => doPublish(true)}
                  disabled={busy === "publish"}
                  className={buttonClass("ghost")}
                >
                  {busy === "publish" ? "Publishing…" : "Publish with override"}
                </button>
              </>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Stage 5 ---------------------------------------------------------- */}
      {publish ? (
        <section className="rounded-xl border border-line bg-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display text-lg font-semibold">5 · Feedback</h3>
            <Badge tone="good">published</Badge>
          </div>

          <p className="mt-2 text-sm text-muted">
            Chosen arm <span className="font-mono text-ice">{publish.arm}</span>
            {publish.recommendation ? (
              publish.overrode ? (
                <> · operator overrode the suggestion ({publish.recommendation.arm})</>
              ) : (
                <> · suggested by the bandit ({publish.recommendation.reason})</>
              )
            ) : (
              " · bandit's suggestion unavailable"
            )}
            {publish.draft.reviewedBy ? <> · reviewed by {publish.draft.reviewedBy.name}</> : null}
          </p>

          {publish.banditUnavailable ? (
            <p className="mt-2 text-xs text-amber">
              Bandit unavailable ({publish.banditUnavailable}); published with the
              row&apos;s stored channel. Publication does not depend on the bandit.
            </p>
          ) : null}

          {publish.recommendation ? (
            <div className="mt-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                All 9 arm posteriors at decision time
              </p>
              <ul className="mt-2 space-y-1.5">
                {publish.recommendation.arms
                  .slice()
                  .sort((a, b) => b.mean - a.mean)
                  .map((arm) => {
                    const isChosen = arm.arm === publish.arm;
                    return (
                      <li key={arm.arm} className="text-xs">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className={cx("font-mono", isChosen ? "text-ice" : "text-muted")}>
                            {arm.arm}
                            {isChosen ? " ← published" : ""}
                          </span>
                          <span className="font-mono text-muted">
                            α{arm.alpha.toFixed(2)} β{arm.beta.toFixed(2)} ·{" "}
                            {arm.mean.toFixed(4)} · {arm.totalPulls} pulls
                          </span>
                        </div>
                        <div className="mt-1">
                          <Meter value={arm.mean} tone={isChosen ? "good" : "neutral"} />
                        </div>
                      </li>
                    );
                  })}
              </ul>
            </div>
          ) : null}

          <div className="mt-5 border-t border-line pt-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted">
              Record engagement for this post
            </p>
            <p className="mt-1 text-xs text-muted">
              Marks <code>isSimulated = true</code> so synthetic feedback stays
              permanently separable from real analytics. One Bernoulli conjugate
              step: reward = clicks / impressions, α += reward, β += 1 − reward.
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="text-sm">
                Impressions
                <input
                  type="number"
                  min={1}
                  value={impressions}
                  onChange={(e) => setImpressions(Number(e.target.value))}
                  className="mt-1 block w-28 rounded-lg border border-line bg-surface-2 px-3 py-2"
                />
              </label>
              <label className="text-sm">
                Clicks
                <input
                  type="number"
                  min={0}
                  value={clicks}
                  onChange={(e) => setClicks(Number(e.target.value))}
                  className="mt-1 block w-28 rounded-lg border border-line bg-surface-2 px-3 py-2"
                />
              </label>
              <button
                type="button"
                onClick={submitFeedback}
                disabled={busy === "feedback" || clicks > impressions}
                className={buttonClass("primary")}
              >
                {busy === "feedback" ? "Recording…" : "Record feedback"}
              </button>
            </div>
            {clicks > impressions ? (
              <p className="mt-2 text-xs text-bad">
                Clicks cannot exceed impressions — that would be a &gt;100%
                click-through rate and would poison the arm it trains.
              </p>
            ) : null}
            {feedback ? (
              <p className="mt-3 text-sm text-good">
                Recorded: arm <span className="font-mono">{feedback.arm}</span>, reward{" "}
                {feedback.reward.toFixed(4)}, now {feedback.totalPulls} pulls.
              </p>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
