import { NextResponse } from "next/server";
import { z } from "zod";

import { ForbiddenError, requireUser } from "@/lib/session";
import { buildStorageKey, isLocalDriver, putObject, storageDriver } from "@/lib/storage";

/**
 * `POST /api/studio/upload` — store an upload and hand back a key.
 *
 * Separate from `/api/studio/ingest` on purpose. Storage is the one step that can
 * fail for reasons unrelated to the database (S3 down, disk full), and keeping it
 * on its own route means the client can retry a failed upload without creating a
 * second `Report`. The ingest route then accepts the returned `storageKey` and
 * derives `fileUrl` itself — the browser never gets to name its own URL.
 */
export const runtime = "nodejs";

const MAX_BYTES = 25 * 1024 * 1024;

/** Research documents and images. Anything else is refused rather than stored. */
const ALLOWED = new Map<string, string>([
  ["application/pdf", "pdf"],
  ["text/csv", "csv"],
  ["text/plain", "txt"],
  ["application/json", "json"],
  ["application/x-netcdf", "netcdf"],
  ["application/octet-stream", "binary"],
  ["image/png", "png"],
  ["image/jpeg", "jpeg"],
  ["image/webp", "webp"],
]);

const RESULT = z.object({
  fileUrl: z.string().min(1),
  storageKey: z.string().min(1),
  fileType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  driver: z.enum(["s3", "local"]),
});

export async function POST(request: Request) {
  const user = await requireUser("contributor").catch((error: unknown) => {
    if (error instanceof ForbiddenError) return null;
    throw error;
  });
  if (!user) {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Uploading requires the contributor role" } },
      { status: 403 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_INPUT", message: "Expected multipart/form-data" } },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: { code: "INVALID_INPUT", message: "Missing `file` field" } },
      { status: 400 },
    );
  }

  if (file.size === 0) {
    return NextResponse.json(
      { error: { code: "INVALID_INPUT", message: "File is empty" } },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_INPUT",
          message: `File is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 25 MB`,
        },
      },
      { status: 413 },
    );
  }

  const declared = file.type || "application/octet-stream";
  const fileType = ALLOWED.get(declared);
  if (!fileType) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_INPUT",
          message: `Unsupported content type "${declared}". Allowed: ${[...ALLOWED.keys()].join(", ")}`,
        },
      },
      { status: 415 },
    );
  }

  const body = Buffer.from(await file.arrayBuffer());
  const key = buildStorageKey("reports", file.name);

  let fileUrl: string;
  try {
    fileUrl = await putObject({ key, body, contentType: declared, size: body.byteLength });
  } catch (error) {
    // Surface the driver failure rather than a generic 500 — "S3 unreachable"
    // and "permission denied" are different bugs and the log should say which.
    return NextResponse.json(
      {
        error: {
          code: "STORAGE_UNAVAILABLE",
          message: error instanceof Error ? error.message : "storage write failed",
          driver: storageDriver(),
        },
      },
      { status: 503 },
    );
  }

  return NextResponse.json(
    RESULT.parse({
      fileUrl,
      storageKey: key,
      fileType,
      sizeBytes: body.byteLength,
      driver: isLocalDriver() ? "local" : "s3",
    }),
    { status: 201 },
  );
}
