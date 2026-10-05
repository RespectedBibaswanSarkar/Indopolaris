<div align="center">

# ✦ IndoPolaris

**India's Window to the Poles**

A unified platform where NCPOR's polar expeditions, research data and
publications become both a citable scientific archive and a public
science-outreach experience.

*Smart India Hackathon 2026 · Problem Statement 26063 · MoES / NCPOR*

</div>

---

> **Status: Phase 2 of 9 — ML service complete, plus the Section 6 bandit.**
> Working: Postgres schema + migrations, full-text search, database-enforced
> integrity constraints, seed data, object storage, health endpoints, a
> versioned soft-voting discipline ensemble served over HTTP by a Python FastAPI
> service, and a live Thompson-sampling publish bandit backed by
> `BanditArmState` rows. The classifier is trained on **real labelled
> Earth-science publications** from NASA GES DISC — measured **0.4448
> accuracy / 0.4518 macro-F1**, which is a *real* number on real data and a
> weak model; see [Training corpus and honest numbers](#training-corpus-and-honest-numbers)
> for why, and for what would replace it. Not yet built: the outreach UI, data
> explorer, CMS, and the Claude pipeline. See [Build phases](#build-phases).

---

## Quick start

### With Docker

```bash
cp .env.example .env
docker compose up -d                 # Postgres 16 + MinIO + ml-service
npm install
npm run setup                        # placeholders, client, migrate, seed
npm run dev                          # http://localhost:3000
```

`ml-service` builds an image that expects a trained artifact, so run
`npm run bootstrap` once before the first `docker compose up`.

To run the app itself in a container as well:

```bash
docker compose --profile app up --build
```

### Without Docker

There is a real fallback, because a Postgres you cannot start is not a
database. [`scripts/pglite-server.mjs`](scripts/pglite-server.mjs) runs
**PGlite** — actual PostgreSQL compiled to WASM — in-process and exposes it on
port 5432 over the Postgres wire protocol. `psql`, the Prisma CLI and
`@prisma/client` connect to it exactly as they would to the `db` service, so
**no application code, schema or migration changes**. It is a development
convenience: single-process, single-connection, not for deployment.

```bash
npm install
cp .env.example .env
npm run bootstrap                    # ML venv, corpus, trained model

# terminal 1 — the database
npm run db:pglite

# terminal 2
npm run db:migrate
npm run db:seed

# terminal 3
npm run ml:serve

# terminal 4
npm run dev
```

Or run the whole thing ephemerally, which is also what CI should do:

```bash
node scripts/with-db.mjs -- npm run verify
```

### Demo accounts

All seeded accounts share the password `indopolaris2026`.

| Email | Role | Can do |
| --- | --- | --- |
| `admin@indopolaris.gov.in` | `admin` | everything |
| `editor@indopolaris.gov.in` | `editor` | review and publish outreach drafts |
| `deshmukh@indopolaris.gov.in` | `contributor` | upload reports, datasets, media |
| `iyer@indopolaris.gov.in` | `contributor` | upload reports, datasets, media |
| `bhattacharya@indopolaris.gov.in` | `contributor` | upload reports, datasets, media |

---

## Architecture

```
indopolaris/
├─ prisma/
│  ├─ schema.prisma            data model (Section 4)
│  ├─ seed.ts                  realistic sample data, idempotent
│  └─ migrations/
│     ├─ 0_init/               tables, indexes, integrity CHECK constraints
│     └─ 1_search/             tsvector columns, GIN indexes, search functions
├─ scripts/
│  ├─ pglite-server.mjs        Docker-free Postgres for development
│  ├─ with-db.mjs              run any command against a throwaway database
│  ├─ generate-placeholder-media.mjs
│  ├─ verify-constraints.ts    negative tests for the CHECK constraints
│  ├─ smoke.mjs                boots the built app against a live database
│  ├─ smoke-ml.mjs             Node↔Python integration, up *and* down
│  ├─ ml-client.test.ts        retry / timeout / degradation contracts
│  └─ bootstrap.sh             one command: venv, corpus, model, tests
├─ ml/                         Python classifier + bandit service (Phase 2)
│  ├─ app/
│  │  ├─ main.py               FastAPI: /classify /recommend /feedback /health
│  │  ├─ classifier.py         ensemble loading + inference
│  │  ├─ bandit.py             Thompson sampling, Beta posteriors, learning curve
│  │  ├─ schemas.py            Pydantic contracts, error envelope
│  │  ├─ db.py                 MLModelVersion reads, ClassificationLog + bandit writes
│  │  ├─ config.py             settings; Prisma DSN → libpq DSN
│  │  └─ logging_config.py     JSON logs, X-Request-ID
│  ├─ scripts/                 download_dataset · train_ensemble · simulate_engagement · export_openapi
│  ├─ tests/                   integration tests against the real artifact
│  ├─ models/metrics.json      committed — the accuracy/F1 evidence
│  └─ openapi.json             committed — the Node↔Python contract
├─ src/
│  ├─ app/                     App Router — pages and API routes
│  ├─ lib/
│  │  ├─ db.ts                 Prisma client singleton (driver adapter)
│  │  ├─ env.ts                validated, centralised environment access
│  │  ├─ ml.ts                 Node → Python client: timeout, retry, degrade
│  │  ├─ ml-openapi.d.ts       generated from ml/openapi.json
│  │  └─ storage.ts            S3 / MinIO client
│  └─ generated/prisma/        generated client (gitignored)
├─ docker-compose.yml          Postgres + MinIO + ml-service (+ app profile)
├─ Dockerfile                  multi-stage, non-root, standalone output
└─ ml/Dockerfile               non-root, model baked in, healthcheck
```

**Single Next.js app, not a monorepo.** The spec allowed either colocating
route handlers with the frontend or standing up a separate service. One app
means shared types across the API and UI, no cross-service auth plumbing, and a
one-command deploy — which matters more than architectural symmetry for a
hackathon build. If the media pipeline later needs independent scaling, the
storage layer in `src/lib/storage.ts` is already the seam to cut along.

### Stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Framework | Next.js 16 (App Router, Turbopack) | React 19, TypeScript strict |
| Styling | Tailwind CSS v4 | CSS-first `@theme` tokens, no JS config file |
| ORM | Prisma 7 + `@prisma/adapter-pg` | driver adapter, so one codebase spans Postgres and PGlite |
| Database | PostgreSQL 16 | native full-text search, no Elasticsearch needed at this scale |
| Storage | MinIO / S3-compatible | swap the endpoint, nothing else changes |
| Auth | Auth.js v5 (`next-auth@beta`) | Credentials provider, four roles |
| Classifier | Python + FastAPI + scikit-learn | separate service, soft-voting ensemble, Phase 2 |
| AI | `@anthropic/ai/sdk` | draft generation, human-approved (Phase 7) |
| i18n | `next-intl` | English / Hindi (Phase 8) |
| Maps | Leaflet + `react-leaflet` | Phase 4 |

---

## Why the AI pipeline is human-in-the-loop

**This is the design decision most likely to be questioned, so here is the
reasoning rather than a slogan.**

IndoPolaris sits inside a Ministry of Earth Sciences institution. Two facts
follow from that, and together they determine the architecture:

1. **A wrong scientific claim is expensive.** NCPOR's outputs are cited by
   downstream climate research and quoted in policy. A generated summary that
   overstates a finding does not just look bad on a webpage — it becomes a
   citable error attached to a national institution's name. No amount of
   prompt quality removes that tail risk.

2. **Automation removes the accountability that currently makes the output
   trustworthy.** Today a named scientist owns a published claim. A pipeline
   that publishes on its own removes the name.

So the model is not "AI with a human in the loop" as a hedge — it is
**separation of duties**. The machine does what it is good at (compressing a
technical abstract into 150 readable words, drafting a caption under the
character limit, shortlisting the photos that actually depict the subject).
The human does what only a human can do (deciding whether it is *true* and
whether it is *appropriate to say publicly*). The editor's name is attached to
everything published.

**This is enforced in the database, not just in the UI.** See
`outreach_draft_published_requires_review` below: a draft with
`status = 'published'` and no `reviewedById` is rejected by Postgres. A
reviewer cannot be bypassed by a well-meaning code path, a direct SQL session,
or a future refactor that forgets a check. `npm run db:verify-constraints`
proves it.

The second benefit is mundane and real: editors can rewrite a draft, and the
review record shows what a human changed. That is what makes the archive
citable.

---

## Data model notes

The Prisma schema follows Section 4 closely. Where it departs, the reason is
recorded in `prisma/schema.prisma` and repeated here.

**Tags are relations, not strings.** Section 4 sketches `disciplineTags[]` and
`parameterTags[]` as arrays, and separately defines a `Tag` model for faceted
search. Modelling the former as real many-to-many relations to the latter
(field names preserved exactly) means a facet filter is a join rather than a
string match, and a typo'd tag cannot be created.

**`Expedition` gained `slug`, `latitude`, `longitude` and `route`.** Section
5.1 requires map pins "by station/route", which is not possible without
coordinates. `route` is a GeoJSON `LineString` stored as `Json` rather than a
PostGIS geometry: Leaflet only reads the coordinates, so a PostGIS dependency
would buy nothing at this scale.

**`OutreachDraft`'s polymorphic source is made referential.** Section 4 models
it as `sourceType` + `sourceId`, which Prisma cannot express. Both fields are
kept for fidelity, and four nullable typed foreign keys carry the real
integrity, with `CHECK` constraints keeping them consistent with `sourceType`.

**`MediaAsset.altText` is `NOT NULL` with a `CHECK (btrim(...) <> '')`.**
Section 6 is explicit that this is a schema-level requirement, not a
convention. The `btrim` matters: `altText: "   "` satisfies `NOT NULL` and
still fails every screen reader.

### Integrity constraints

Prisma's schema language cannot express `CHECK` constraints, so every rule the
spec actually depends on is hand-written SQL in
`prisma/migrations/0_init/migration.sql`:

| Constraint | Enforces |
| --- | --- |
| `MediaAsset_altText_not_blank` | §6 — alt text is mandatory, not whitespace |
| `Expedition_dates_ordered` | an expedition cannot end before it starts |
| `outreach_draft_single_source` | §4 — a draft points at exactly one source, matching `sourceType` |
| `outreach_draft_sourceId_consistent` | `sourceId` cannot contradict `sourceType` |
| `outreach_draft_published_requires_review` | §5.3 — nothing publishes without a named reviewer and a timestamp |
| `Tag_label_not_blank` | a blank facet label is a dead end in the filter UI |

Phase 2 added a second migration, `prisma/migrations/2_ml/migration.sql`, with the
same discipline applied to the ML tables: `BanditArmState.arm` name validation,
`ClassificationLog.actualTags ⊆ predictedTags` when corrections exist,
`EngagementEvent` reward and click/impression consistency, and non-blank text on
a classification. A correction that claims a tag the model never predicted would
corrupt every future training run, so the database refuses it.

A constraint nobody has tried to violate is a constraint nobody knows works, so
each one has a negative test:

```bash
npm run db:verify-constraints
# 20 passed, 0 failed
```

### Full-text search

One `tsvector` **generated** column per searchable table, a GIN index each, and
two SQL functions:

- `indopolaris_search(query, facet_category, facet_slugs, region, expedition_id, kinds, limit, offset)`
  — `UNION ALL` across expeditions, reports, datasets, publications and media,
  ranked with `ts_rank`, with `ts_headline` snippets and the parent expedition
  attached to every hit.
- `indopolaris_facet_counts(...)` — per-tag document counts for the filter
  sidebar.

Two deliberate choices:

- **Tags are not folded into the vectors.** Faceted search treats them as exact
  filters. Keeping a join table's labels inside a generated column would need
  triggers on the m2m tables to stay consistent, for no recall benefit.
- **Snippets return plain text.** `StartSel`/`StopSel` are emptied on purpose,
  so user input never reaches `dangerouslySetInnerHTML`; the UI highlights
  matched terms in React instead.

`to_tsvector` is called with an explicit `'english'` config rather than relying
on `default_text_search_config`, because passing the config explicitly is what
makes the expression `IMMUTABLE` and therefore legal in a generated column.
`Publication.authors` is `String[]`, and `array_to_string` is `STABLE`, so a
narrow `immutable_text_array_join(text[], text)` wrapper exists — documented in
the migration, including why the volatility marking is accurate for `text[]`
rather than a guess.

---

## ML service (Phase 2)

Predicts a document's discipline tag at upload time, so a contributor does not
pick tags by hand and a reviewer does not fix them afterwards. It is a **separate
Python service** with four endpoints:

| Endpoint | Purpose |
| --- | --- |
| `POST /classify` | `{text, sourceType, sourceId?}` → predicted tags + per-tag confidence |
| `GET /recommend` | Thompson-sampled `(channel, timeSlot)` for the next publish |
| `POST /feedback` | record impressions/clicks, fold the reward into the arm's posterior |
| `GET /health` | model loaded? database reachable? |

`/recommend` and `/feedback` are proxied to the browser by
`/api/ml/recommend` and `/api/ml/feedback`; port 8000 is an internal hop and
should not be exposed directly.

## Training corpus and honest numbers

**The corpus is real; the task is not the one we want.**

Training data is
[`nasa-gesdisc/es-publications-researchareas`](https://huggingface.co/datasets/nasa-gesdisc/es-publications-researchareas)
— 2,326 NASA GES DISC publications (2003–2024), each carrying one or more
curated Earth-science research-area labels, filtered to records with a DOI. One
(title + abstract) example is emitted per label, giving 2,986 examples across 21
classes. `Cryospheric Indicators`, the closest class to NCPOR's remit, has 114
examples.

Every number below is measured on this corpus. Nothing is a proxy in the sense
of "borrowed from an unrelated dataset" — but the headline accuracy is **poor**,
and it is important to say why rather than to shop for a flattering metric.

### Measured performance

Stratified 80/20 split, seed 42, TF-IDF fit on the training fold only:

| Metric | Value |
| --- | --- |
| Accuracy | **0.4448** |
| Macro-F1 | **0.4518** |
| Held-out examples | 598 (of 2,986) |
| Features | 15,000, TF-IDF word 1–2gram, English stopwords |
| Model | `VotingClassifier(soft)` over 3 estimators |

Component scores, because the ensemble's behaviour has to be read against them:

| Estimator | Accuracy | Macro-F1 |
| --- | --- | --- |
| `LogisticRegression` | 0.4950 | 0.5071 |
| `RandomForestClassifier` | 0.4582 | 0.4728 |
| `MultinomialNB` | 0.3946 | 0.3112 |
| **Soft-voting ensemble** | **0.4448** | **0.4518** |

**The equal-weight ensemble is worse than its best member.** That is a real
result, not a bug: MultinomialNB is weak enough here that averaging it in drags
the vote down. A weight sweep on the same split does better — `(1, 6, 3)`
reaches 0.4933 / 0.5055 — but the weights are fitted on the same data they are
reported on, so they are not quoted as a headline. Equal weights are shipped
because they are the ones you can defend without a nested split.

### Why the number is what it is

1. **21 fine-grained classes, 70–283 examples each.** This is not a
   classification problem with a big dataset behind it. Longest class
   (`Air Quality`, 283) is smaller than the 2,326-publication corpus by an order
   of magnitude, and smallest (`Water Quality`, 70) is well inside the range
   where macro-F1 swings several points on a rerun.
2. **The labels are not ours.** The 21 names are NASA GES DISC research areas.
   NCPOR's seeded taxonomy is six different disciplines (`Glaciology`,
   `Cryospheric Science`, `Oceanography`, `Atmospheric Science`, `Marine
   Biology`, `Remote Sensing`). Nothing maps 21 NASA classes onto 6 NCPOR
   disciplines without a hand-built mapping table, and inventing that table here
   would have hidden the real problem behind a flattering score.
   `ClassificationLog.predictedTags` is a `String[]`, so the model can record its
   own vocabulary today without a schema change — and that string array is
   exactly where the mapping belongs once a human has made the call.
3. **Bag-of-words on abstracts, not documents.** TF-IDF over 1–2grams cannot see
   the quantities, units and time series that distinguish, say, air quality from
   water quality. Short inputs are the worst case: a 35-character krill sentence
   has no features to work with, and the UI must not surface a confident tag for
   a stub upload.

### What would actually improve it

In rough order of expected return, with nothing downstream needing to change —
the model is a versioned artifact behind an HTTP contract, which is precisely
what makes a corpus swap cheap:

1. **NCPOR's own corpus.** Report abstracts and dataset descriptions labelled by
   an NCPOR scientist. Even a few hundred in-domain examples would beat 2,326
   out-of-domain ones. `npm run ml:train` already accepts a directory of them;
   the pipeline is the only thing that has to be pointed at it.
2. **Coarse-then-fine two-stage tagging.** Predict the 6 NCPOR disciplines
   first, then the NASA class within it. Most of the confusion is between
   adjacent environmental classes that a hierarchical prior would resolve.
3. **Embeddings.** Sentence embeddings from a scientific-domain encoder
   (SPECTER2, for example) instead of TF-IDF, which would let
   `Atmospheric/Ocean Indicators` and `Air Quality` separate on meaning rather
   than shared vocabulary.
4. **Calibration.** Probabilities are currently softmaxed decision scores,
   comparable between documents but not calibrated; see below.

`ml/models/metrics.json` carries the full confusion matrix, per-label scores and
the exact corpus provenance. It is committed on purpose: the number is the
deliverable, and it should be reviewable in a diff — including when it is bad.

### Confidence scores are not probabilities

The ensemble's probabilities are the average of three models' softmax outputs,
which is *more* interpretable than a single linear model's decision margins but
still not calibrated posteriors. They are comparable between documents — that is
all. Do not render them as percentages, and do not treat a 0.62 as "62% sure".
If calibration matters, fit an `IsotonicRegression` on a held-out set; that is a
Phase 7 decision, not a Phase 2 one.

### Degradation is a first-class path

Section 6 requires that a failing ML call never fails the surrounding upload.
`src/lib/ml.ts` returns a discriminated result and **never throws**:

| Condition | Behaviour |
| --- | --- |
| Success | `{ok: true, result, attempts}` |
| `503` (no artifact) | `ok: false`, `model_not_loaded`, **not retried** — a missing model will not appear 250ms later |
| `500` / `429` / network / timeout | retried once after 250ms backoff, then `ok: false` |
| `422` | `invalid_input`, not retried — a malformed payload stays malformed |
| Malformed `200` | `ok: false`, `malformed_response` — confidence is range- and NaN-checked |
| No service | `ok: false`, `network` in ~1ms, not a 30s hang |

The caller stores the record with `taggingPending` and a human tags it later.
`GET /api/ml/health` exposes the same degradation to operators, returning `503`
with a readable reason rather than a `500`.

### Running it

```bash
npm run bootstrap          # venv, pinned deps, corpus, train, register, test
npm run ml:serve           # http://127.0.0.1:8000

# or, all of it in containers (see the note on the model artifact below)
npm run bootstrap && docker compose up -d
```

`npm run bootstrap` is idempotent — re-running it reuses the downloaded corpus
and retrains in about a minute.

> **Docker:** `ml/Dockerfile` copies `ml/models/` in, so run `npm run bootstrap`
> *before* `docker compose build`. The joblib artifact is gitignored on purpose
> (it is a deterministic function of the corpus and the pinned scikit-learn
> version) which is why the compose file health-gates the app on `ml-service`.

### Two integration seams, both tested

`tsc` and `next build` pass with no Python and no ML service running, so neither
proves the two services agree. Two suites cover the gap:

```bash
npm run ml:test            # 49 tests: response shapes, validation, real artifact, bandit
npm run test:ml-client     # 15 tests: retry, timeout, malformed response, degradation
npm run smoke:ml           # 13 checks across the real HTTP boundary
npm run ml:types           # regenerate openapi.json + ml-openapi.d.ts
```

`ml:test` runs 49 Python tests and `test:ml-client` runs 15, but the counts above
are the totals on the current tree — the useful signal is that `verify:all` exits
non-zero, not the numbers, which change as coverage grows.

`smoke:ml` deliberately runs **two** passes — ML up, then ML pointed at a dead
port — because the degradation path is the half that works in development and
fails in production. A test that only ever runs the first pass is testing the
happy path and calling it coverage.

## Publish bandit (Section 6)

The classifier decides what a document is about. The bandit decides **where and
when to put it** — 3 channels × 3 time slots = 9 arms, each a
`Beta(alpha, beta)` posterior seeded at `Beta(1, 1)`.

| Call | Reads | Writes |
| --- | --- | --- |
| `GET /recommend` | every `BanditArmState` row on every call | nothing |
| `POST /feedback` | state before updating | one `EngagementEvent` + one arm's posterior, in **one transaction** |

State lives in Postgres (`BanditArmState`), not in process memory, so a
restart, a second instance or a horizontal scale does not reset what was learned
and there is exactly one source of truth.

### Why the reward is fractional

Feedback is `{impressions, clicks}`, not a binary success. An arm that served
10,000 impressions and got 300 clicks is more informative than one that got 0
clicks out of 10 impressions, and collapsing both to 0/1 would throw away the
signal. So the posterior takes one Bernoulli conjugate step per *observation*:

```
reward = clicks / impressions
alpha += reward
beta  += 1 - reward
```

`alpha + beta` grows by exactly 1 per call, which is what makes
`alpha / (alpha + beta)` converge on the true click-through rate as pulls
accumulate — the `Beta(1, 1)` prior's pseudo-counts get diluted rather than
reinforced.

Selection is Thompson sampling: draw `Beta(alpha, beta)` per arm and take the
argmax. It is the one algorithm that needs no hyperparameter tuning, explores
automatically while it is uncertain, and — given a seeded `X-Request-ID` —
returns the same arm twice for the same request, so an operator reloading the
page does not silently consume nine arms' worth of exploration budget.

### Learning curve, measured against a live database

`ml/scripts/simulate_engagement.py` drives the real HTTP endpoints with
synthetic feedback marked `isSimulated: true`, so it can never contaminate
production posteriors. Over 900 cycles against Postgres:

| Measure | Result |
| --- | --- |
| Mean reward, first third | 0.0902 |
| Mean reward, last third | 0.1308 |
| Improvement | **+0.0406** |
| Best two arms' share of pulls | 69.1% (uniform would be 22.2%) |
| Feedback rows lost | 0 |

All 901 rows landed (`EngagementEvent.isSimulated = true` throughout), which is
the point of running it against the real database rather than a mock: the
transaction that writes the event and updates the posterior is the thing being
tested, and a mock cannot disagree with itself.

```bash
npm run ml:serve
npm run ml:simulate -- --draft-id <real OutreachDraft.id> --steps 900
```

### Writes are not retried

`classify` retries once on 5xx, because a failed classification is a degraded
upload and cheap to repeat. **`/feedback` never retries.** A retried POST is a
second `EngagementEvent` row and a second `alpha += reward` — a double-count
that is invisible in the posterior and permanently skews every later choice for
that arm. One attempt, reported honestly as recorded or not.

---

## Verification

```bash
npm run verify
# typecheck → lint → build → smoke test
```

The smoke test is the one that matters. `tsc` and `next build` both pass on a
machine with **no database at all**, so neither proves the wiring works. The
smoke test boots the production build against a live database and asserts the
app serves pages, reads live rows, and reports dependency health:

```bash
node scripts/with-db.mjs -- npm run verify:all
# 15 passed (ml-client) · 20 passed (pytest) · all checks passed (smoke)
```

`verify:all` is the self-contained gate: it migrates, seeds, runs both service
suites, regenerates the OpenAPI types, then runs `typecheck → lint → build →
smoke`. The seeding step is not incidental — the smoke test asserts that the
home page's expedition counter matches what the database actually holds, so
without it the run is testing whatever happened to be in `.pglite`.

`npm run ml:types` runs inside the gate, which turns a changed FastAPI schema
into a diff in `src/lib/ml-openapi.d.ts` rather than a type error three files
away. The constraint suite is separate because it needs a writable database:

```bash
node scripts/with-db.mjs -- npm run db:verify-constraints
# 20 passed, 0 failed
```

Pages that read live data call `await connection()` (from `next/server`) before
querying. Without it Next tries to prerender at build time and fails with
`P1001` — including inside the Dockerfile, where the image is built before the
`db` service is necessarily accepting connections. It also matches the intended
Phase 3 layout: a static hero shell with live counters streaming in.

### Known dependency advisories

`npm audit` reports 8 advisories. All are transitive dependencies of the
`prisma` CLI and the `minio` client, all at their latest published versions,
and `npm audit fix --force` resolves every one of them by **downgrading a major
version** — `prisma` 7 → 6, `minio` 8 → 7. That trade was declined:
`mysql2`, `stream-json` and `deepmerge-ts` are build-time CLI dependencies that
do not ship in the application bundle, and pinning older majors of the ORM to
clear a scanner is not a real security improvement. Revisit when `prisma` 8
and a patched `minio` 9 ship.

---

## Configuration

All configuration is validated in one place, `src/lib/env.ts`, which fails on
first use with a readable list of what is missing rather than letting `undefined`
surface three layers deep in a query. See `.env.example` for the annotated set.

`ANTHROPIC_API_KEY` is optional: without it the app runs normally and the
"Generate outreach draft" affordance is hidden. `GET /api/health` reports
`aiConfigured: false` rather than failing.

`ML_SERVICE_URL` and `ML_TIMEOUT_MS` are also optional, and default to
`http://localhost:8000` and `5000`. **A missing ML service is not a
misconfiguration** — the app is designed to keep working without it, with
automatic tagging. `GET /api/ml/health` reports the degradation.

---

## Deployment

`docker compose --profile app up --build` runs the whole stack. For a cloud VM,
the path is the same image plus managed Postgres and S3:

1. Build and push the image from `Dockerfile` (standalone output, non-root).
2. Point `DATABASE_URL` at the managed instance and run
   `npx prisma migrate deploy` as a release step — never `migrate dev` in prod.
3. Set `S3_ENDPOINT`/`S3_PUBLIC_URL` to the bucket, `S3_FORCE_PATH_STYLE=false`
   for AWS S3, and a real `AUTH_SECRET` (`openssl rand -base64 32`).
4. Terminate TLS in front of the app and set `AUTH_TRUST_HOST=true`.
5. Deploy `ml/Dockerfile` alongside it, set `ML_SERVICE_URL` to its address, and
   run `npm run ml:download && npm run ml:train` as a release step when the
   corpus changes — the model is versioned in `MLModelVersion`, and a retrain is
   a row insert, not a code deploy. The app is deliberately not blocked on this:
   if the service is unreachable, uploads still succeed and land in the
   tagging-pending queue, and `/api/ml/recommend` returns `503` rather than
   inventing an arm.

**Hosting the ML service on a platform that builds from source** (Render, for
example) can train inside the image build, so a cold deploy comes up already
trained without a separate release step:

```
Build command:  pip install -r requirements.txt \
                && python scripts/download_dataset.py \
                && python scripts/train_ensemble.py
Start command:  uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

That is a *build-time* step. `/classify` never trains, and `/recommend` never
trains — inference is a vectorizer transform and a `predict_proba`. The
trade-off is that every build re-downloads a 4.5 MB corpus and refits for ~25
seconds, which is cheap here and would not be for a much larger model.

Render, Railway or Fly all work with no code changes. CI is intentionally
thin — `npm run verify:all` is the whole gate.

---

## Build phases

| # | Phase | Status |
| --- | --- | --- |
| 1 | Scaffold: repo, schema, Docker Compose, seed | **done** |
| 2 | ML service: trained classifier, FastAPI, Node client | **done** |
| 3 | Design system: tokens, primitives, header, footer, theme toggle | next |
| 4 | Public outreach mode: landing, expedition map, detail pages, stories, search | |
| 5 | Researcher/data mode: data explorer, downloads, citation export | |
| 6 | Admin/CMS + auth: role-gated dashboard, upload forms, review queue | |
| 7 | AI content pipeline: Claude generation, approval workflow | |
| 8 | Accessibility + i18n: audit, Hindi strings, contrast, keyboard | |
| 9 | Polish + README: live counters, visual QA | |

---

## Licence & data

Code in this repository is sample scaffolding written for SIH 2026.

**All seeded content is fictional.** Expedition titles, scientist names,
institutions, DOIs and every figure in the seed were written to exercise the
schema. They do not describe real voyages, real measurements or real people,
and the `10.5281/indopolaris.*` DOIs are placeholders that do not resolve. Any
resemblance to actual NCPOR programmes is coincidental. Replace
`prisma/seed.ts` with real data before this goes anywhere near a public
deployment.

**The Phase 2 classifier is trained on third-party text.** `ml/data/` is a
downloaded copy of the NASA GES DISC
[`es-publications-researchareas`](https://huggingface.co/datasets/nasa-gesdisc/es-publications-researchareas)
dataset: abstracts of published Earth-science papers, fetched from the
Hugging Face mirror of NASA's archive. It is a research dataset of *published*
work rather than discussion-group posts written without consent, but it is
still someone else's corpus under someone else's terms, so it is handled the
same way: gitignored, downloaded on demand by `npm run ml:download`, never
redistributed here, and `ml/models/` contains only model weights and aggregate
metrics.

Two things that dataset is **not**: it is not polar science (Earth science
broadly, with 114 `Cryospheric Indicators` examples as the nearest class), and
its 21 labels are not NCPOR's 6 disciplines. The classifier therefore ships
predicting NASA research-area names and writing them into
`ClassificationLog.predictedTags`. The mapping to NCPOR's taxonomy is a
human decision that has not been made yet — see
[Training corpus and honest numbers](#training-corpus-and-honest-numbers) for
what it would take.
