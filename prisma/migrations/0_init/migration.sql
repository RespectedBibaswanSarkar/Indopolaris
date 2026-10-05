-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Region" AS ENUM ('Antarctica', 'Arctic', 'Himalaya', 'SouthernOcean');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('public', 'contributor', 'editor', 'admin');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('draft', 'review', 'published');

-- CreateEnum
CREATE TYPE "DatasetFormat" AS ENUM ('CSV', 'NetCDF', 'other');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('photo', 'video');

-- CreateEnum
CREATE TYPE "TagCategory" AS ENUM ('discipline', 'instrument', 'region');

-- CreateEnum
CREATE TYPE "OutreachSourceType" AS ENUM ('Report', 'Dataset', 'Publication', 'Expedition');

-- CreateEnum
CREATE TYPE "OutreachStatus" AS ENUM ('pending_review', 'approved', 'rejected', 'published');

-- CreateEnum
CREATE TYPE "TargetChannel" AS ENUM ('website', 'twitter', 'instagram');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'public',
    "institution" TEXT,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expedition" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "region" "Region" NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "leadScientist" TEXT NOT NULL,
    "station" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "route" JSONB,
    "vessel" TEXT,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "heroImageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expedition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "expeditionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "abstract" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dataset" (
    "id" TEXT NOT NULL,
    "expeditionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "format" "DatasetFormat" NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "instrument" TEXT NOT NULL,
    "doi" TEXT,
    "license" TEXT NOT NULL DEFAULT 'CC BY 4.0',
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Publication" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "authors" TEXT[],
    "journal" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "doi" TEXT,
    "abstract" TEXT NOT NULL,
    "fileUrl" TEXT,
    "relatedExpeditionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Publication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "expeditionId" TEXT,
    "type" "MediaType" NOT NULL,
    "url" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "storageKey" TEXT,
    "caption" TEXT NOT NULL,
    "altText" TEXT NOT NULL,
    "credit" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3),
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachDraft" (
    "id" TEXT NOT NULL,
    "sourceType" "OutreachSourceType" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "draftText" TEXT NOT NULL,
    "draftCaption" TEXT NOT NULL,
    "status" "OutreachStatus" NOT NULL DEFAULT 'pending_review',
    "reviewedById" TEXT,
    "targetChannel" "TargetChannel" NOT NULL DEFAULT 'website',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reportId" TEXT,
    "datasetId" TEXT,
    "publicationId" TEXT,
    "expeditionId" TEXT,

    CONSTRAINT "OutreachDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "category" "TagCategory" NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ExpeditionRegionTags" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ExpeditionRegionTags_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_ReportDisciplineTags" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ReportDisciplineTags_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_DatasetParameterTags" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_DatasetParameterTags_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_PublicationDisciplineTags" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PublicationDisciplineTags_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_DraftSuggestedMedia" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_DraftSuggestedMedia_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE UNIQUE INDEX "Expedition_slug_key" ON "Expedition"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Expedition_heroImageId_key" ON "Expedition"("heroImageId");

-- CreateIndex
CREATE INDEX "Expedition_region_idx" ON "Expedition"("region");

-- CreateIndex
CREATE INDEX "Expedition_startDate_idx" ON "Expedition"("startDate");

-- CreateIndex
CREATE INDEX "Expedition_isFeatured_idx" ON "Expedition"("isFeatured");

-- CreateIndex
CREATE INDEX "Report_expeditionId_idx" ON "Report"("expeditionId");

-- CreateIndex
CREATE INDEX "Report_status_idx" ON "Report"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Dataset_doi_key" ON "Dataset"("doi");

-- CreateIndex
CREATE INDEX "Dataset_expeditionId_idx" ON "Dataset"("expeditionId");

-- CreateIndex
CREATE INDEX "Dataset_format_idx" ON "Dataset"("format");

-- CreateIndex
CREATE UNIQUE INDEX "Publication_doi_key" ON "Publication"("doi");

-- CreateIndex
CREATE INDEX "Publication_year_idx" ON "Publication"("year");

-- CreateIndex
CREATE INDEX "Publication_relatedExpeditionId_idx" ON "Publication"("relatedExpeditionId");

-- CreateIndex
CREATE INDEX "MediaAsset_expeditionId_idx" ON "MediaAsset"("expeditionId");

-- CreateIndex
CREATE INDEX "MediaAsset_type_idx" ON "MediaAsset"("type");

-- CreateIndex
CREATE INDEX "MediaAsset_capturedAt_idx" ON "MediaAsset"("capturedAt");

-- CreateIndex
CREATE INDEX "OutreachDraft_status_idx" ON "OutreachDraft"("status");

-- CreateIndex
CREATE INDEX "OutreachDraft_sourceType_sourceId_idx" ON "OutreachDraft"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "OutreachDraft_publishedAt_idx" ON "OutreachDraft"("publishedAt");

-- CreateIndex
CREATE INDEX "Tag_category_idx" ON "Tag"("category");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_label_category_key" ON "Tag"("label", "category");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_slug_category_key" ON "Tag"("slug", "category");

-- CreateIndex
CREATE INDEX "_ExpeditionRegionTags_B_index" ON "_ExpeditionRegionTags"("B");

-- CreateIndex
CREATE INDEX "_ReportDisciplineTags_B_index" ON "_ReportDisciplineTags"("B");

-- CreateIndex
CREATE INDEX "_DatasetParameterTags_B_index" ON "_DatasetParameterTags"("B");

-- CreateIndex
CREATE INDEX "_PublicationDisciplineTags_B_index" ON "_PublicationDisciplineTags"("B");

-- CreateIndex
CREATE INDEX "_DraftSuggestedMedia_B_index" ON "_DraftSuggestedMedia"("B");

-- AddForeignKey
ALTER TABLE "Expedition" ADD CONSTRAINT "Expedition_heroImageId_fkey" FOREIGN KEY ("heroImageId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_expeditionId_fkey" FOREIGN KEY ("expeditionId") REFERENCES "Expedition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dataset" ADD CONSTRAINT "Dataset_expeditionId_fkey" FOREIGN KEY ("expeditionId") REFERENCES "Expedition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dataset" ADD CONSTRAINT "Dataset_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_relatedExpeditionId_fkey" FOREIGN KEY ("relatedExpeditionId") REFERENCES "Expedition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_expeditionId_fkey" FOREIGN KEY ("expeditionId") REFERENCES "Expedition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_expeditionId_fkey" FOREIGN KEY ("expeditionId") REFERENCES "Expedition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ExpeditionRegionTags" ADD CONSTRAINT "_ExpeditionRegionTags_A_fkey" FOREIGN KEY ("A") REFERENCES "Expedition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ExpeditionRegionTags" ADD CONSTRAINT "_ExpeditionRegionTags_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ReportDisciplineTags" ADD CONSTRAINT "_ReportDisciplineTags_A_fkey" FOREIGN KEY ("A") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ReportDisciplineTags" ADD CONSTRAINT "_ReportDisciplineTags_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DatasetParameterTags" ADD CONSTRAINT "_DatasetParameterTags_A_fkey" FOREIGN KEY ("A") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DatasetParameterTags" ADD CONSTRAINT "_DatasetParameterTags_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PublicationDisciplineTags" ADD CONSTRAINT "_PublicationDisciplineTags_A_fkey" FOREIGN KEY ("A") REFERENCES "Publication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PublicationDisciplineTags" ADD CONSTRAINT "_PublicationDisciplineTags_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DraftSuggestedMedia" ADD CONSTRAINT "_DraftSuggestedMedia_A_fkey" FOREIGN KEY ("A") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DraftSuggestedMedia" ADD CONSTRAINT "_DraftSuggestedMedia_B_fkey" FOREIGN KEY ("B") REFERENCES "OutreachDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written integrity constraints.
-- Prisma's schema language cannot express CHECK constraints, so anything the
-- data model depends on for correctness is declared here. Each one backs up a
-- rule that is stated in Section 4 or Section 6 of the product spec.
-- ===========================================================================

-- Section 6: alt-text is a hard accessibility requirement (GIGW / WCAG), not a
-- convention. The column is already NOT NULL; reject blank/whitespace too,
-- because `altText: "   "` passes NOT NULL and still fails every screen reader.
ALTER TABLE "MediaAsset"
  ADD CONSTRAINT "MediaAsset_altText_not_blank" CHECK (btrim("altText") <> '');

-- An expedition window cannot end before it starts.
ALTER TABLE "Expedition"
  ADD CONSTRAINT "Expedition_dates_ordered"
  CHECK ("endDate" IS NULL OR "endDate" >= "startDate");

-- Section 4 models OutreachDraft.sourceId polymorphically (sourceType +
-- sourceId), which Prisma cannot express. These four nullable FKs carry real
-- referential integrity; the constraint keeps them consistent with sourceType
-- and prevents a draft pointing at zero sources or at two at once.
ALTER TABLE "OutreachDraft"
  ADD CONSTRAINT "outreach_draft_single_source" CHECK (
    num_nonnulls("reportId", "datasetId", "publicationId", "expeditionId") = 1
    AND (("sourceType" = 'Report'      AND "reportId"      IS NOT NULL)
      OR ("sourceType" = 'Dataset'     AND "datasetId"     IS NOT NULL)
      OR ("sourceType" = 'Publication' AND "publicationId" IS NOT NULL)
      OR ("sourceType" = 'Expedition'  AND "expeditionId"  IS NOT NULL))
  );

-- sourceId must agree with the FK it duplicates, so a caller cannot write a
-- Report draft whose sourceId points at a Dataset row.
ALTER TABLE "OutreachDraft"
  ADD CONSTRAINT "outreach_draft_sourceId_consistent" CHECK (
    ("sourceType" = 'Report'      AND "sourceId" = "reportId")
    OR ("sourceType" = 'Dataset'     AND "sourceId" = "datasetId")
    OR ("sourceType" = 'Publication' AND "sourceId" = "publicationId")
    OR ("sourceType" = 'Expedition'  AND "sourceId" = "expeditionId")
  );

-- A draft cannot be marked published without a reviewer and a publish time.
-- Keeps the human-in-the-loop guarantee of Section 5.3 enforceable in the
-- database rather than only in application code.
ALTER TABLE "OutreachDraft"
  ADD CONSTRAINT "outreach_draft_published_requires_review" CHECK (
    "status" <> 'published' OR ("reviewedById" IS NOT NULL AND "publishedAt" IS NOT NULL)
  );

-- Tags are the faceted-search vocabulary (Section 5.4); keep them clean.
ALTER TABLE "Tag"
  ADD CONSTRAINT "Tag_label_not_blank" CHECK (btrim("label") <> '');
