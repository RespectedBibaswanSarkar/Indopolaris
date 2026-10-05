"use client";

import { useState } from "react";

import { Badge, Meter, Mono, buttonClass, cx } from "@/components/ui";

type Prediction = {
  predictedTags: string[];
  confidenceScores: Record<string, number>;
  modelVersion: string;
  latencyMs: number;
  attempts: number;
  logged: boolean;
};

type Failure = {
  reason: string;
  detail: string;
  latencyMs: number;
  attempts: number;
};

type Sample = { label: string; text: string };

/** Real abstracts from the seeded archive, so the lab demonstrates something. */
const SAMPLES: Sample[] = [
  {
    label: "Cryosphere / glacier mass balance",
    text: "We present three years of geodetic observations of glacier mass balance from the southern Patagonian ice field, derived from repeat satellite altimetry. Regional mass change shows a statistically significant acceleration of loss between 2019 and 2024, with the largest contributions arising from outlets terminating in fjords. We also report surface mass balance from stake networks and firn densification, and discuss the implications for sea-level contribution estimates.",
  },
  {
    label: "Oceanography / Southern Ocean",
    text: "CTD casts and ADCP measurements from the southern Indian Ocean reveal pronounced abyssal overturning variability during the austral winter. The observations show dense shelf water formation on the continental slope, with a bottom-water temperature increase of 0.12 degrees Celsius over the observational record, exceeding natural decadal variability. We propose that shelf freshening driven by Antarctic ice sheet discharge is the dominant control on regional overturning strength.",
  },
  {
    label: "Atmospheric science / aerosols",
    text: "Measurements of black carbon and mineral dust from an Arctic monitoring station show a pronounced seasonal cycle peaking in spring during snowmelt. Size-resolved chemical composition indicates that dust resuspension from exposed tundra accounts for a substantial fraction of the springtime aerosol optical depth, with implications for surface albedo reduction and regional radiative forcing.",
  },
  {
    label: "Outreach copy",
    text: "Cold, dark and remote: the Southern Ocean is one of the hardest places on Earth to study, yet it drives a large share of global climate change. This expedition brings Indian researchers together with international partners to measure the Southern Ocean from the sea ice edge to the abyssal plain.",
  },
  {
    label: "Too short to classify",
    text: "Krill are important.",
  },
];

/** Confidence below this is not attached to the record (Section 6). */
const THRESHOLD = 0.25;

function rank(scores: Record<string, number>): [string, number][] {
  return Object.entries(scores).sort((a, b) => b[1] - a[1]);
}

/**
 * Classifier lab.
 *
 * Calls `/api/classify`, which proxies the Python service. The point of this
 * page is to make the model's behaviour inspectable rather than a single tag
 * appearing out of nowhere: it shows every one of the 21 labels with its score,
 * marks where the acceptance threshold sits, explains that scores are
 * comparable but not calibrated probabilities, and surfaces the degradation
 * path when the service is down.
 */
export function ClassifierLab() {
  const [text, setText] = useState(SAMPLES[0].text);
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setFailure(null);
    setPrediction(null);
    try {
      const response = await fetch("/api/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          sourceType: "Report",
          persist: false,
        }),
      });

      const body = (await response.json().catch(() => null)) as
        | (Prediction & { error?: { code?: string; message?: string } })
        | null;

      if (!response.ok) {
        setFailure({
          reason: body?.error?.code ?? `HTTP ${response.status}`,
          detail:
            body?.error?.message ??
            "The ML service did not return a usable response.",
          latencyMs: 0,
          attempts: 1,
        });
        return;
      }

      setPrediction({
        predictedTags: body?.predictedTags ?? [],
        confidenceScores: body?.confidenceScores ?? {},
        modelVersion: body?.modelVersion ?? "unknown",
        latencyMs: body?.latencyMs ?? 0,
        attempts: body?.attempts ?? 1,
        logged: body?.logged ?? false,
      });
    } catch (error) {
      setFailure({
        reason: "network",
        detail: error instanceof Error ? error.message : String(error),
        latencyMs: 0,
        attempts: 1,
      });
    } finally {
      setBusy(false);
    }
  }

  const ranked = prediction ? rank(prediction.confidenceScores) : [];
  const top = ranked[0];

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <label htmlFor="lab-text" className="text-sm font-semibold">
            Abstract or description to classify
          </label>
          <p className="mt-1 text-xs text-muted">
            1–5000 characters. No <code>sourceId</code> is sent, so this probe
            does not write a <code>ClassificationLog</code> row — the studio
            upload path does.
          </p>
          <textarea
            id="lab-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={10}
            className="mt-3 w-full rounded-xl border border-line bg-surface p-3 font-mono text-xs leading-relaxed text-ink"
          />

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={run}
              disabled={busy || text.trim().length === 0}
              className={buttonClass("primary")}
            >
              {busy ? "Classifying…" : "Classify"}
            </button>
            <span className="text-xs text-muted">{text.trim().length} chars</span>
          </div>

          <div className="mt-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted">
              Samples
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {SAMPLES.map((sample) => (
                <button
                  key={sample.label}
                  type="button"
                  onClick={() => setText(sample.text)}
                  className="rounded-full border border-line bg-surface-2 px-3 py-1 text-xs hover:border-ice/60"
                >
                  {sample.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div>
          {failure ? (
            <div className="rounded-xl border border-bad/50 bg-bad/10 p-4">
              <div className="flex items-center justify-between">
                <h3 className="font-display font-semibold text-bad">
                  Classification unavailable
                </h3>
                <Badge tone="bad">{failure.reason}</Badge>
              </div>
              <p className="mt-2 text-sm text-ink/90">{failure.detail}</p>
              <p className="mt-3 text-xs text-muted">
                This is the documented degradation path: a failed ML call never
                fails the surrounding work. An upload would save with tagging
                pending and a human would tag it later.
              </p>
            </div>
          ) : null}

          {prediction ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-line bg-surface p-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-display font-semibold">Prediction</h3>
                  <div className="flex items-center gap-2">
                    <Badge tone="ice">v{prediction.modelVersion}</Badge>
                    <Mono>
                      {Math.round(prediction.latencyMs)}ms · {prediction.attempts} attempt
                      {prediction.attempts === 1 ? "" : "s"}
                    </Mono>
                  </div>
                </div>

                {prediction.predictedTags.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {prediction.predictedTags.map((tag) => (
                      <Badge key={tag} tone="good">
                        {tag} · {(prediction.confidenceScores[tag] ?? 0).toFixed(3)}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-amber">
                    No label reached the {THRESHOLD} threshold. That is a valid
                    answer, not a failure — a stub upload has nothing for a
                    bag-of-words model to work with.
                  </p>
                )}

                {top ? (
                  <p className="mt-3 text-xs text-muted">
                    Top label <span className="text-ink">{top[0]}</span> at{" "}
                    <span className="text-ice">{top[1].toFixed(4)}</span>
                    {ranked.length > 1 ? (
                      <>
                        , next {ranked[1][0]} at {ranked[1][1].toFixed(4)} (
                        {(top[1] - ranked[1][1]).toFixed(4)} margin)
                      </>
                    ) : null}
                    .
                  </p>
                ) : null}
              </div>

              <div className="rounded-xl border border-line bg-surface p-4">
                <h4 className="font-display font-semibold">
                  All {ranked.length} labels
                </h4>
                <p className="mt-1 text-xs text-muted">
                  These are the 21 NASA GES DISC research-area classes the model
                  was trained on — not NCPOR&apos;s 6 disciplines. Scores are
                  comparable between documents but are <em>not</em> calibrated
                  probabilities; do not read 0.62 as &quot;62% sure&quot;.
                </p>

                <ul className="mt-4 space-y-2">
                  {ranked.map(([label, score]) => {
                    const above = score >= THRESHOLD;
                    return (
                      <li key={label}>
                        <div className="flex items-baseline justify-between gap-3 text-xs">
                          <span
                            className={cx(
                              "truncate",
                              above ? "text-ink" : "text-muted",
                            )}
                          >
                            {label}
                            {!above ? (
                              <span className="ml-2 text-[10px] uppercase tracking-wide">
                                below threshold
                              </span>
                            ) : null}
                          </span>
                          <span
                            className={cx(
                              "shrink-0 font-mono",
                              above ? "text-ice" : "text-muted",
                            )}
                          >
                            {score.toFixed(4)}
                          </span>
                        </div>
                        <div className="mt-1">
                          <Meter
                            value={score}
                            tone={
                              above ? (label === top?.[0] ? "good" : "ice") : "neutral"
                            }
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          ) : null}

          {!prediction && !failure ? (
            <div className="rounded-xl border border-dashed border-line bg-surface/40 p-10 text-center">
              <p className="font-display text-lg font-semibold">No prediction yet</p>
              <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
                Pick a sample or paste an abstract, then press Classify. Every
                label and its score will appear here.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
