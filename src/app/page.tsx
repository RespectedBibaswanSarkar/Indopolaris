import Link from "next/link";
import { connection } from "next/server";

import { Badge, Card, Mono, SectionHeading, Stat } from "@/components/ui";

export const metadata = { title: "India's Window to the Poles" };

/**
 * Landing page.
 *
 * Reads live counts and the ML/RL state so the page shows what the system
 * actually holds rather than aspirational numbers. Everything is behind
 * `connection()` so `next build` still succeeds with no database.
 */

type PipelineState = {
  configured: boolean;
  reachable: boolean;
  modelLoaded: boolean;
  modelVersion: string | null;
  detail: string;
  activeModel: {
    name: string;
    version: string;
    accuracy: number;
    macroF1: number;
    datasetSource: string;
    trainedAt: Date;
  } | null;
  arms: number;
  events: number;
  classifications: number;
};

async function readPipeline(): Promise<PipelineState | null> {
  const [{ isMlConfigured, mlHealth }, { prisma }] = await Promise.all([
    import("@/lib/ml"),
    import("@/lib/db"),
  ]);

  if (!isMlConfigured() && !process.env.DATABASE_URL) return null;

  const health = isMlConfigured() ? await mlHealth().catch(() => null) : null;

  const [modelRow, arms, events, classifications] = await Promise.all([
    prisma.mLModelVersion.findFirst({
      where: { isActive: true },
      orderBy: { trainedAt: "desc" },
    }),
    prisma.banditArmState.count(),
    prisma.engagementEvent.count(),
    prisma.classificationLog.count(),
  ]);

  return {
    configured: isMlConfigured(),
    reachable: health?.reachable ?? false,
    modelLoaded: health?.modelLoaded ?? false,
    modelVersion: health?.modelVersion ?? null,
    detail: health?.detail ?? "ML service not configured",
    activeModel: modelRow
      ? {
          name: modelRow.name,
          version: modelRow.version,
          accuracy: modelRow.accuracy,
          macroF1: modelRow.macroF1,
          datasetSource: modelRow.datasetSource,
          trainedAt: modelRow.trainedAt,
        }
      : null,
    arms,
    events,
    classifications,
  };
}

async function Counts() {
  const { prisma } = await import("@/lib/db");

  const [expeditions, reports, datasets, publications, media, drafts, classified] =
    await Promise.all([
      prisma.expedition.count(),
      prisma.report.count(),
      prisma.dataset.count(),
      prisma.publication.count(),
      prisma.mediaAsset.count(),
      prisma.outreachDraft.count(),
      prisma.report.count({ where: { status: { not: "draft" } } }),
    ]);

  const rows: [string, number][] = [
    ["Expeditions", expeditions],
    ["Reports", reports],
    ["Datasets", datasets],
    ["Publications", publications],
    ["Media assets", media],
    ["Outreach drafts", drafts],
    ["Reviewed reports", classified],
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {rows.map(([label, value]) => (
        <Stat key={label} label={label} value={value} />
      ))}
    </div>
  );
}

export default async function HomePage() {
  await connection();
  const pipeline = await readPipeline().catch(() => null);

  return (
    <div className="space-y-10">
      <section className="pt-6">
        <Badge tone="ice">MoES · NCPOR · problem statement 26063</Badge>
        <h1 className="mt-4 max-w-3xl font-display text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
          A citable archive of Indian polar research, and a public{" "}
          <span className="bg-gradient-to-r from-ice to-violet bg-clip-text text-transparent">
            science-outreach
          </span>{" "}
          pipeline that learns what works.
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">
          Upload a report or dataset and a machine-learning classifier tags it
          with discipline confidences. An editor reviews the generated outreach
          draft. A Thompson-sampling bandit then chooses the channel and time
          slot most likely to reach an audience, and every impression and click
          feeds back into its posterior.
        </p>

        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/studio" className="rounded-lg bg-gradient-to-r from-ice to-violet px-5 py-2.5 text-sm font-semibold text-[#070b14] hover:brightness-110">
            Try the ingest pipeline
          </Link>
          <Link href="/classify" className="rounded-lg border border-line bg-surface-2 px-5 py-2.5 text-sm font-semibold hover:border-ice/60">
            Classifier lab
          </Link>
          <Link href="/ops" className="rounded-lg border border-line bg-surface-2 px-5 py-2.5 text-sm font-semibold hover:border-ice/60">
            Model &amp; bandit state
          </Link>
        </div>
      </section>

      <section>
        <SectionHeading eyebrow="Live archive" title="What the database holds" />
        <Counts />
      </section>

      <section>
        <SectionHeading
          eyebrow="Pipeline state"
          title="Classifier and bandit, right now"
          description="Read from the same tables the pipeline writes to. The accuracy below is the honest measured number on the NASA GES DISC corpus — not a placeholder."
        />

        {!pipeline ? (
          <Card>
            <p className="text-sm text-muted">
              No database configured. Run <code className="text-ice">npm run setup</code>{" "}
              then <code className="text-ice">npm run dev</code>.
            </p>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-display text-lg font-semibold">ML service</h3>
                <Badge
                  tone={!pipeline.configured ? "bad" : pipeline.modelLoaded ? "good" : "amber"}
                >
                  {!pipeline.configured
                    ? "not configured"
                    : !pipeline.reachable
                      ? "offline"
                      : pipeline.modelLoaded
                        ? `v${pipeline.modelVersion ?? "?"}`
                        : "no model"}
                </Badge>
              </div>
              <p className="mt-2 text-sm text-muted">{pipeline.detail}</p>

              {pipeline.activeModel ? (
                <dl className="mt-4 space-y-2 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted">Registry</dt>
                    <dd className="font-mono text-xs">
                      {pipeline.activeModel.name}:{pipeline.activeModel.version}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted">Accuracy</dt>
                    <dd className="font-semibold text-ice">
                      {pipeline.activeModel.accuracy.toFixed(4)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted">Macro-F1</dt>
                    <dd className="font-semibold text-violet">
                      {pipeline.activeModel.macroF1.toFixed(4)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted">Trained</dt>
                    <dd>
                      <Mono>{pipeline.activeModel.trainedAt.toISOString().slice(0, 19)}Z</Mono>
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-4 text-sm text-muted">
                  No active <code>MLModelVersion</code> row. Run{" "}
                  <code className="text-ice">npm run ml:train</code>.
                </p>
              )}
            </Card>

            <Card>
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-display text-lg font-semibold">Publish bandit</h3>
                <Badge tone={pipeline.arms > 0 ? "good" : "amber"}>
                  {pipeline.arms} / 9 arms
                </Badge>
              </div>
              <dl className="mt-4 space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted">Engagement events</dt>
                  <dd className="font-semibold text-ice">{pipeline.events}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted">Classification records</dt>
                  <dd className="font-semibold text-violet">
                    {pipeline.classifications}
                  </dd>
                </div>
              </dl>
              <p className="mt-4 text-xs text-muted">
                Each arm is a Beta posterior over 3 channels × 3 time slots,
                seeded at Beta(1,1). Posteriors live in Postgres so a restart or
                a second instance does not reset what was learned.
              </p>
              <div className="mt-4">
                <Link
                  href="/ops"
                  className="text-sm font-semibold text-ice hover:underline"
                >
                  Inspect arm posteriors →
                </Link>
              </div>
            </Card>
          </div>
        )}
      </section>
    </div>
  );
}
