import Link from "next/link";
import { connection } from "next/server";

import { Badge, Card, SectionHeading } from "@/components/ui";
import {
  FACET_CATEGORY_LIST,
  KIND_LIST,
  facetCounts,
  parseSearchParams,
  search,
  toSearchParams,
  type FacetCount,
  type SearchHit,
} from "@/lib/search";

export const metadata = { title: "Search" };

const FACET_LABEL: Record<string, string> = {
  discipline: "Discipline",
  instrument: "Instrument",
  region: "Region",
};

const KIND_TONE: Record<string, "ice" | "violet" | "amber" | "good" | "neutral"> = {
  Expedition: "ice",
  Report: "violet",
  Dataset: "amber",
  Publication: "good",
  MediaAsset: "neutral",
};

/** Rebuild the current query string with some parameters changed. */
function hrefWith(
  current: URLSearchParams,
  patch: Record<string, string | string[] | null>,
): string {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(patch)) {
    next.delete(key);
    if (value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) next.append(key, item);
    } else {
      next.set(key, value);
    }
  }
  // Any filter change invalidates the current page offset.
  if (!("offset" in patch)) next.delete("offset");
  const query = next.toString();
  return query ? `/search?${query}` : "/search";
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function FacetGroup({
  category,
  counts,
  selected,
  current,
}: {
  category: string;
  counts: FacetCount[];
  selected: string[];
  current: URLSearchParams;
}) {
  if (counts.length === 0) return null;
  return (
    <fieldset className="rounded-xl border border-line bg-surface p-4">
      <legend className="px-1 font-display text-sm font-semibold">
        {FACET_LABEL[category] ?? category}
      </legend>
      <ul className="mt-2 space-y-1">
        {counts.slice(0, 12).map((facet) => {
          const isOn = selected.includes(facet.slug);
          return (
            <li key={facet.tagId}>
              <Link
                href={hrefWith(current, {
                  slug: toggle(selected, facet.slug),
                  facet: category,
                })}
                className={`flex items-center justify-between rounded-lg px-2 py-1.5 text-sm transition ${
                  isOn ? "bg-ice/15 text-ice" : "hover:bg-surface-2"
                }`}
              >
                <span className="truncate">{facet.label}</span>
                <span className="ml-2 shrink-0 font-mono text-xs text-muted">
                  {facet.docCount.toString()}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

function ResultRow({ hit }: { hit: SearchHit }) {
  const href =
    hit.kind === "Expedition" && hit.slug
      ? `/expeditions/${hit.slug}`
      : hit.expeditionSlug
        ? `/expeditions/${hit.expeditionSlug}`
        : "/expeditions";

  return (
    <li className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={KIND_TONE[hit.kind] ?? "neutral"}>{hit.kind}</Badge>
        {hit.region ? <Badge>{hit.region}</Badge> : null}
        {hit.rank > 0 ? (
          <span className="font-mono text-xs text-muted">rank {hit.rank.toFixed(4)}</span>
        ) : null}
      </div>
      <Link href={href} className="mt-2 block font-display font-semibold hover:text-ice">
        {hit.title}
      </Link>
      {hit.expeditionTitle ? (
        <p className="text-xs text-muted">{hit.expeditionTitle}</p>
      ) : null}
      {/* Snippet is plain text from ts_headline — rendered as a text node. */}
      <p className="mt-2 text-sm leading-relaxed text-ink/80">{hit.snippet}</p>
    </li>
  );
}

/** `/search` — Section 5.4 faceted search over the SQL functions. */
export default async function SearchPage({
  searchParams,
}: {
  // Next 16 type: a promise of a plain object, not of URLSearchParams.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();

  const current = toSearchParams(await searchParams);
  const params = parseSearchParams(current);
  const { prisma, reads } = await import("@/lib/db");

  // Sequential — see `reads()` in lib/db.ts.
  const [hits, facets, regions]: [SearchHit[], Record<string, FacetCount[]>, string[]] =
    await reads(
      () => search(params),
      () => facetCounts(params.facetCategory, params.region, params.expeditionId),
      () =>
        prisma.expedition
          .findMany({ select: { region: true }, distinct: ["region"] })
          .then((rows) => rows.map((r) => r.region).sort()),
    );

  const hasFilters =
    params.q.length > 0 ||
    params.facetSlugs.length > 0 ||
    params.region !== null ||
    params.kinds.length > 0;

  return (
    <div className="space-y-6">
      <SectionHeading
        eyebrow="Section 5.4"
        title="Search the archive"
        description="Full-text search and facet counts run inside Postgres via indopolaris_search() and indopolaris_facet_counts(). Filters compose as SQL, and the counts reflect the other active filters."
      />

      {/* Query ------------------------------------------------------------ */}
      <form action="/search" className="flex flex-wrap gap-2">
        <input
          type="search"
          name="q"
          defaultValue={params.q}
          placeholder="sea ice thickness, ice core, katabatic…"
          aria-label="Search query"
          className="min-w-64 flex-1 rounded-xl border border-line bg-surface px-4 py-2.5 text-sm outline-none focus:border-ice"
        />
        <button type="submit" className="rounded-xl border border-ice/40 bg-ice/10 px-5 py-2.5 text-sm font-semibold text-ice hover:bg-ice/20">
          Search
        </button>
        {hasFilters ? (
          <Link
            href="/search"
            className="rounded-xl border border-line px-4 py-2.5 text-sm text-muted hover:text-ink"
          >
            Clear
          </Link>
        ) : null}
      </form>

      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        {/* Sidebar -------------------------------------------------------- */}
        <aside className="space-y-4">
          <fieldset className="rounded-xl border border-line bg-surface p-4">
            <legend className="px-1 font-display text-sm font-semibold">Content type</legend>
            <ul className="mt-2 space-y-1">
              {KIND_LIST.map((kind) => {
                const isOn = params.kinds.includes(kind);
                return (
                  <li key={kind}>
                    <Link
                      href={hrefWith(current, { kind: toggle(params.kinds, kind) })}
                      className={`block rounded-lg px-2 py-1.5 text-sm transition ${
                        isOn ? "bg-ice/15 text-ice" : "hover:bg-surface-2"
                      }`}
                    >
                      {kind}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </fieldset>

          <fieldset className="rounded-xl border border-line bg-surface p-4">
            <legend className="px-1 font-display text-sm font-semibold">Polar region</legend>
            <ul className="mt-2 space-y-1">
              {regions.map((region) => {
                const isOn = params.region === region;
                return (
                  <li key={region}>
                    <Link
                      href={hrefWith(current, { region: isOn ? null : region })}
                      className={`block rounded-lg px-2 py-1.5 text-sm transition ${
                        isOn ? "bg-ice/15 text-ice" : "hover:bg-surface-2"
                      }`}
                    >
                      {region}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </fieldset>

          {FACET_CATEGORY_LIST.map((category) => (
            <FacetGroup
              key={category}
              category={category}
              counts={facets[category] ?? []}
              selected={params.facetSlugs}
              current={current}
            />
          ))}
        </aside>

        {/* Results -------------------------------------------------------- */}
        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted">
              {hits.length > 0 ? (
                <>
                  showing {params.offset + 1}–{params.offset + hits.length}
                </>
              ) : null}
              {params.facetSlugs.length > 0 ? (
                <span>
                  {" "}
                  · filtered by{" "}
                  {params.facetSlugs.map((slug) => (
                    <Badge key={slug} tone="ice">
                      {slug}
                    </Badge>
                  ))}
                </span>
              ) : null}
            </p>
            <div className="flex gap-2 text-xs">
              {params.offset > 0 ? (
                <Link
                  href={hrefWith(current, { offset: String(Math.max(0, params.offset - params.limit)) })}
                  className="rounded-lg border border-line px-3 py-1.5 text-muted hover:text-ink"
                >
                  ← prev
                </Link>
              ) : null}
              {hits.length === params.limit ? (
                <Link
                  href={hrefWith(current, { offset: String(params.offset + params.limit) })}
                  className="rounded-lg border border-line px-3 py-1.5 text-muted hover:text-ink"
                >
                  next →
                </Link>
              ) : null}
            </div>
          </div>

          {hits.length === 0 ? (
            <Card>
              <p className="text-sm text-muted">
                {hasFilters
                  ? "Nothing matched. Postgres full-text search is AND-ing your terms — try fewer words, or clear a facet."
                  : "Search across expeditions, reports, datasets, publications and media."}
              </p>
            </Card>
          ) : (
            <ul className="space-y-3">
              {hits.map((hit) => (
                <ResultRow key={`${hit.kind}:${hit.id}`} hit={hit} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
