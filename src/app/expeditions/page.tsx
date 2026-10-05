import Link from "next/link";
import { connection } from "next/server";

import { Badge, Card, SectionHeading } from "@/components/ui";

export const metadata = { title: "Expeditions" };

const REGION_TONE: Record<string, "ice" | "violet" | "amber" | "neutral"> = {
  Antarctica: "ice",
  Arctic: "violet",
  Himalaya: "amber",
  SouthernOcean: "neutral",
};

const REGION_LABEL: Record<string, string> = {
  SouthernOcean: "Southern Ocean",
};

/** `/expeditions` — the archive index. */
export default async function ExpeditionsPage() {
  await connection();
  const { prisma } = await import("@/lib/db");

  const expeditions = await prisma.expedition
    .findMany({
      orderBy: { startDate: "desc" },
      select: {
        id: true,
        slug: true,
        title: true,
        region: true,
        startDate: true,
        endDate: true,
        leadScientist: true,
        station: true,
        summary: true,
        isFeatured: true,
        latitude: true,
        longitude: true,
        _count: { select: { reports: true, datasets: true, publications: true, media: true } },
      },
    })
    .catch(() => []);

  return (
    <div className="space-y-6">
      <SectionHeading
        eyebrow="Archive"
        title="Expeditions"
        description="Every row below is seeded into Postgres by prisma/seed.ts. The seed data is fictional — see the README's licence section — but the schema, constraints and relations are the real ones."
      />

      {expeditions.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">
            No expeditions. Run <code className="text-ice">npm run db:seed</code>.
          </p>
        </Card>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {expeditions.map((expedition) => (
            <li key={expedition.id}>
              <Link
                href={`/expeditions/${expedition.slug}`}
                className="block h-full rounded-xl border border-line bg-surface p-5 transition hover:border-ice/60"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={REGION_TONE[expedition.region] ?? "neutral"}>
                    {REGION_LABEL[expedition.region] ?? expedition.region}
                  </Badge>
                  {expedition.isFeatured ? <Badge tone="amber">featured</Badge> : null}
                  <span className="text-xs text-muted">
                    {expedition.startDate.getUTCFullYear()}
                    {expedition.endDate
                      ? `–${expedition.endDate.getUTCFullYear()}`
                      : "–"}
                  </span>
                </div>

                <h3 className="mt-3 font-display text-lg font-semibold leading-snug">
                  {expedition.title}
                </h3>
                <p className="mt-1 text-xs text-muted">
                  {expedition.leadScientist} · {expedition.station}
                </p>
                <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-ink/80">
                  {expedition.summary}
                </p>

                <div className="mt-4 flex flex-wrap gap-2 text-xs text-muted">
                  <Badge>{expedition._count.reports} reports</Badge>
                  <Badge>{expedition._count.datasets} datasets</Badge>
                  <Badge>{expedition._count.publications} publications</Badge>
                  <Badge>{expedition._count.media} media</Badge>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
