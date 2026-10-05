-- ===========================================================================
-- Section 5.4 — Postgres full-text search across the repository.
--
-- Design:
--   * One `search_vector` GENERATED column per searchable table, built with
--     `to_tsvector(regconfig, text)`. Passing the config explicitly (rather
--     than relying on default_text_search_config) keeps the expression
--     IMMUTABLE, which is what makes it legal inside a generated column.
--   * A GIN index per vector. GIN is the right structure here: the corpus is
--     small and write-light, and we want ranked document search, not prefix
--     matching. No Elasticsearch needed at this scale.
--   * `indopolaris_search(...)` UNIONs the tables into one ranked result set so
--     the UI can show mixed-type hits from a single query.
--   * Tags are NOT folded into the vectors. Faceted search treats them as exact
--     filters (the caller passes facet slugs), which is both faster and more
--     predictable than trying to keep a join table's labels inside a
--     generated column — that would need triggers on the m2m tables to stay
--     consistent, for no recall benefit.
--   * Snippets come back as PLAIN TEXT (StartSel/StopSel are emptied on
--     purpose). The app layer highlights matched terms in React, which keeps
--     user input from ever reaching dangerouslySetInnerHTML.
-- ===========================================================================

-- --- Vectors --------------------------------------------------------------

-- `array_to_string(anyarray, text)` is declared STABLE, not IMMUTABLE, so it
-- cannot appear in a generated column expression — and Publication.authors is
-- `String[]`, which we do want searchable ("find everything by Devi").
--
-- The volatility is an artifact of the function being generic over anyarray: it
-- has to invoke the element type's *output* function, which for a user-defined
-- type could be volatile. This wrapper is deliberately narrow — text[] only —
-- and for text[] that output function is text_out, which IS immutable. So the
-- IMMUTABLE marking is accurate for this exact signature, not a guess. The
-- alternative (dropping authors from the index, or maintaining the vector with
-- an UPDATE trigger) is either a functional regression or more machinery for
-- no benefit.
CREATE OR REPLACE FUNCTION immutable_text_array_join(arr text[], sep text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  STRICT
AS $$ SELECT array_to_string(arr, sep) $$;

ALTER TABLE "Expedition" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("station", '')), 'B') ||
    setweight(to_tsvector('english', coalesce("leadScientist", '')), 'B') ||
    setweight(to_tsvector('english', coalesce("summary", '')), 'C')
  ) STORED;

ALTER TABLE "Report" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("abstract", '')), 'C')
  ) STORED;

ALTER TABLE "Dataset" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("description", '')), 'C') ||
    setweight(to_tsvector('english', coalesce("instrument", '')), 'B')
  ) STORED;

ALTER TABLE "Publication" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("journal", '')), 'B') ||
    setweight(to_tsvector('english', coalesce("abstract", '')), 'C') ||
    setweight(to_tsvector('english', coalesce(immutable_text_array_join("authors", ' '), '')), 'B')
  ) STORED;

-- Section 6 requires altText to feed search, so captions and alt text are both
-- indexed for media.
ALTER TABLE "MediaAsset" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("caption", '')), 'C') ||
    setweight(to_tsvector('english', coalesce("altText", '')), 'C') ||
    setweight(to_tsvector('english', coalesce("credit", '')), 'B')
  ) STORED;

-- --- Indexes --------------------------------------------------------------

CREATE INDEX "Expedition_search_vector_idx"   ON "Expedition"   USING GIN ("search_vector");
CREATE INDEX "Report_search_vector_idx"        ON "Report"        USING GIN ("search_vector");
CREATE INDEX "Dataset_search_vector_idx"       ON "Dataset"       USING GIN ("search_vector");
CREATE INDEX "Publication_search_vector_idx"   ON "Publication"   USING GIN ("search_vector");
CREATE INDEX "MediaAsset_search_vector_idx"    ON "MediaAsset"    USING GIN ("search_vector");

-- Supporting indexes for the facet joins the search function performs.
CREATE INDEX "_ReportDisciplineTags_A_idx"      ON "_ReportDisciplineTags"("A");
CREATE INDEX "_ReportDisciplineTags_B_idx"      ON "_ReportDisciplineTags"("B");
CREATE INDEX "_DatasetParameterTags_A_idx"      ON "_DatasetParameterTags"("A");
CREATE INDEX "_DatasetParameterTags_B_idx"      ON "_DatasetParameterTags"("B");
CREATE INDEX "_PublicationDisciplineTags_A_idx" ON "_PublicationDisciplineTags"("A");
CREATE INDEX "_PublicationDisciplineTags_B_idx" ON "_PublicationDisciplineTags"("B");
CREATE INDEX "_ExpeditionRegionTags_A_idx"      ON "_ExpeditionRegionTags"("A");
CREATE INDEX "_ExpeditionRegionTags_B_idx"      ON "_ExpeditionRegionTags"("B");

-- ---------------------------------------------------------------------------
-- Unified ranked search
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION indopolaris_search(
  query_text     text    DEFAULT NULL,
  facet_category text    DEFAULT NULL,   -- 'discipline' | 'instrument' | 'region'
  facet_slugs    text[]  DEFAULT NULL,
  region_filter  text    DEFAULT NULL,   -- Region enum name, e.g. 'Antarctica'
  expedition_id  text    DEFAULT NULL,
  kind_filter    text[]  DEFAULT NULL,   -- NULL = all kinds
  result_limit   integer DEFAULT 20,
  result_offset  integer DEFAULT 0
)
RETURNS TABLE (
  kind            text,
  id              text,
  slug            text,
  title           text,
  snippet         text,
  rank            real,
  expedition_id   text,
  expedition_slug text,
  expedition_title text,
  region          text,
  facet_slugs     text[]
)
LANGUAGE sql
STABLE
AS $$
  WITH q AS (
    SELECT CASE
      WHEN query_text IS NULL OR btrim(query_text) = '' THEN NULL
      ELSE websearch_to_tsquery('english', query_text)
    END AS tsq
  ),
  hits AS (
    -- Expedition ---------------------------------------------------------
    SELECT
      'Expedition'::text          AS kind,
      e."id"                      AS id,
      e."slug"                    AS slug,
      e."title"                   AS title,
      ts_headline('english', e."summary", q.tsq,
        'MaxWords=30, MinWords=12, MaxFragments=1, StartSel=, StopSel=, FragmentDelimiter= … ') AS snippet,
      ts_rank(e."search_vector", q.tsq) AS rank,
      e."id"                      AS expedition_id,
      e."slug"                    AS expedition_slug,
      e."title"                   AS expedition_title,
      e."region"::text            AS region,
      COALESCE((SELECT array_agg(t."slug")
                  FROM "_ExpeditionRegionTags" jt
                  JOIN "Tag" t ON t."id" = jt."B"
                 WHERE jt."A" = e."id"), '{}') AS facet_slugs
    FROM "Expedition" e, q
    WHERE (q.tsq IS NULL OR e."search_vector" @@ q.tsq)
      AND (region_filter IS NULL OR e."region"::text = region_filter)
      AND (expedition_id IS NULL OR e."id" = expedition_id)
      AND (facet_slugs IS NULL OR EXISTS (
            SELECT 1 FROM "_ExpeditionRegionTags" jt
              JOIN "Tag" t ON t."id" = jt."B"
             WHERE jt."A" = e."id" AND t."slug" = ANY (facet_slugs)
               AND (facet_category IS NULL OR t."category"::text = facet_category)))

    UNION ALL

    -- Report -------------------------------------------------------------
    SELECT
      'Report', r."id", NULL, r."title",
      ts_headline('english', r."abstract", q.tsq,
        'MaxWords=30, MinWords=12, MaxFragments=1, StartSel=, StopSel=, FragmentDelimiter= … '),
      ts_rank(r."search_vector", q.tsq),
      e."id", e."slug", e."title", e."region"::text,
      COALESCE((SELECT array_agg(t."slug")
                  FROM "_ReportDisciplineTags" jt
                  JOIN "Tag" t ON t."id" = jt."B"
                 WHERE jt."A" = r."id"), '{}')
    FROM "Report" r
    JOIN "Expedition" e ON e."id" = r."expeditionId", q
    WHERE (q.tsq IS NULL OR r."search_vector" @@ q.tsq)
      AND (region_filter IS NULL OR e."region"::text = region_filter)
      AND (expedition_id IS NULL OR r."expeditionId" = expedition_id)
      AND (kind_filter IS NULL OR 'Report' = ANY (kind_filter))
      AND (facet_slugs IS NULL OR EXISTS (
            SELECT 1 FROM "_ReportDisciplineTags" jt
              JOIN "Tag" t ON t."id" = jt."B"
             WHERE jt."A" = r."id" AND t."slug" = ANY (facet_slugs)
               AND (facet_category IS NULL OR t."category"::text = facet_category)))

    UNION ALL

    -- Dataset ------------------------------------------------------------
    SELECT
      'Dataset', d."id", NULL, d."title",
      ts_headline('english', d."description", q.tsq,
        'MaxWords=30, MinWords=12, MaxFragments=1, StartSel=, StopSel=, FragmentDelimiter= … '),
      ts_rank(d."search_vector", q.tsq),
      e."id", e."slug", e."title", e."region"::text,
      COALESCE((SELECT array_agg(t."slug")
                  FROM "_DatasetParameterTags" jt
                  JOIN "Tag" t ON t."id" = jt."B"
                 WHERE jt."A" = d."id"), '{}')
    FROM "Dataset" d
    JOIN "Expedition" e ON e."id" = d."expeditionId", q
    WHERE (q.tsq IS NULL OR d."search_vector" @@ q.tsq)
      AND (region_filter IS NULL OR e."region"::text = region_filter)
      AND (expedition_id IS NULL OR d."expeditionId" = expedition_id)
      AND (kind_filter IS NULL OR 'Dataset' = ANY (kind_filter))
      AND (facet_slugs IS NULL OR EXISTS (
            SELECT 1 FROM "_DatasetParameterTags" jt
              JOIN "Tag" t ON t."id" = jt."B"
             WHERE jt."A" = d."id" AND t."slug" = ANY (facet_slugs)
               AND (facet_category IS NULL OR t."category"::text = facet_category)))

    UNION ALL

    -- Publication --------------------------------------------------------
    SELECT
      'Publication', p."id", NULL, p."title",
      ts_headline('english', p."abstract", q.tsq,
        'MaxWords=30, MinWords=12, MaxFragments=1, StartSel=, StopSel=, FragmentDelimiter= … '),
      ts_rank(p."search_vector", q.tsq),
      e."id", e."slug", e."title", e."region"::text,
      COALESCE((SELECT array_agg(t."slug")
                  FROM "_PublicationDisciplineTags" jt
                  JOIN "Tag" t ON t."id" = jt."B"
                 WHERE jt."A" = p."id"), '{}')
    FROM "Publication" p
    LEFT JOIN "Expedition" e ON e."id" = p."relatedExpeditionId", q
    WHERE (q.tsq IS NULL OR p."search_vector" @@ q.tsq)
      AND (region_filter IS NULL OR e."region"::text = region_filter)
      AND (expedition_id IS NULL OR p."relatedExpeditionId" = expedition_id)
      AND (kind_filter IS NULL OR 'Publication' = ANY (kind_filter))
      AND (facet_slugs IS NULL OR EXISTS (
            SELECT 1 FROM "_PublicationDisciplineTags" jt
              JOIN "Tag" t ON t."id" = jt."B"
             WHERE jt."A" = p."id" AND t."slug" = ANY (facet_slugs)
               AND (facet_category IS NULL OR t."category"::text = facet_category)))

    UNION ALL

    -- MediaAsset ---------------------------------------------------------
    SELECT
      'MediaAsset', m."id", NULL, m."caption",
      ts_headline('english', m."altText", q.tsq,
        'MaxWords=24, MinWords=8, MaxFragments=1, StartSel=, StopSel=, FragmentDelimiter= … '),
      ts_rank(m."search_vector", q.tsq) * 0.5,  -- media ranks below text records
      e."id", e."slug", e."title", e."region"::text,
      '{}'::text[]
    FROM "MediaAsset" m
    LEFT JOIN "Expedition" e ON e."id" = m."expeditionId", q
    WHERE (q.tsq IS NULL OR m."search_vector" @@ q.tsq)
      AND (region_filter IS NULL OR e."region"::text = region_filter)
      AND (expedition_id IS NULL OR m."expeditionId" = expedition_id)
      AND (kind_filter IS NULL OR 'MediaAsset' = ANY (kind_filter))
  )
  SELECT h.kind, h.id, h.slug, h.title, h.snippet, h.rank,
         h.expedition_id, h.expedition_slug, h.expedition_title,
         h.region, h.facet_slugs
    FROM hits h
   WHERE h.rank IS NOT NULL
   ORDER BY h.rank DESC, h.title ASC
   LIMIT GREATEST(result_limit, 0) OFFSET GREATEST(result_offset, 0);
$$;

-- ---------------------------------------------------------------------------
-- Facet counts, for the filter sidebar.
-- Returns every tag in the vocabulary with how many currently-visible records
-- carry it, so the UI can show counts and disable dead ends.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION indopolaris_facet_counts(
  facet_category text   DEFAULT NULL,
  region_filter  text   DEFAULT NULL,
  expedition_id  text   DEFAULT NULL
)
RETURNS TABLE (
  tag_id     text,
  label      text,
  slug       text,
  category   text,
  doc_count  bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT t."id", t."label", t."slug", t."category"::text, COUNT(DISTINCT src."docId")
  FROM "Tag" t
  JOIN (
    SELECT jt."A" AS "docId"
      FROM "_ReportDisciplineTags" jt
      JOIN "Report" r ON r."id" = jt."A"
      JOIN "Expedition" e ON e."id" = r."expeditionId"
     WHERE (region_filter IS NULL OR e."region"::text = region_filter)
       AND (expedition_id IS NULL OR r."expeditionId" = expedition_id)
    UNION ALL
    SELECT jt."A"
      FROM "_DatasetParameterTags" jt
      JOIN "Dataset" d ON d."id" = jt."A"
      JOIN "Expedition" e ON e."id" = d."expeditionId"
     WHERE (region_filter IS NULL OR e."region"::text = region_filter)
       AND (expedition_id IS NULL OR d."expeditionId" = expedition_id)
    UNION ALL
    SELECT jt."A"
      FROM "_PublicationDisciplineTags" jt
      JOIN "Publication" p ON p."id" = jt."A"
      LEFT JOIN "Expedition" e ON e."id" = p."relatedExpeditionId"
     WHERE (region_filter IS NULL OR e."region"::text = region_filter)
       AND (expedition_id IS NULL OR p."relatedExpeditionId" = expedition_id)
    UNION ALL
    SELECT jt."A"
      FROM "_ExpeditionRegionTags" jt
      JOIN "Expedition" e2 ON e2."id" = jt."A"
     WHERE (region_filter IS NULL OR e2."region"::text = region_filter)
       AND (expedition_id IS NULL OR e2."id" = expedition_id)
  ) src ON src."docId" = t."id"
  WHERE facet_category IS NULL OR t."category"::text = facet_category
  GROUP BY t."id", t."label", t."slug", t."category"
  ORDER BY t."category", t."label";
$$;
