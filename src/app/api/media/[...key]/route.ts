import { NextResponse } from "next/server";

import {
  contentTypeFor,
  getObject,
  isLocalDriver,
  isSafeStorageKey,
} from "@/lib/storage";

/**
 * `GET /api/media/[...key]` — serve locally-stored uploads.
 *
 * Only used by the local storage driver. Under S3 the browser fetches objects
 * straight from the bucket and this route never sees a request.
 *
 * `force-dynamic`: the file is read from disk per request, so nothing here may
 * be prerendered or cached by the build.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const { key: segments } = await params;
  const key = segments.map(decodeURIComponent).join("/");

  if (!isLocalDriver()) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Local storage is not the active driver" } },
      { status: 404 },
    );
  }

  if (!isSafeStorageKey(key)) {
    return NextResponse.json(
      { error: { code: "INVALID_INPUT", message: "Malformed storage key" } },
      { status: 400 },
    );
  }

  try {
    const body = await getObject(key);
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": contentTypeFor(key),
        "Content-Length": String(body.byteLength),
        // Immutable: keys embed a UUID, so the bytes at a key never change.
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "No such object" } },
      { status: 404 },
    );
  }
}
