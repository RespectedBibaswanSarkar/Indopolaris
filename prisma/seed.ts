/**
 * Seed data for IndoPolaris.
 *
 * Idempotent: truncates every table first, so `npm run db:seed` can be re-run
 * freely. All names, DOIs and figures below are FICTIONAL sample data written
 * to exercise the schema, the search vectors and the constraint checks. They do
 * not describe real voyages, real measurements or real people.
 *
 * Note on `altText`: every MediaAsset row carries genuine descriptive alt text,
 * because Section 6 makes it a required field and the seed is the first thing a
 * reviewer will look at. If a row here reads "TODO" or "image.jpg", the
 * accessibility story is already broken before the CMS is even built.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";

import {
  DatasetFormat,
  MediaType,
  OutreachSourceType,
  OutreachStatus,
  Prisma,
  PrismaClient,
  Region,
  ReportStatus,
  TagCategory,
  UserRole,
} from "../src/generated/prisma/client";

const adapter = new PrismaPg({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://indopolaris:indopolaris_dev_pw@127.0.0.1:5432/indopolaris?schema=public",
});
const prisma = new PrismaClient({ adapter });

const MEDIA = "/media/seed";

// ---------------------------------------------------------------------------
// Wipe
// ---------------------------------------------------------------------------

async function reset() {
  // TRUNCATE ... CASCADE in one statement: order-independent and much faster
  // than deleting row by row. _prisma_migrations is deliberately left alone so
  // the migration history survives a reseed.
  //
  // The ML/RL tables are named explicitly rather than left to cascade, because
  // cascade gets this wrong in a way that is invisible until the numbers are
  // read. Truncating "OutreachDraft" cascades to "EngagementEvent" (the FK is
  // ON DELETE CASCADE), but "BanditArmState" has no FK to drafts and so
  // survives — leaving posteriors claiming hundreds of pulls whose supporting
  // rows no longer exist. Section 6 requires synthetic feedback to stay
  // permanently separable from real analytics, which is only true while the
  // posteriors can still be audited against the events that produced them.
  // Same reasoning for "ClassificationLog": polymorphic, no FK, so it would
  // otherwise retain inference records for rows this truncate just deleted.
  //
  // "MLModelVersion" is deliberately NOT truncated. It describes a model
  // artifact on disk that this reseed does not remove, and the admin dashboard
  // reads the accuracy/F1 it reports.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "OutreachDraft", "Report", "Dataset", "Publication", "MediaAsset",
      "Expedition", "Tag", "User",
      "EngagementEvent", "BanditArmState", "ClassificationLog"
    RESTART IDENTITY CASCADE;
  `);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const DEMO_PASSWORD = "indopolaris2026";

async function seedUsers() {
  // One bcrypt round-set shared by all demo accounts. 10 rounds is bcrypt's
  // default cost; hashing is deliberately slow, so we hash once and reuse.
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const rows = [
    {
      name: "Dr. Meera Raghavan",
      email: "admin@indopolaris.gov.in",
      role: UserRole.admin,
      institution: "National Centre for Polar and Ocean Research",
    },
    {
      name: "Ananya Kulkarni",
      email: "editor@indopolaris.gov.in",
      role: UserRole.editor,
      institution: "National Centre for Polar and Ocean Research",
    },
    {
      name: "Dr. Anil Deshmukh",
      email: "deshmukh@indopolaris.gov.in",
      role: UserRole.contributor,
      institution: "National Centre for Polar and Ocean Research",
    },
    {
      name: "Dr. Kavya Iyer",
      email: "iyer@indopolaris.gov.in",
      role: UserRole.contributor,
      institution: "Indian Institute of Information Technology, Manipur",
    },
    {
      name: "Dr. Rohan Bhattacharya",
      email: "bhattacharya@indopolaris.gov.in",
      role: UserRole.contributor,
      institution: "Indian Institute of Technology Bombay",
    },
  ];

  const users = await Promise.all(
    rows.map((r) => prisma.user.create({ data: { ...r, passwordHash } })),
  );

  const byEmail = Object.fromEntries(users.map((u) => [u.email, u]));
  return {
    admin: byEmail["admin@indopolaris.gov.in"],
    editor: byEmail["editor@indopolaris.gov.in"],
    deshmukh: byEmail["deshmukh@indopolaris.gov.in"],
    iyer: byEmail["iyer@indopolaris.gov.in"],
    bhattacharya: byEmail["bhattacharya@indopolaris.gov.in"],
  };
}

// ---------------------------------------------------------------------------
// Tags — the faceted-search vocabulary
// ---------------------------------------------------------------------------

function slugify(label: string) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function seedTags() {
  const disciplines = [
    "Glaciology",
    "Cryospheric Science",
    "Oceanography",
    "Atmospheric Science",
    "Marine Biology",
    "Remote Sensing",
  ];
  const instruments = [
    "CTD Rosette",
    "Automatic Weather Station",
    "Ice Corer",
    "Ice-Penetrating Radar",
    "Mooring Buoy",
    "Satellite Sensor",
  ];
  const regions = ["Antarctica", "Arctic", "Himalaya", "Southern Ocean"];

  const all = await Promise.all(
    ([
      [disciplines, TagCategory.discipline],
      [instruments, TagCategory.instrument],
      [regions, TagCategory.region],
    ] as const).flatMap(([labels, category]) =>
      labels.map((label) =>
        prisma.tag.create({ data: { label, slug: slugify(label), category } }),
      ),
    ),
  );

  const pick = (label: string) => {
    const t = all.find((x) => x.label === label);
    if (!t) throw new Error(`seed bug: no tag "${label}"`);
    return t;
  };

  return {
    glaciology: pick("Glaciology"),
    cryosphere: pick("Cryospheric Science"),
    oceanography: pick("Oceanography"),
    atmosphere: pick("Atmospheric Science"),
    biology: pick("Marine Biology"),
    remoteSensing: pick("Remote Sensing"),
    ctd: pick("CTD Rosette"),
    aws: pick("Automatic Weather Station"),
    iceCorer: pick("Ice Corer"),
    ipr: pick("Ice-Penetrating Radar"),
    buoy: pick("Mooring Buoy"),
    satellite: pick("Satellite Sensor"),
    tagAntarctica: pick("Antarctica"),
    tagArctic: pick("Arctic"),
    tagHimalaya: pick("Himalaya"),
    tagSouthern: pick("Southern Ocean"),
  };
}

// ---------------------------------------------------------------------------
// Expeditions — the narrative spine
// ---------------------------------------------------------------------------

async function seedExpeditions(u: Awaited<ReturnType<typeof seedUsers>>, t: Awaited<ReturnType<typeof seedTags>>) {
  // Media has to exist before expeditions, because Expedition.heroImageId
  // points at it.
  const media = await seedMedia(u);

  const specs = [
    {
      slug: "ise-42-antarctica",
      title: "42nd Indian Scientific Expedition to Antarctica",
      region: Region.Antarctica,
      startDate: new Date("2024-11-18"),
      endDate: new Date("2025-03-12"),
      leadScientist: "Dr. Meera Raghavan",
      station: "Bharati, Maitri-Bharti, Antarctica",
      summary:
        "A 116-day voyage from Chennai to the continental interior, studying how the East Antarctic ice sheet responds to a warming Southern Ocean. The team drilled ice cores at Maitri-Bharti, deployed an automatic weather station on a remote nunatak, and ran a coastal biodiversity transect through the sea-ice break-up season.",
      latitude: -69.3497,
      longitude: 76.1617,
      vessel: "RV Nalasakthi (chartered)",
      isFeatured: true,
      regionTag: t.tagAntarctica,
      heroKey: "antarctica-hero",
    },
    {
      slug: "southern-ocean-carbon-export",
      title: "Southern Ocean Carbon Export Expedition",
      region: Region.SouthernOcean,
      startDate: new Date("2024-01-09"),
      endDate: new Date("2024-03-02"),
      leadScientist: "Dr. Kavya Iyer",
      station: "RV Sindhuvadhi, stations SOV-01 to SOV-12",
      summary:
        "Fifty-three days at sea chasing the biological carbon pump across the Antarctic Polar Frontal Zone. Repeated CTD casts measured how much carbon sinks beneath the winter mixing layer, and drifting floats tracked that sink for eighteen months after the ship returned.",
      latitude: -54.5,
      longitude: 0.05,
      vessel: "RV Sindhuvadhi",
      isFeatured: true,
      regionTag: t.tagSouthern,
      heroKey: "southern-hero",
    },
    {
      slug: "dakshin-gangotri-mass-balance",
      title: "Dakshin Gangotri Glacier Mass Balance Monitoring",
      region: Region.Himalaya,
      startDate: new Date("2019-06-14"),
      endDate: new Date("2024-09-30"),
      leadScientist: "Dr. Anil Deshmukh",
      station: "Dakshin Gangotri Glacier, Third W Mountain, Sikkim",
      summary:
        "Five consecutive summer campaigns measuring how the third-highest glacier in the world is thinning. Ice-penetrating radar mapped the bed, stake networks tracked surface lowering, and automatic weather stations recorded the accumulation that feeds it. The lower ablation zone has lost roughly eleven metres of thickness since 2019.",
      latitude: 32.1722,
      longitude: 77.9908,
      vessel: null,
      isFeatured: true,
      regionTag: t.tagHimalaya,
      heroKey: "himalaya-hero",
    },
    {
      slug: "arctic-sea-ice-dynamics",
      title: "Arctic Sea-Ice Dynamics Campaign",
      region: Region.Arctic,
      startDate: new Date("2024-02-20"),
      endDate: new Date("2024-09-28"),
      leadScientist: "Dr. Rohan Bhattacharya",
      station: "Ny-Alesund, Svalbard; Kongsfjorden mooring",
      summary:
        "A year-round Arctic observing effort combining moored instruments, satellite retrievals and ship-based surveys. The team tracked how sea-ice age and concentration in Kongsfjorden responded to an unusually warm winter, and used ice-penetrating radar to measure thickness in areas where satellite retrievals are least reliable.",
      latitude: 78.9236,
      longitude: 11.9298,
      vessel: "R/V Lance (chartered)",
      isFeatured: false,
      regionTag: t.tagArctic,
      heroKey: "arctic-hero",
    },
  ] as const;

  // Route polylines (GeoJSON LineString, [lng, lat]) for the map view.
  const routes: Record<string, unknown> = {
    "ise-42-antarctica": {
      type: "LineString",
      coordinates: [
        [80.2707, 13.0827], // Chennai
        [57.5, 20.0],
        [115.7419, -32.0569], // Fremantle
        [62.6117, -57.6167], // Mawson
        [77.8556, -68.5833], // Davis
        [76.1617, -69.3497], // Bharati
      ],
    },
    "southern-ocean-carbon-export": {
      type: "LineString",
      coordinates: [
        [72.8777, 18.9388], // Goa
        [55.0, -25.0],
        [20.0, -45.0],
        [-5.0, -52.5],
        [0.05, -54.5],
      ],
    },
    "arctic-sea-ice-dynamics": {
      type: "LineString",
      coordinates: [
        [10.4, 63.4], // Trondheim
        [17.9, 69.6],
        [11.9298, 78.9236], // Ny-Alesund
      ],
    },
  };

  const expeditions = [];
  for (const s of specs) {
    const hero = media.byKey[s.heroKey];
    const row = await prisma.expedition.create({
      data: {
        slug: s.slug,
        title: s.title,
        region: s.region,
        startDate: s.startDate,
        endDate: s.endDate,
        leadScientist: s.leadScientist,
        station: s.station,
        summary: s.summary,
        latitude: s.latitude,
        longitude: s.longitude,
        // A nullable Json column cannot be set to JS `null` — Prisma needs the
        // explicit DbNull sentinel to mean SQL NULL.
        route: (routes[s.slug] as Prisma.InputJsonValue | undefined) ?? Prisma.DbNull,
        vessel: s.vessel,
        isFeatured: s.isFeatured,
        heroImageId: hero.id,
        regionTags: { connect: [{ id: s.regionTag.id }] },
      },
    });
    expeditions.push(row);
  }

  return { expeditions, media, bySlug: Object.fromEntries(expeditions.map((e) => [e.slug, e])) };
}

type Media = Awaited<ReturnType<typeof seedMedia>>;

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

async function seedMedia(u: Awaited<ReturnType<typeof seedUsers>>) {
  // `expeditionSlug` is resolved later; media rows are created without an
  // expeditionId because Expedition needs the hero image first (circular FK).
  // The second pass in seedContent() links the rest.
  const specs = [
    {
      key: "antarctica-hero",
      expeditionSlug: "ise-42-antarctica",
      file: "antarctica-hero.svg",
      type: MediaType.photo,
      caption: "Bharati research station on the East Antarctic ice sheet.",
      altText:
        "Bharati research station, a cluster of blue and orange containers on a flat white ice plain, with a flagged approach track running towards the horizon.",
      credit: "Photo: IndoPolaris sample archive / NCPOR",
      capturedAt: new Date("2024-12-14"),
      uploadedById: u.deshmukh.id,
    },
    {
      key: "antarctica-ice-shelf",
      expeditionSlug: "ise-42-antarctica",
      file: "antarctica-ice-shelf.svg",
      type: MediaType.photo,
      caption: "Crevasse field on the coastal ice shelf.",
      altText:
        "A field of blue-white pressure ridges and crevasses cut across a flat ice shelf, photographed in low polar sunlight.",
      credit: "Photo: IndoPolaris sample archive / NCPOR",
      capturedAt: new Date("2025-01-08"),
      uploadedById: u.deshmukh.id,
    },
    {
      key: "antarctica-aerial",
      expeditionSlug: "ise-42-antarctica",
      file: "antarctica-aerial.svg",
      type: MediaType.photo,
      caption: "Aerial survey line over the Ronne ice shelf.",
      altText:
        "An aerial view looking down on a broken ice shelf, with parallel survey lines visible as faint tracks across the snow.",
      credit: "Photo: IndoPolaris sample archive / NCPOR",
      capturedAt: new Date("2025-01-22"),
      uploadedById: u.bhattacharya.id,
    },
    {
      key: "southern-hero",
      expeditionSlug: "southern-ocean-carbon-export",
      file: "southern-hero.svg",
      type: MediaType.photo,
      caption: "Research vessel RV Sindhuvadhi on station in the Southern Ocean.",
      altText:
        "A mid-sized research vessel seen from the air on a calm grey sea, with a white wake curving away behind it.",
      credit: "Photo: IndoPolaris sample archive / NCPOR",
      capturedAt: new Date("2024-02-04"),
      uploadedById: u.iyer.id,
    },
    {
      key: "southern-ctd",
      expeditionSlug: "southern-ocean-carbon-export",
      file: "southern-ctd.svg",
      type: MediaType.photo,
      caption: "CTD rosette on the aft deck, ready for deployment.",
      altText:
        "A circular frame of grey water-sample bottles mounted on a winch on a ship's deck, with two crew in orange foul-weather gear standing beside it.",
      credit: "Photo: IndoPolaris sample archive / NCPOR",
      capturedAt: new Date("2024-01-27"),
      uploadedById: u.iyer.id,
    },
    {
      key: "southern-waves",
      expeditionSlug: "southern-ocean-carbon-export",
      file: "southern-waves.svg",
      type: MediaType.photo,
      caption: "Wave conditions during a Southern Ocean gale.",
      altText:
        "Dark, steep wave crests under a heavy grey sky, photographed from the ship's rail in rough conditions.",
      credit: "Photo: IndoPolaris sample archive / NCPOR",
      capturedAt: new Date("2024-02-19"),
      uploadedById: u.iyer.id,
    },
    {
      key: "himalaya-hero",
      expeditionSlug: "dakshin-gangotri-mass-balance",
      file: "himalaya-hero.svg",
      type: MediaType.photo,
      caption: "Dakshin Gangotri Glacier from the lower ablation zone.",
      altText:
        "A wide, pale blue glacier flowing between dark rocky ridges, with a line of survey stakes running up its centre.",
      credit: "Photo: IndoPolaris sample archive / NCPOR",
      capturedAt: new Date("2024-08-12"),
      uploadedById: u.deshmukh.id,
    },
    {
      key: "himalaya-moraine",
      expeditionSlug: "dakshin-gangotri-mass-balance",
      file: "himalaya-moraine.svg",
      type: MediaType.photo,
      caption: "Moraine ridge above the glacier terminus.",
      altText:
        "A sharp crest of loose grey rock debris rising above a glacier, with hazy mountain ridges behind it.",
      credit: "Photo: IndoPolaris sample archive / NCPOR",
      capturedAt: new Date("2024-08-15"),
      uploadedById: u.deshmukh.id,
    },
    {
      key: "himalaya-camp",
      expeditionSlug: "dakshin-gangotri-mass-balance",
      file: "himalaya-camp.svg",
      type: MediaType.photo,
      caption: "Automatic weather station on the upper glacier.",
      altText:
        "A tripod weather station with a small solar panel and a white radiation shield, standing alone on a wide snowfield.",
      credit: "Photo: IndoPolaris sample archive / NCPOR",
      capturedAt: new Date("2024-08-20"),
      uploadedById: u.deshmukh.id,
    },
    {
      key: "arctic-hero",
      expeditionSlug: "arctic-sea-ice-dynamics",
      file: "arctic-hero.svg",
      type: MediaType.photo,
      caption: "Ny-Alesund research station, Svalbard.",
      altText:
        "A row of low research buildings with red and blue facades on a snow-covered shoreline, backed by dark mountains.",
      credit: "Photo: IndoPolaris sample archive / NCPOR",
      capturedAt: new Date("2024-03-02"),
      uploadedById: u.bhattacharya.id,
    },
    {
      key: "arctic-sea-ice",
      expeditionSlug: "arctic-sea-ice-dynamics",
      file: "arctic-sea-ice.svg",
      type: MediaType.photo,
      caption: "Sea-ice floe mosaic in the Arctic Ocean.",
      altText:
        "Packed sea ice made up of flat white floes of many sizes, separated by narrow dark leads of open water.",
      credit: "Photo: IndoPolaris sample archive / NCPOR",
      capturedAt: new Date("2024-04-11"),
      uploadedById: u.bhattacharya.id,
    },
    {
      key: "arctic-sky",
      expeditionSlug: "arctic-sea-ice-dynamics",
      file: "arctic-sky.svg",
      type: MediaType.photo,
      caption: "Polar night over Kongsfjorden.",
      altText:
        "Faint green aurora ribbons arching across a dark sky above a still, snow-covered fjord.",
      credit: "Photo: IndoPolaris sample archive / NCPOR",
      capturedAt: new Date("2024-12-21"),
      uploadedById: u.bhattacharya.id,
    },
    {
      key: "doc-glacier-report",
      expeditionSlug: null,
      file: "report-glacier-mass-balance.svg",
      type: MediaType.photo,
      caption: "Cover — Dakshin Gangotri mass balance report.",
      altText: "Report cover titled 'Glacier Mass Balance Report' on a dark blue gradient.",
      credit: "IndoPolaris sample archive",
      capturedAt: null,
      uploadedById: u.deshmukh.id,
    },
    {
      key: "doc-antarctic-biodiversity",
      expeditionSlug: null,
      file: "report-antarctic-biodiversity.svg",
      type: MediaType.photo,
      caption: "Cover — Antarctic coastal biodiversity report.",
      altText: "Report cover titled 'Antarctic Biodiversity Report' on a dark blue gradient.",
      credit: "IndoPolaris sample archive",
      capturedAt: null,
      uploadedById: u.deshmukh.id,
    },
    {
      key: "doc-ctd-dataset",
      expeditionSlug: null,
      file: "dataset-ctd-profiles.svg",
      type: MediaType.photo,
      caption: "Cover — CTD cast profiles dataset.",
      altText: "Dataset cover titled 'CTD Cast Profiles' on a dark blue gradient.",
      credit: "IndoPolaris sample archive",
      capturedAt: null,
      uploadedById: u.iyer.id,
    },
    {
      key: "doc-pub-early-careers",
      expeditionSlug: null,
      file: "pub-antarctic-early-careers.svg",
      type: MediaType.photo,
      caption: "Cover — Early Career Researchers at the Poles.",
      altText: "Publication cover titled 'Early Career Researchers at the Poles' on a dark blue gradient.",
      credit: "IndoPolaris sample archive",
      capturedAt: null,
      uploadedById: u.editor.id,
    },
  ];

  const rows = await Promise.all(
    specs.map((s) =>
      prisma.mediaAsset.create({
        data: {
          expeditionId: null, // linked in the second pass
          type: s.type,
          url: `${MEDIA}/${s.file}`,
          thumbnailUrl: `${MEDIA}/${s.file}`,
          storageKey: `seed/${s.file}`,
          caption: s.caption,
          altText: s.altText,
          credit: s.credit,
          capturedAt: s.capturedAt,
          uploadedById: s.uploadedById,
        },
      }),
    ),
  );

  const byKey = Object.fromEntries(
    specs.map((s, i) => [s.key, rows[i]]),
  ) as Record<string, (typeof rows)[number]>;

  return { rows, byKey, specs };
}

async function linkMediaToExpeditions(
  media: Media,
  expeditions: { id: string; slug: string; heroImageId: string | null }[],
) {
  const expBySlug = Object.fromEntries(expeditions.map((e) => [e.slug, e]));
  for (const s of media.specs) {
    if (!s.expeditionSlug) continue;
    const exp = expBySlug[s.expeditionSlug];
    if (!exp) continue;
    // Skip hero images: they are already related via Expedition.heroImageId,
    // and setting expeditionId too would double-count them in the gallery.
    if (exp.heroImageId === media.byKey[s.key].id) continue;
    await prisma.mediaAsset.update({
      where: { id: media.byKey[s.key].id },
      data: { expeditionId: exp.id },
    });
  }
}

// ---------------------------------------------------------------------------
// Reports, datasets, publications
// ---------------------------------------------------------------------------

async function seedContent(
  u: Awaited<ReturnType<typeof seedUsers>>,
  t: Awaited<ReturnType<typeof seedTags>>,
  ex: Awaited<ReturnType<typeof seedExpeditions>>,
) {
  const E = ex.bySlug;

  // --- Reports -------------------------------------------------------------
  const reports = await Promise.all([
    prisma.report.create({
      data: {
        expeditionId: E["ise-42-antarctica"].id,
        title: "Sea-ice break-up timing and coastal productivity, East Antarctica",
        fileUrl: `${MEDIA}/report-antarctic-biodiversity.svg`,
        fileType: "application/pdf",
        abstract:
          "We present a 116-day record of sea-ice retreat along the East Antarctic coast, sampled at eleven transects between 69°S and 70°S. Chlorophyll-a concentrations tracked the retreat edge with a lag of roughly eleven days, and the timing of the spring bloom in the Southern Ocean strongly influences how much carbon the region exports to depth. Early retreat in December was associated with a bloom that began 26 days ahead of the 1998–2018 median and reached 1.9 times the median peak biomass.",
        status: ReportStatus.published,
        uploadedById: u.deshmukh.id,
        disciplineTags: { connect: [{ id: t.biology.id }, { id: t.oceanography.id }] },
      },
    }),
    prisma.report.create({
      data: {
        expeditionId: E["dakshin-gangotri-mass-balance"].id,
        title: "Five-year surface mass balance of Dakshin Gangotri Glacier",
        fileUrl: `${MEDIA}/report-glacier-mass-balance.svg`,
        fileType: "application/pdf",
        abstract:
          "Stake-network and automatic-weather-station measurements from 2019 to 2024 show the lower ablation zone losing 11.3 ± 0.9 m of thickness, the steepest rate observed at this glacier in any published record. Accumulation above 5,400 m was stable to within measurement error, indicating that the loss is driven by increasing melt rather than by changing snowfall. Ice-penetrating radar surveys show the bed has retreated by an average of 180 m over the survey period.",
        status: ReportStatus.published,
        uploadedById: u.deshmukh.id,
        disciplineTags: { connect: [{ id: t.glaciology.id }, { id: t.cryosphere.id }] },
      },
    }),
    prisma.report.create({
      data: {
        expeditionId: E["arctic-sea-ice-dynamics"].id,
        title: "Mooring observations of Kongsfjorden sea-ice and water column structure",
        fileUrl: `${MEDIA}/report-glacier-mass-balance.svg`,
        fileType: "application/pdf",
        abstract:
          "Twelve months of moored temperature, salinity and current data from Kongsfjorden, paired with weekly ice thickness transects. Warm Atlantic Water intrusion into the fjord peaked in March 2024 at 3.4 °C, the warmest in the 1998–2024 record for this site, and coincided with the earliest observed melt-out of shorefast ice.",
        status: ReportStatus.review,
        uploadedById: u.bhattacharya.id,
        disciplineTags: { connect: [{ id: t.oceanography.id }, { id: t.atmosphere.id }] },
      },
    }),
    prisma.report.create({
      data: {
        expeditionId: E["southern-ocean-carbon-export"].id,
        title: "Carbon export beneath the Southern Ocean winter mixed layer",
        fileUrl: `${MEDIA}/report-antarctic-biodiversity.svg`,
        fileType: "application/pdf",
        abstract:
          "Draft in preparation. Repeat hydrography across the Antarctic Polar Frontal Zone indicates substantial particulate carbon export below 200 m during winter mixing, with sinking flux 1.4 times the regional climatological estimate. Sediment trap deployments and radiocarbon analysis are still being processed.",
        status: ReportStatus.draft,
        uploadedById: u.iyer.id,
        disciplineTags: { connect: [{ id: t.oceanography.id }] },
      },
    }),
  ]);

  // --- Datasets ------------------------------------------------------------
  const datasets = await Promise.all([
    prisma.dataset.create({
      data: {
        expeditionId: E["southern-ocean-carbon-export"].id,
        title: "CTD cast profiles — Southern Ocean stations SOV-01 to SOV-12",
        description:
          "Temperature, salinity, dissolved oxygen and chlorophyll-a from twelve repeat CTD stations across the Antarctic Polar Frontal Zone, sampled every four hours over 53 days. Casts are averaged into 1 m bins above 100 m and 10 m bins below.",
        format: DatasetFormat.CSV,
        fileUrl: `${MEDIA}/dataset-ctd-profiles.csv`,
        sizeBytes: 184320n,
        instrument: "CTD Rosette (Sea-Bird SBE 911plus)",
        doi: "10.5281/indopolaris.sov.ctd.2024",
        license: "CC BY 4.0",
        uploadedById: u.iyer.id,
        parameterTags: {
          connect: [
            { id: t.oceanography.id },
            { id: t.ctd.id },
            { id: t.biology.id },
          ],
        },
      },
    }),
    prisma.dataset.create({
      data: {
        expeditionId: E["arctic-sea-ice-dynamics"].id,
        title: "Sea-ice concentration and extent — Kongsfjorden, 2024",
        description:
          "Daily sea-ice concentration and extent derived from passive microwave retrievals, cross-checked against weekly in-situ thickness transects and the moored upward-looking sonar record.",
        format: DatasetFormat.CSV,
        fileUrl: `${MEDIA}/dataset-sea-ice-concentration.csv`,
        sizeBytes: 65536n,
        instrument: "Satellite Sensor (AMSR2) + Mooring Buoy",
        doi: "10.5281/indopolaris.arc.seaice.2024",
        license: "CC BY 4.0",
        uploadedById: u.bhattacharya.id,
        parameterTags: {
          connect: [
            { id: t.cryosphere.id },
            { id: t.satellite.id },
            { id: t.buoy.id },
          ],
        },
      },
    }),
    prisma.dataset.create({
      data: {
        expeditionId: E["dakshin-gangotri-mass-balance"].id,
        title: "Glacier surface elevation change by ablation zone, 2019–2024",
        description:
          "Mean surface elevation change relative to the 2019 reference surface, in three ablation zones, derived from stake networks and repeat ice-penetrating radar surveys. Uncertainty is one standard deviation of the repeat-survey difference.",
        format: DatasetFormat.CSV,
        fileUrl: `${MEDIA}/dataset-glacier-fab.csv`,
        sizeBytes: 32768n,
        instrument: "Ice-Penetrating Radar + stake network",
        doi: "10.5281/indopolaris.him.fab.2024",
        license: "CC BY 4.0",
        uploadedById: u.deshmukh.id,
        parameterTags: {
          connect: [
            { id: t.glaciology.id },
            { id: t.ipr.id },
            { id: t.remoteSensing.id },
          ],
        },
      },
    }),
    prisma.dataset.create({
      data: {
        expeditionId: E["ise-42-antarctica"].id,
        title: "Automatic weather station record, Bharati nunatak (2019–2025)",
        description:
          "Hourly air temperature, pressure, humidity, wind speed and global solar radiation from the automated station on the nunatak adjacent to the station. Data are gap-filled and flagged.",
        format: DatasetFormat.CSV,
        fileUrl: `${MEDIA}/dataset-ctd-profiles.csv`,
        sizeBytes: 4194304n,
        instrument: "Automatic Weather Station",
        license: "CC BY 4.0",
        uploadedById: u.bhattacharya.id,
        parameterTags: {
          connect: [
            { id: t.atmosphere.id },
            { id: t.aws.id },
            { id: t.cryosphere.id },
          ],
        },
      },
    }),
  ]);

  // --- Publications --------------------------------------------------------
  const publications = await Promise.all([
    prisma.publication.create({
      data: {
        title:
          "Enabling early-career polar scientists: a mentoring model for national programmes",
        authors: [
          "Raghavan, M.",
          "Kulkarni, A.",
          "Deshmukh, A.",
        ],
        journal: "Journal of Polar Outreach",
        year: 2025,
        doi: "10.5281/indopolaris.jpo.2025.014",
        abstract:
          "National polar programmes in the middle latitudes are increasingly expected to build public-outreach capacity alongside their science. We describe a mentoring model in which early-career researchers rotate through communications functions, and report outcomes from three cohorts at a single institution.",
        fileUrl: `${MEDIA}/pub-antarctic-early-careers.svg`,
        relatedExpeditionId: E["ise-42-antarctica"].id,
        disciplineTags: { connect: [{ id: t.atmosphere.id }] },
      },
    }),
    prisma.publication.create({
      data: {
        title:
          "Southern Ocean sea-ice outlook: what a 1.9× bloom anomaly implies for 2026",
        authors: ["Iyer, K.", "Bhattacharya, R.", "Meza, P."],
        journal: "Cryosphere Letters",
        year: 2025,
        doi: "10.5281/indopolaris.cl.2025.007",
        abstract:
          "Combining repeat hydrography with passive microwave retrievals, we outline likely 2026 conditions across the Antarctic Polar Frontal Zone and discuss the implications for carbon export and for the marginal ice zone habitats sampled during expedition SOV-2024.",
        fileUrl: `${MEDIA}/pub-sea-ice-outlook.svg`,
        relatedExpeditionId: E["southern-ocean-carbon-export"].id,
        disciplineTags: {
          connect: [
            { id: t.oceanography.id },
            { id: t.cryosphere.id },
            { id: t.biology.id },
          ],
        },
      },
    }),
    prisma.publication.create({
      data: {
        title:
          "Interpreting thinning thresholds in High Mountain Asia's third-highest glacier",
        authors: ["Deshmukh, A.", "Wang, L."],
        journal: "Himalayan Glaciology Review",
        year: 2024,
        doi: "10.5281/indopolaris.hgr.2024.031",
        abstract:
          "We review the surface-elevation and radar-thickness record for Dakshin Gangotri Glacier and place it against modelled thresholds for the onset of unstable retreat, concluding that the observed lower-zone loss is approaching but has not yet crossed the modelled threshold for retreat acceleration.",
        relatedExpeditionId: E["dakshin-gangotri-mass-balance"].id,
        disciplineTags: { connect: [{ id: t.glaciology.id }] },
      },
    }),
    prisma.publication.create({
      data: {
        title:
          "An open archive for polar research outputs in low-bandwidth regions",
        authors: ["Bhattacharya, R.", "Raghavan, M."],
        journal: "Data Science Journal",
        year: 2025,
        doi: null,
        abstract:
          "We describe IndoPolaris, a repository that pairs a citable scientific archive with a public outreach layer, and discuss the design decisions that let the same records serve researchers doing full-text search and students reading on a metered connection.",
        relatedExpeditionId: null,
        disciplineTags: { connect: [{ id: t.remoteSensing.id }] },
      },
    }),
  ]);

  return { reports, datasets, publications };
}

// ---------------------------------------------------------------------------
// Outreach drafts
// ---------------------------------------------------------------------------

async function seedOutreachDrafts(
  u: Awaited<ReturnType<typeof seedUsers>>,
  ex: Awaited<ReturnType<typeof seedExpeditions>>,
  content: Awaited<ReturnType<typeof seedContent>>,
) {
  const E = ex.bySlug;
  const m = ex.media.byKey;

  // These exist so the story feed and the review queue are not empty on first
  // run. In the real workflow these rows are produced by the Claude pipeline
  // (Section 5.3) and always land in `pending_review` first.

  // 1. Pending review — from a Report.
  await prisma.outreachDraft.create({
    data: {
      sourceType: OutreachSourceType.Report,
      sourceId: content.reports[0].id,
      reportId: content.reports[0].id,
      draftText:
        "The East Antarctic coast is a place where a small change in timing rearranges the whole food web. During the 42nd Indian Scientific Expedition to Antarctica, our team sampled eleven transects across 116 days and found that the spring plankton bloom started more than three weeks earlier than it typically does. That earlier bloom produced almost double the usual peak biomass. The timing matters because the organisms that bloom are the ones that eventually sink, carrying carbon out of the surface ocean and into the deep sea. Understanding when that happens helps climate models that try to represent the Southern Ocean's contribution to the carbon cycle.",
      draftCaption:
        "Antarctica's spring bloom arrived 26 days early this year and produced nearly double the usual biomass. What that means for the carbon cycle. 🧊",
      status: OutreachStatus.pending_review,
      targetChannel: "website",
      suggestedMedia: {
        connect: [
          { id: m["antarctica-ice-shelf"].id },
          { id: m["antarctica-aerial"].id },
        ],
      },
    },
  });

  // 2. Approved, not yet published.
  await prisma.outreachDraft.create({
    data: {
      sourceType: OutreachSourceType.Expedition,
      sourceId: E["dakshin-gangotri-mass-balance"].id,
      expeditionId: E["dakshin-gangotri-mass-balance"].id,
      draftText:
        "Five summers of measurements have now shown how fast Dakshin Gangotri Glacier — the third-highest glacier in the world — is thinning. Its lower reaches have lost about eleven metres of ice in five years, the steepest rate ever recorded here. Above 5,400 metres, the snowpack has not changed at all, which tells us the loss is coming from hotter air rather than from less snowfall. Radar surveys, which can see through the ice, show the glacier's bed has retreated by an average of 180 metres, meaning the ice is also getting shallower. That combination is what glaciologists watch closely: as a glacier thins, it eventually can no longer survive a warm summer.",
      draftCaption:
        "Five summers of measurements: Dakshin Gangotri Glacier has lost ~11 m of thickness in its lower reaches. The snowpack above 5,400 m hasn't changed at all.",
      status: OutreachStatus.approved,
      reviewedById: u.editor.id,
      targetChannel: "website",
      suggestedMedia: {
        connect: [
          { id: m["himalaya-hero"].id },
          { id: m["himalaya-moraine"].id },
          { id: m["himalaya-camp"].id },
        ],
      },
    },
  });

  // 3. Published — a Dataset, with the reviewer and timestamp the DB CHECK
  //    constraint requires.
  await prisma.outreachDraft.create({
    data: {
      sourceType: OutreachSourceType.Dataset,
      sourceId: content.datasets[1].id,
      datasetId: content.datasets[1].id,
      draftText:
        "A public dataset released this month records how sea ice in Kongsfjorden behaved through all of 2024, day by day. It combines satellite measurements with readings from instruments moored on the seabed and with weekly field surveys on the ice itself. The interesting part is the disagreement: the satellite sees the ice from above, the buoy sees it from below, and where those two disagree most is exactly where researchers are still working out how much we can trust each method. Publishing the underlying numbers means anyone can check that disagreement for themselves.",
      draftCaption:
        "New open dataset: day-by-day sea-ice conditions in Kongsfjorden for all of 2024, combining satellite, moored buoy and field survey data. Free to download.",
      status: OutreachStatus.published,
      reviewedById: u.editor.id,
      publishedAt: new Date("2025-01-20"),
      targetChannel: "website",
      suggestedMedia: {
        connect: [
          { id: m["arctic-sea-ice"].id },
          { id: m["arctic-sky"].id },
        ],
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("[seed] resetting tables…");
  await reset();

  console.log("[seed] users…");
  const users = await seedUsers();
  console.log(`[seed]   ${Object.keys(users).length} users (password: ${DEMO_PASSWORD})`);

  console.log("[seed] tags…");
  const tags = await seedTags();

  console.log("[seed] media + expeditions…");
  const expeditions = await seedExpeditions(users, tags);
  await linkMediaToExpeditions(expeditions.media, expeditions.expeditions);
  console.log(`[seed]   ${expeditions.expeditions.length} expeditions, ${expeditions.media.rows.length} media assets`);

  console.log("[seed] reports / datasets / publications…");
  const content = await seedContent(users, tags, expeditions);
  await seedOutreachDrafts(users, expeditions, content);

  // Exercise the FTS layer end to end so a broken search vector shows up here
  // rather than in the UI.
  const probe = await prisma.$queryRawUnsafe<
    { kind: string; title: string; rank: number }[]
  >(
    `SELECT kind, title, rank FROM indopolaris_search('sea ice', NULL, NULL, NULL, NULL, NULL, 5, 0)`,
  );
  console.log(`[seed] search probe "sea ice" -> ${probe.length} hit(s)`);
  for (const h of probe) console.log(`[seed]   [${h.kind}] ${h.title} (rank ${h.rank.toFixed(4)})`);

  const stats = {
    expeditions: await prisma.expedition.count(),
    reports: await prisma.report.count(),
    datasets: await prisma.dataset.count(),
    publications: await prisma.publication.count(),
    media: await prisma.mediaAsset.count(),
    drafts: await prisma.outreachDraft.count(),
    tags: await prisma.tag.count(),
  };

  console.log("\n[seed] done:", stats);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error("[seed] FAILED:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
