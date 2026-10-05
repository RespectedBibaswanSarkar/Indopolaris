-- ===========================================================================
-- ML / RL operational state: model registry, inference log, bandit posteriors
-- and engagement feedback.
--
-- Section 5 defines these four tables. They are separate from the repository
-- content because they are append-only operational records written by the
-- Python service, and because the admin dashboard has to display accuracy read
-- from a real `MLModelVersion` row (Section 8.4) rather than a hardcoded number.
-- ===========================================================================

-- CreateEnum
CREATE TYPE "ClassificationSourceType" AS ENUM ('Report', 'Dataset', 'Publication');

-- CreateEnum
CREATE TYPE "TimeSlot" AS ENUM ('morning', 'afternoon', 'evening');

-- CreateTable
CREATE TABLE "ClassificationLog" (
    "id" TEXT NOT NULL,
    "sourceType" "ClassificationSourceType" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "predictedTags" TEXT[],
    "confidenceScores" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MLModelVersion" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "trainedAt" TIMESTAMP(3) NOT NULL,
    "datasetSource" TEXT NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "macroF1" DOUBLE PRECISION NOT NULL,
    "artifactPath" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MLModelVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BanditArmState" (
    "id" TEXT NOT NULL,
    "arm" TEXT NOT NULL,
    "alpha" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "beta" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "totalPulls" INTEGER NOT NULL DEFAULT 0,
    "totalReward" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BanditArmState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngagementEvent" (
    "id" TEXT NOT NULL,
    "outreachDraftId" TEXT NOT NULL,
    "channel" "TargetChannel" NOT NULL,
    "timeSlotBucket" "TimeSlot" NOT NULL,
    "impressions" INTEGER NOT NULL,
    "clicks" INTEGER NOT NULL,
    "reward" DOUBLE PRECISION NOT NULL,
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngagementEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClassificationLog_sourceType_sourceId_idx" ON "ClassificationLog"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "ClassificationLog_modelVersion_idx" ON "ClassificationLog"("modelVersion");

-- CreateIndex
CREATE INDEX "ClassificationLog_createdAt_idx" ON "ClassificationLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MLModelVersion_name_version_key" ON "MLModelVersion"("name", "version");

-- CreateIndex
CREATE INDEX "MLModelVersion_name_isActive_idx" ON "MLModelVersion"("name", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "BanditArmState_arm_key" ON "BanditArmState"("arm");

-- CreateIndex
CREATE INDEX "BanditArmState_totalPulls_idx" ON "BanditArmState"("totalPulls");

-- CreateIndex
CREATE INDEX "EngagementEvent_outreachDraftId_idx" ON "EngagementEvent"("outreachDraftId");

-- CreateIndex
CREATE INDEX "EngagementEvent_channel_timeSlotBucket_idx" ON "EngagementEvent"("channel", "timeSlotBucket");

-- CreateIndex
CREATE INDEX "EngagementEvent_isSimulated_createdAt_idx" ON "EngagementEvent"("isSimulated", "createdAt");

-- AddForeignKey
ALTER TABLE "EngagementEvent" ADD CONSTRAINT "EngagementEvent_outreachDraftId_fkey" FOREIGN KEY ("outreachDraftId") REFERENCES "OutreachDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written integrity constraints for the ML state.
--
-- The bandit is the reason these exist. A Beta posterior is only meaningful for
-- alpha, beta > 0, and a reward outside [0,1] would silently poison every
-- future recommendation — a wrong posterior is worse than no posterior,
-- because the dashboard would still show a confident-looking number. None of
-- these can be expressed in Prisma's schema language, so they live here, and
-- each has a negative test in scripts/verify-constraints.ts.
-- ===========================================================================

-- A Beta(alpha, beta) distribution is undefined for alpha <= 0 or beta <= 0:
-- the density is not normalisable and Thompson Sampling raises instead of
-- sampling. A decay/sweep bug that decremented one counter below zero would
-- otherwise break /recommend permanently.
ALTER TABLE "BanditArmState"
  ADD CONSTRAINT "bandit_arm_posterior_positive" CHECK ("alpha" > 0 AND "beta" > 0);

-- Rewards arrive normalised to [0,1] (a click-through rate), so the running
-- total can never exceed the number of pulls that produced it.
ALTER TABLE "BanditArmState"
  ADD CONSTRAINT "bandit_arm_totals_consistent" CHECK (
    "totalPulls" >= 0
    AND "totalReward" >= 0
    AND "totalReward" <= "totalPulls"
  );

-- An arm name is the join key the bandit uses in memory and on disk
-- ("{channel}_{timeSlot}"). Anything without an underscore cannot be parsed
-- back into the channel/slot pair it was built from.
ALTER TABLE "BanditArmState"
  ADD CONSTRAINT "bandit_arm_name_parsable" CHECK (
    "arm" ~ '^(website|instagram|twitter)_(morning|afternoon|evening)$'
  );

-- Section 6: `reward` is the normalised value the bandit regresses on and must
-- stay in [0,1]. Raw click counts are stored alongside it; a reward > 1 means
-- the normalisation step was skipped or double-applied.
ALTER TABLE "EngagementEvent"
  ADD CONSTRAINT "engagement_event_reward_in_unit_interval" CHECK (
    "reward" >= 0 AND "reward" <= 1
  );

-- You cannot have more clicks than impressions. Synthetic engagement data is
-- generated by ml/scripts/simulate_engagement.py, so a bug there would
-- produce click-through rates above 100% and an unlearnable bandit.
ALTER TABLE "EngagementEvent"
  ADD CONSTRAINT "engagement_event_clicks_within_impressions" CHECK (
    "impressions" >= 0 AND "clicks" >= 0 AND "clicks" <= "impressions"
  );

-- Section 8.4: the accuracy and macro-F1 displayed in the admin dashboard are
-- read straight off this row. A value outside [0,1] would render as a
-- percentage above 100% in front of reviewers deciding whether to trust the
-- classifier's suggestions.
ALTER TABLE "MLModelVersion"
  ADD CONSTRAINT "ml_model_version_metrics_in_unit_interval" CHECK (
    "accuracy" >= 0 AND "accuracy" <= 1
    AND "macroF1" >= 0 AND "macroF1" <= 1
  );

-- The corpus behind the metrics must be recorded, because the archive's own
-- numbers come from a *proxy* corpus (see README "Dataset proxy disclosure").
-- A blank provenance string would make that indistinguishable from a real
-- NCPOR-trained model at read time.
ALTER TABLE "MLModelVersion"
  ADD CONSTRAINT "ml_model_version_dataset_source_not_blank" CHECK (
    btrim("datasetSource") <> ''
  );

-- `confidenceScores` is a tag -> probability map consumed by the review queue.
-- An array (or a scalar) here would satisfy the NOT NULL above and then break
-- the badge that renders each tag's confidence.
ALTER TABLE "ClassificationLog"
  ADD CONSTRAINT "classification_log_confidence_is_object" CHECK (
    jsonb_typeof("confidenceScores") = 'object'
  );

-- Same reasoning for the tag list: the review UI groups by tag, so an empty
-- array means a classification that recorded no explanation for itself.
--
-- COALESCE is required, not defensive: `array_length('{}', 1)` returns NULL
-- (not 0) for an empty array, and a CHECK that evaluates to NULL is treated as
-- satisfied. Without the COALESCE this constraint silently accepts every empty
-- tag list, which is precisely the case it exists to reject.
ALTER TABLE "ClassificationLog"
  ADD CONSTRAINT "classification_log_has_predicted_tag" CHECK (
    COALESCE(array_length("predictedTags", 1), 0) >= 1
  );
