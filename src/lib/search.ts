import "server-only";

import { Prisma } from "@/generated/prisma/client";

import { prisma } from "@/lib/db";

/**
 * Faceted search, backed by the SQL in `prisma/migrations/1_search`.
 *
 * Both functions are `STABLE` SQL, so they live in Postgres rather than in
 * TypeScript for two reasons that matter to this app:
 *
 *  - `indopolaris_search` unions four content kinds with different tag
 *    relations, so a single `WHERE` in the query planner beats four round-trips
 *    plus a merge in JS.
 *  - `indopolaris_facet_counts` counts documents per tag *excluding* the tags
 *    already selected. That is the correct behaviour for a faceted filter
 *    (faceting on the unfiltered set shows you what selecting more would give
 *    you), and reproducing it in application code means re-implementing the
 *    whole union per request.
 *
 * Snippets come back as plain text from `ts_headline`. They are rendered as
 * text nodes only — never `dangerouslySetInnerHTML`.
 */

export type SearchParams = {
  q: string;
  facetCategory: "discipline" | "instrument" | "region" | null;
  facetSlugs: string[];
  region: string | null;
  expeditionId: string | null;
  kinds: string[];
  limit: number;
  offset: number;
};

export type SearchHit = {
  kind: string;
  id: string;
  slug: string;
  title: string;
  snippet: string;
  rank: number;
  expeditionId: string | null;
  expeditionSlug: string | null;
  expeditionTitle: string | null;
  region: string | null;
  facetSlugs: string[];
};

export type FacetCount = {
  tagId: string;
  label: string;
  slug: string;
  category: string;
  docCount: bigint;
};

const FACET_CATEGORIES = ["discipline", "instrument", "region"] as const;
/** MediaAsset is searchable too (its alt text is indexed) but is not a
 * classification source type — Section 6 only classifies prose-bearing types. */
const KINDS = ["Expedition", "Report", "Dataset", "Publication", "MediaAsset"] as const;

export const FACET_CATEGORY_LIST = FACET_CATEGORIES;
export const KIND_LIST = KINDS;

/**
 * Raw `searchParams` as Next hands it to a page.
 *
 * Next 16 passes `Promise<{ [key: string]: string | string[] | undefined }>`,
 * *not* a `URLSearchParams`. Repeated params arrive as an array, which is the
 * detail that bites: `?slug=a&slug=b` is an array, and reading it as a single
 * string silently drops the second facet.
 */
export type RawSearchParams = Record<string, string | string[] | undefined>;

/** Normalise Next's `searchParams` object into something with `get`/`getAll`. */
export function toSearchParams(raw: RawSearchParams): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else if (value !== undefined) {
      params.set(key, value);
    }
  }
  return params;
}

/** Parse `URLSearchParams` into a validated {@link SearchParams}. */
export function parseSearchParams(params: URLSearchParams): SearchParams {
  const rawKinds = params.getAll("kind");
  const rawLimit = Number.parseInt(params.get("limit") ?? "", 10);
  const rawOffset = Number.parseInt(params.get("offset") ?? "", 10);

  return {
    q: (params.get("q") ?? "").slice(0, 200),
    facetCategory: FACET_CATEGORIES.find((c) => c === params.get("facet")) ?? null,
    // `facet` narrows *which* vocabulary is being filtered; the slugs are the
    // values. Repeat the param for multi-select.
    facetSlugs: params.getAll("slug").slice(0, 20),
    region: params.get("region"),
    expeditionId: params.get("expedition"),
    kinds: KINDS.filter((k) => rawKinds.includes(k)),
    limit: Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 20,
    offset: Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0,
  };
}

export async function search(params: SearchParams): Promise<SearchHit[]> {
  // The SQL function returns snake_case column names. Alias them here rather
  // than duplicating that shape in the UI: `SELECT *` would also break the day
  // somebody adds a column to the RETURNS TABLE.
  const rows = await prisma.$queryRaw<SearchHit[]>(Prisma.sql`
    SELECT
      kind,
      id,
      slug,
      title,
      snippet,
      rank,
      expedition_id      AS "expeditionId",
      expedition_slug   AS "expeditionSlug",
      expedition_title  AS "expeditionTitle",
      region,
      facet_slugs       AS "facetSlugs"
    FROM indopolaris_search(
      ${params.q},
      ${params.facetCategory},
      ${params.facetSlugs.length > 0 ? params.facetSlugs : null}::text[],
      ${params.region},
      ${params.expeditionId},
      ${params.kinds.length > 0 ? params.kinds : null}::text[],
      ${params.limit},
      ${params.offset}
    )
  `);

  return rows;
}

/**
 * Facet counts for the current filter.
 *
 * Note the deliberate absence of the selected slugs as an argument: the SQL
 * counts documents per tag over the *other* active filters, which is what makes
 * a multi-select facet usable. Counting over the already-selected slugs would
 * make every remaining option read as zero.
 */
export async function facetCounts(
  facetCategory: SearchParams["facetCategory"],
  region: string | null,
  expeditionId: string | null,
): Promise<Record<string, FacetCount[]>> {
  const rows = await prisma.$queryRaw<FacetCount[]>(Prisma.sql`
    SELECT
      tag_id    AS "tagId",
      label,
      slug,
      category,
      doc_count AS "docCount"
    FROM indopolaris_facet_counts(
      ${facetCategory},
      ${region},
      ${expeditionId}
    )
  `);

  const grouped: Record<string, FacetCount[]> = { discipline: [], instrument: [], region: [] };
  for (const row of rows) {
    (grouped[row.category] ??= []).push(row);
  }
  for (const list of Object.values(grouped)) {
    list.sort((a, b) => Number(b.docCount - a.docCount) || a.label.localeCompare(b.label));
  }
  return grouped;
}
