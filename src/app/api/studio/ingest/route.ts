import { NextResponse } from "next/server";
import { z } from "zod";

import { classify } from "@/lib/ml";
import { ForbiddenError, requireUser } from "@/lib/session";
import { contentTypeFor, isSafeStorageKey, publicUrl } from "@/lib/storage";

/**
 * `POST /api/studio/ingest` — the ingest half of the pipeline.
 *
 * One request does what an upload normally does, in the order it must happen:
 *
 *  1. create the `Report` row (status `draft`)
 *  2. ask the ML service to classify its title + abstract
 *  3. record a `ClassificationLog` — written by the *service*, because it owns
 *     the model that produced the prediction
 *  4. create a pending `OutreachDraft` for the editor queue
 *
 * Step 3 is the subtle one. If the classifier is unavailable the report is
 * still saved and the draft is still created; the response reports
 * `taggingPending` so the UI can say so. A missing ML service must not lose a
 * scientist's upload — that is the Section 6 degradation requirement, and this
 * is where it is actually load-bearing.
 *
 * Step 4 is a template, not generated prose. Claude generation is Phase 7 and
 * `ANTHROPIC_API_KEY` is empty, so pretending to generate copy here would be a
 * lie. The draft text is derived from the report and labelled as a template.
 */
const BODY = z.object({
  title: z.string().min(3, "title is required").max(300),
  abstract: z.string().min(10, "abstract is required").max(5000),
  expeditionSlug: z.string().min(1),
  disciplineTags: z.array(z.string()).default([]),
  autoTag: z.boolean().default(true),
  generateDraft: z.boolean().default(true),
  /** Key returned by `POST /api/studio/upload`. Optional: a report can be filed
   *  from metadata alone, and the DB only requires the column to be a string. */
  storageKey: z.string().min(1).max(200).optional(),
  /** Content type recorded next to the key. Ignored without a key. */
  fileType: z.string().min(1).max(60).optional(),
});

export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_INPUT", message: "Body is not valid JSON" } },
      { status: 400 },
    );
  }

  const parsed = BODY.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_INPUT",
          message: parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; "),
        },
      },
      { status: 400 },
    );
  }

  const user = await requireUser("contributor").catch((error: unknown) => {
    if (error instanceof ForbiddenError) return null;
    throw error;
  });
  if (!user) {
    return NextResponse.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "Sign in as a contributor or above to upload a report",
        },
      },
      { status: 403 },
    );
  }

  const { title, abstract, expeditionSlug, autoTag, generateDraft, storageKey, fileType } =
    parsed.data;

  // The browser never supplies `fileUrl` — it supplies the key `/api/studio/upload`
  // returned, and the URL is derived here so a caller cannot point a report at
  // `https://elsewhere/whatever`.
  let fileUrl = "";
  let recordedType = "pending";
  if (storageKey) {
    if (!isSafeStorageKey(storageKey)) {
      return NextResponse.json(
        { error: { code: "INVALID_INPUT", message: "storageKey is not a valid object key" } },
        { status: 400 },
      );
    }
    fileUrl = publicUrl(storageKey);
    recordedType = fileType ?? contentTypeFor(storageKey).replace(/^application\//, "");
  }

  const { prisma } = await import("@/lib/db");
  const expedition = await prisma.expedition.findUnique({
    where: { slug: expeditionSlug },
    select: { id: true, title: true, slug: true, leadScientist: true },
  });
  if (!expedition) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "No expedition with that slug" } },
      { status: 404 },
    );
  }

  // 1. The row exists before the classifier is consulted, so a slow or broken
  //    service cannot cost us the submission.
  const report = await prisma.report.create({
    data: {
      expeditionId: expedition.id,
      title,
      abstract,
      fileUrl,
      fileType: recordedType,
      uploadedById: user.id,
      status: "draft",
    },
    select: { id: true, title: true, createdAt: true, fileUrl: true, fileType: true },
  });

  // 2 + 3. Classify with a sourceId so the service writes the ClassificationLog.
  let prediction = null;
  let taggingPending = true;
  if (autoTag) {
    const outcome = await classify({
      text: `${title}\n\n${abstract}`,
      sourceType: "Report",
      sourceId: report.id,
    });
    if (outcome.ok) {
      prediction = {
        predictedTags: outcome.result.predictedTags,
        confidenceScores: outcome.result.confidenceScores,
        modelVersion: outcome.result.modelVersion,
        latencyMs: Math.round(outcome.latencyMs),
      };
      // Empty predictedTags is a real answer ("nothing cleared the threshold"),
      // not a failure — but it still means no automatic tag was applied.
      taggingPending = outcome.result.predictedTags.length === 0;
    }
  }

  // 4. Pending draft for the review queue. Never auto-published: the
  //    `outreach_draft_published_requires_review` CHECK enforces that.
  let draftId: string | null = null;
  if (generateDraft) {
    const headline = `From ${expedition.title}: ${title}`;
    const draft = await prisma.outreachDraft.create({
      data: {
        sourceType: "Report",
        sourceId: report.id,
        reportId: report.id,
        draftText: [
          headline,
          "",
          abstract,
          "",
          `— ${expedition.leadScientist}, ${expedition.title} (NCPOR)`,
        ].join("\n"),
        draftCaption: headline.slice(0, 120),
        status: "pending_review",
        targetChannel: "website",
      },
      select: { id: true },
    });
    draftId = draft.id;
  }

  return NextResponse.json(
    {
      report,
      draftId,
      prediction,
      taggingPending,
      expedition: { title: expedition.title, slug: expedition.slug },
    },
    { status: 201 },
  );
}
