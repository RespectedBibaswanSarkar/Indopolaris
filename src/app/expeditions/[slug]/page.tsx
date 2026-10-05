import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { Badge, Card, SectionHeading } from "@/components/ui";

export const metadata = { title: "Expedition" };

const REGION_LABEL: Record<string, string> = {
  SouthernOcean: "Southern Ocean",
};

const STATUS_TONE: Record<string, "amber" | "good" | "bad" | "ice"> = {
  draft: "amber",
  review: "amber",
  published: "good",
  pending_review: "amber",
  approved: "ice",
  rejected: "bad",
};

function formatRange(start: Date, end: Date | null): string {
  const startYear = start.getUTCFullYear();
  if (!end) return `${startYear}–`;
  const endYear = end.getUTCFullYear();
  return endYear === startYear ? String(startYear) : `${startYear}–${endYear}`;
}

/** `/expeditions/[slug]` — the narrative spine of one expedition. */
export default async function ExpeditionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await connection();

  const { slug } = await params;
  const { prisma } = await import("@/lib/db");

  const expedition = await prisma.expedition
    .findUnique({
      where: { slug },
      include: {
        heroImage: { select: { url: true, altText: true, caption: true, credit: true } },
        regionTags: { select: { label: true, slug: true, category: true } },
        reports: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            title: true,
            abstract: true,
            status: true,
            fileType: true,
            createdAt: true,
            disciplineTags: { select: { label: true } },
          },
        },
        datasets: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            title: true,
            description: true,
            format: true,
            sizeBytes: true,
            instrument: true,
            doi: true,
            license: true,
            parameterTags: { select: { label: true } },
          },
        },
        publications: {
          orderBy: { year: "desc" },
          select: {
            id: true,
            title: true,
            authors: true,
            journal: true,
            year: true,
            doi: true,
            abstract: true,
          },
        },
        media: {
          orderBy: { capturedAt: "desc" },
          select: {
            id: true,
            url: true,
            altText: true,
            caption: true,
            credit: true,
            type: true,
            capturedAt: true,
          },
        },
        outreachDrafts: {
          where: { status: "published" },
          orderBy: { publishedAt: "desc" },
          select: {
            id: true,
            draftCaption: true,
            targetChannel: true,
            publishedAt: true,
            sourceType: true,
          },
        },
      },
    })
    .catch(() => null);

  if (!expedition) notFound();

  const tagCounts = (
    ["discipline", "instrument", "region"] as const
  ).map((category) => ({
    category,
    tags: expedition.regionTags.filter((tag) => tag.category === category),
  }));

  return (
    <div className="space-y-10">
      {/* Header ------------------------------------------------------------ */}
      <header className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Link href="/expeditions" className="text-ice hover:underline">
            Expeditions
          </Link>
          <span>/</span>
          <span>{REGION_LABEL[expedition.region] ?? expedition.region}</span>
          <span>·</span>
          <span>{formatRange(expedition.startDate, expedition.endDate)}</span>
        </div>

        <h1 className="font-display text-3xl font-bold leading-tight sm:text-4xl">
          {expedition.title}
        </h1>

        <p className="max-w-3xl text-base leading-relaxed text-ink/85">
          {expedition.summary}
        </p>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <p className="text-xs uppercase tracking-wider text-muted">Lead scientist</p>
            <p className="mt-1 font-semibold">{expedition.leadScientist}</p>
          </Card>
          <Card>
            <p className="text-xs uppercase tracking-wider text-muted">Station</p>
            <p className="mt-1 font-semibold">{expedition.station}</p>
          </Card>
          <Card>
            <p className="text-xs uppercase tracking-wider text-muted">Coordinates</p>
            <p className="mt-1 font-mono text-sm font-semibold">
              {expedition.latitude.toFixed(3)}, {expedition.longitude.toFixed(3)}
            </p>
          </Card>
          <Card>
            <p className="text-xs uppercase tracking-wider text-muted">Vessel</p>
            <p className="mt-1 font-semibold">{expedition.vessel ?? "—"}</p>
          </Card>
        </div>

        {tagCounts.some((group) => group.tags.length > 0) ? (
          <div className="flex flex-wrap gap-2">
            {tagCounts.flatMap((group) =>
              group.tags.map((tag) => (
                <Link key={tag.slug} href={`/search?facet=${group.category}&slug=${tag.slug}`}>
                  <Badge tone="ice">{tag.label}</Badge>
                </Link>
              )),
            )}
          </div>
        ) : null}
      </header>

      {/* Published outreach ------------------------------------------------ */}
      {expedition.outreachDrafts.length > 0 ? (
        <section>
          <SectionHeading
            eyebrow="Section 6"
            title="Published outreach"
            description="Each card went out on the channel and in the time slot the Thompson-sampling bandit chose. Only drafts an editor approved are listed."
          />
          <ul className="grid gap-3 sm:grid-cols-2">
            {expedition.outreachDrafts.map((draft) => (
              <li key={draft.id} className="rounded-xl border border-line bg-surface p-4">
                <div className="flex items-center justify-between gap-2">
                  <Badge tone={STATUS_TONE.published}>{draft.targetChannel}</Badge>
                  <span className="text-xs text-muted">
                    {draft.publishedAt?.toISOString().slice(0, 10)}
                  </span>
                </div>
                <p className="mt-2 text-sm font-semibold">{draft.draftCaption}</p>
                <p className="mt-1 text-xs text-muted">from {draft.sourceType}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Media ------------------------------------------------------------- */}
      {expedition.media.length > 0 ? (
        <section>
          <h3 className="mb-3 font-display text-lg font-semibold">Media</h3>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {expedition.media.slice(0, 6).map((asset) => (
              <li key={asset.id} className="overflow-hidden rounded-xl border border-line bg-surface">
                {/* Seeded media point at remote placeholder URLs; a local upload
                    would come back through /api/media/<key>. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={asset.url}
                  alt={asset.altText}
                  className="h-40 w-full object-cover"
                  loading="lazy"
                />
                <div className="p-3">
                  <p className="text-sm">{asset.caption}</p>
                  <p className="mt-1 text-xs text-muted">{asset.credit}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Reports ----------------------------------------------------------- */}
      <section>
        <h3 className="mb-3 font-display text-lg font-semibold">
          Reports{" "}
          <span className="text-sm font-normal text-muted">({expedition.reports.length})</span>
        </h3>
        {expedition.reports.length === 0 ? (
          <Card>
            <p className="text-sm text-muted">No reports filed.</p>
          </Card>
        ) : (
          <ul className="space-y-3">
            {expedition.reports.map((report) => (
              <li key={report.id} className="rounded-xl border border-line bg-surface p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={STATUS_TONE[report.status] ?? "neutral"}>{report.status}</Badge>
                  <span className="font-mono text-xs text-muted">{report.fileType}</span>
                  {report.disciplineTags.map((tag) => (
                    <Badge key={tag.label} tone="ice">
                      {tag.label}
                    </Badge>
                  ))}
                </div>
                <p className="mt-2 font-semibold">{report.title}</p>
                <p className="mt-1 text-sm leading-relaxed text-ink/80">{report.abstract}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Datasets ---------------------------------------------------------- */}
      <section>
        <h3 className="mb-3 font-display text-lg font-semibold">
          Datasets{" "}
          <span className="text-sm font-normal text-muted">
            ({expedition.datasets.length})
          </span>
        </h3>
        {expedition.datasets.length === 0 ? (
          <Card>
            <p className="text-sm text-muted">No datasets.</p>
          </Card>
        ) : (
          <ul className="space-y-3">
            {expedition.datasets.map((dataset) => (
              <li key={dataset.id} className="rounded-xl border border-line bg-surface p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="amber">{dataset.format}</Badge>
                  <span className="font-mono text-xs text-muted">
                    {(Number(dataset.sizeBytes) / 1024 / 1024).toFixed(1)} MB
                  </span>
                  <span className="text-xs text-muted">{dataset.instrument}</span>
                  {dataset.parameterTags.map((tag) => (
                    <Badge key={tag.label}>{tag.label}</Badge>
                  ))}
                </div>
                <p className="mt-2 font-semibold">{dataset.title}</p>
                <p className="mt-1 text-sm leading-relaxed text-ink/80">
                  {dataset.description}
                </p>
                <p className="mt-2 text-xs text-muted">
                  {dataset.license}
                  {dataset.doi ? ` · DOI ${dataset.doi}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Publications ------------------------------------------------------ */}
      <section>
        <h3 className="mb-3 font-display text-lg font-semibold">
          Publications{" "}
          <span className="text-sm font-normal text-muted">
            ({expedition.publications.length})
          </span>
        </h3>
        {expedition.publications.length === 0 ? (
          <Card>
            <p className="text-sm text-muted">No linked publications.</p>
          </Card>
        ) : (
          <ul className="space-y-3">
            {expedition.publications.map((publication) => (
              <li key={publication.id} className="rounded-xl border border-line bg-surface p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <Badge tone="good">{publication.year}</Badge>
                  <span>{publication.journal}</span>
                  {publication.doi ? <span className="font-mono">{publication.doi}</span> : null}
                </div>
                <p className="mt-2 font-semibold">{publication.title}</p>
                <p className="mt-1 text-xs text-muted">{publication.authors.join(", ")}</p>
                <p className="mt-1 text-sm leading-relaxed text-ink/80">
                  {publication.abstract}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
