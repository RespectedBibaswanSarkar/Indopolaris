/**
 * Negative tests for the integrity constraints declared in the SQL migrations.
 *
 * Prisma's schema language cannot express CHECK constraints, so the rules that
 * Section 4 and Section 6 of the spec actually depend on — alt text is
 * mandatory, a draft points at exactly one source, nothing publishes without a
 * human reviewer — live only in SQL. A constraint nobody has tried to violate
 * is a constraint nobody knows works.
 *
 * Each case below asserts that the database REJECTS the write. A case that
 * unexpectedly succeeds is reported as a failure, because that means the
 * guarantee is not being enforced.
 *
 *   npm run db:verify-constraints
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const adapter = new PrismaPg({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://indopolaris:indopolaris_dev_pw@127.0.0.1:5432/indopolaris?schema=public",
});
const prisma = new PrismaClient({ adapter });

type Case = {
  name: string;
  /** Human-readable form of the guarantee being tested. */
  rule: string;
  run: () => Promise<unknown>;
};

let passed = 0;
let failed = 0;

async function expectRejected(c: Case) {
  try {
    await c.run();
    failed++;
    console.log(`  FAIL  ${c.name}`);
    console.log(`        expected the database to reject this, but it succeeded.`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // PGlite and libpq both surface CHECK violations with SQLSTATE 23514.
    const isCheckViolation =
      message.includes("23514") ||
      /check constraint|violates/i.test(message);
    if (isCheckViolation) {
      passed++;
      const detail = message.match(/(?:Check constraint|check constraint)[:\s]+"?([\w]+)"?/i)?.[1];
      console.log(`  ok    ${c.name}${detail ? `  [${detail}]` : ""}`);
    } else {
      // Rejected, but for an unrelated reason (bad FK, missing column, …) —
      // that is not a pass, it means the test is wrong.
      failed++;
      console.log(`  FAIL  ${c.name}`);
      console.log(`        rejected, but not by a CHECK constraint: ${message.split("\n")[0]}`);
    }
  }
}

async function main() {
  // Fixtures: one user, one expedition, one report to hang the drafts off.
  const user = await prisma.user.findFirstOrThrow();
  const expedition = await prisma.expedition.findFirstOrThrow();
  const report = await prisma.report.findFirstOrThrow();

  // EngagementEvent has a real FK to OutreachDraft, so the feedback probes
  // below need a draft that survives them. Created here and deleted at the end;
  // every other probe in this file is a write the database rejects, leaving
  // no residue at all.
  const probeDraft = await prisma.outreachDraft.create({
    data: {
      sourceType: "Report",
      sourceId: report.id,
      reportId: report.id,
      draftText: "constraint probe — engagement fixture",
      draftCaption: "constraint probe",
      status: "pending_review",
    },
  });

  console.log("\nIndoPolaris — constraint verification\n");

  console.log("Section 6: alt text is mandatory");
  await expectRejected({
    name: "MediaAsset.altText cannot be an empty string",
    rule: "altText must carry real alt text, not just be non-NULL",
    run: () =>
      prisma.mediaAsset.create({
        data: {
          expeditionId: expedition.id,
          type: "photo",
          url: "/media/seed/antarctica-hero.svg",
          caption: "test",
          altText: "",
          credit: "test",
          uploadedById: user.id,
        },
      }),
  });
  await expectRejected({
    name: "MediaAsset.altText cannot be whitespace only",
    rule: "`altText: \"   \"` passes NOT NULL but fails every screen reader",
    run: () =>
      prisma.mediaAsset.create({
        data: {
          expeditionId: expedition.id,
          type: "photo",
          url: "/media/seed/antarctica-hero.svg",
          caption: "test",
          altText: "     ",
          credit: "test",
          uploadedById: user.id,
        },
      }),
  });

  console.log("\nSection 4: expedition windows are ordered");
  await expectRejected({
    name: "Expedition.endDate cannot precede startDate",
    rule: "a date range that ends before it starts is not a date range",
    run: () =>
      prisma.expedition.create({
        data: {
          slug: `constraint-probe-${Date.now()}`,
          title: "constraint probe",
          region: "Arctic",
          startDate: new Date("2024-06-01"),
          endDate: new Date("2024-01-01"),
          leadScientist: "probe",
          station: "probe",
          summary: "probe",
          latitude: 0,
          longitude: 0,
        },
      }),
  });

  console.log("\nSection 5.3: drafts are human-reviewed, never auto-published");
  await expectRejected({
    name: "OutreachDraft cannot be published without a reviewer",
    rule: "nothing reaches the public site without a named human approver",
    run: () =>
      prisma.outreachDraft.create({
        data: {
          sourceType: "Report",
          sourceId: report.id,
          reportId: report.id,
          draftText: "auto-published text",
          draftCaption: "auto-published caption",
          status: "published",
          publishedAt: new Date(),
          // reviewedById deliberately omitted
        },
      }),
  });
  await expectRejected({
    name: "OutreachDraft cannot point at zero sources",
    rule: "sourceType + sourceId is polymorphic and must resolve to one record",
    run: () =>
      prisma.outreachDraft.create({
        data: {
          sourceType: "Report",
          sourceId: report.id,
          draftText: "orphan",
          draftCaption: "orphan",
          // no reportId/datasetId/… at all
        },
      }),
  });
  await expectRejected({
    name: "OutreachDraft cannot point at two sources",
    rule: "exactly one source, not a union",
    run: () =>
      prisma.outreachDraft.create({
        data: {
          sourceType: "Report",
          sourceId: report.id,
          reportId: report.id,
          expeditionId: expedition.id,
          draftText: "ambiguous",
          draftCaption: "ambiguous",
        },
      }),
  });
  await expectRejected({
    name: "OutreachDraft.sourceId must agree with sourceType",
    rule: "a Report draft cannot carry a Dataset's id",
    run: () =>
      prisma.outreachDraft.create({
        data: {
          sourceType: "Report",
          sourceId: expedition.id, // sourceId contradicts sourceType
          expeditionId: expedition.id,
          draftText: "mismatched",
          draftCaption: "mismatched",
        },
      }),
  });

  console.log("\nSearch vocabulary");
  await expectRejected({
    name: "Tag.label cannot be blank",
    rule: "a blank facet label is a dead end in the filter sidebar",
    run: () =>
      prisma.tag.create({
        data: { label: "  ", slug: `blank-${Date.now()}`, category: "discipline" },
      }),
  });

  console.log("\nSection 6: the bandit's Beta posteriors must stay sampleable");
  // Each numeric probe below uses a *valid* arm name, so that the only thing
  // left for the database to object to is the value under test. Giving them
  // placeholder names made all three fail on `bandit_arm_name_parsable`
  // instead, which the harness reported as a pass — a green test proving
  // nothing about the constraint it claimed to cover.
  await expectRejected({
    name: "BanditArmState.alpha cannot reach zero",
    rule: "Beta(0, b) is not normalisable — Thompson Sampling raises instead of sampling",
    run: () =>
      prisma.banditArmState.create({
        data: { arm: "website_morning", alpha: 0, beta: 5, totalPulls: 4, totalReward: 2 },
      }),
  });
  await expectRejected({
    name: "BanditArmState.beta cannot reach zero",
    rule: "same failure mode on the other parameter",
    run: () =>
      prisma.banditArmState.create({
        data: { arm: "twitter_afternoon", alpha: 3, beta: 0, totalPulls: 2, totalReward: 1 },
      }),
  });
  await expectRejected({
    name: "BanditArmState.totalReward cannot exceed totalPulls",
    rule: "each pull contributes at most one unit of reward",
    run: () =>
      prisma.banditArmState.create({
        data: { arm: "instagram_evening", alpha: 4, beta: 4, totalPulls: 3, totalReward: 9 },
      }),
  });
  await expectRejected({
    name: "BanditArmState.arm must be channel_timeslot",
    rule: "an unparsable arm name cannot be decomposed back into channel x slot",
    run: () =>
      prisma.banditArmState.create({
        // Not one of the nine Section 6 arms.
        data: { arm: "facebook_morning", alpha: 2, beta: 2, totalPulls: 1, totalReward: 0.5 },
      }),
  });

  console.log("\nSection 6: engagement feedback must be physically possible");
  await expectRejected({
    name: "EngagementEvent.reward cannot exceed 1",
    rule: "reward is a normalised click-through rate; >1 means normalisation was skipped",
    run: () =>
      prisma.engagementEvent.create({
        data: {
          outreachDraftId: probeDraft.id,
          channel: "instagram",
          timeSlotBucket: "morning",
          impressions: 1000,
          clicks: 120,
          reward: 1.4,
        },
      }),
  });
  await expectRejected({
    name: "EngagementEvent.reward cannot be negative",
    rule: "a negative reward would drag the posterior toward never picking that arm for reasons that cannot happen",
    run: () =>
      prisma.engagementEvent.create({
        data: {
          outreachDraftId: probeDraft.id,
          channel: "twitter",
          timeSlotBucket: "evening",
          impressions: 500,
          clicks: 10,
          reward: -0.2,
        },
      }),
  });
  await expectRejected({
    name: "EngagementEvent cannot have more clicks than impressions",
    rule: "a >100% click-through rate is impossible, and would poison the bandit it trains",
    run: () =>
      prisma.engagementEvent.create({
        data: {
          outreachDraftId: probeDraft.id,
          channel: "website",
          timeSlotBucket: "afternoon",
          impressions: 40,
          clicks: 90,
          reward: 0.3,
        },
      }),
  });

  console.log("\nSection 6: a reseed must not leave orphan posteriors");
  // Not a CHECK constraint, so `expectRejected` cannot express this one. It is
  // the inverse guarantee: after a reseed, no arm may claim pulls whose
  // EngagementEvent rows were deleted along with their drafts. `BanditArmState`
  // has no FK to OutreachDraft, so `TRUNCATE ... "OutreachDraft" CASCADE` used
  // to delete every event while leaving nine posteriors asserting hundreds of
  // pulls — a bandit whose belief could no longer be audited against the
  // observations that produced it, which is exactly what Section 6's
  // "synthetic feedback stays permanently separable" requirement depends on.
  {
    const orphans = await prisma.$queryRaw<{ arm: string; total_pulls: number }[]>`
      SELECT b."arm", b."totalPulls" AS total_pulls
        FROM "BanditArmState" b
       WHERE b."totalPulls" > 0
         AND NOT EXISTS (
           SELECT 1 FROM "EngagementEvent" e
            WHERE (e.channel::text || '_' || e."timeSlotBucket"::text) = b."arm"
         )
    `;
    if (orphans.length === 0) {
      passed++;
      console.log("  ok    no arm claims pulls with no EngagementEvent behind them");
    } else {
      failed++;
      console.log(`  FAIL  ${orphans.length} arm(s) have posteriors with no backing events`);
      for (const o of orphans) {
        console.log(`        ${o.arm}: ${o.total_pulls} pulls, 0 events`);
      }
    }
  }

  console.log("\nSection 8.4: dashboard figures are read from real rows");
  await expectRejected({
    name: "MLModelVersion.accuracy cannot exceed 1",
    rule: "the admin dashboard renders this as a percentage; >1 would display 140%",
    run: () =>
      prisma.mLModelVersion.create({
        data: {
          name: "discipline-classifier",
          version: `probe-acc-${Date.now()}`,
          trainedAt: new Date(),
          datasetSource: "probe",
          accuracy: 1.2,
          macroF1: 0.8,
          artifactPath: "probe.joblib",
        },
      }),
  });
  await expectRejected({
    name: "MLModelVersion.macroF1 cannot exceed 1",
    rule: "same reason, on the other metric",
    run: () =>
      prisma.mLModelVersion.create({
        data: {
          name: "discipline-classifier",
          version: `probe-f1-${Date.now()}`,
          trainedAt: new Date(),
          datasetSource: "probe",
          accuracy: 0.8,
          macroF1: 3.0,
          artifactPath: "probe.joblib",
        },
      }),
  });
  await expectRejected({
    name: "MLModelVersion.datasetSource cannot be blank",
    rule: "provenance distinguishes the proxy corpus from a real NCPOR-trained model",
    run: () =>
      prisma.mLModelVersion.create({
        data: {
          name: "discipline-classifier",
          version: `probe-src-${Date.now()}`,
          trainedAt: new Date(),
          datasetSource: "   ",
          accuracy: 0.8,
          macroF1: 0.8,
          artifactPath: "probe.joblib",
        },
      }),
  });

  console.log("\nSection 6: a classification must explain itself");
  await expectRejected({
    name: "ClassificationLog.confidenceScores must be an object",
    rule: "the review queue renders one confidence badge per key of this map",
    run: () =>
      prisma.classificationLog.create({
        data: {
          sourceType: "Report",
          sourceId: report.id,
          predictedTags: ["Atmospheric & Space Science"],
          // An array satisfies NOT NULL and then breaks the badge renderer.
          confidenceScores: [0.9],
          modelVersion: "probe",
        },
      }),
  });
  await expectRejected({
    name: "ClassificationLog cannot have an empty predictedTags array",
    rule: "a classification with no tags records no decision at all",
    run: () =>
      prisma.classificationLog.create({
        data: {
          sourceType: "Report",
          sourceId: report.id,
          predictedTags: [],
          confidenceScores: {},
          modelVersion: "probe",
        },
      }),
  });

  await prisma.outreachDraft
    .delete({ where: { id: probeDraft.id } })
    .catch(() => {
      /* the draft is only needed by the probes above */
    });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("\nverification harness error:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
