import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "minio";

import { env } from "@/lib/env";

/**
 * Object storage, with a local filesystem driver.
 *
 * Production and docker-compose use S3/MinIO through the `minio` client. But a
 * local prototype should not require a running S3 daemon just to save one
 * uploaded file, so when `STORAGE_DRIVER=local` (or S3 is unreachable) writes
 * land under `.local-storage/` and are served by `GET /api/media/[...key]`.
 *
 * The driver choice is deliberately explicit rather than a silent
 * connect-and-fallback: a mid-request switch from S3 to disk would leave
 * objects in two places, and `MediaAsset.url` already records which base URL
 * an object was written under. See `storageDriver()` for the resolution order.
 *
 * Seeded media never touches either driver — `npm run media:placeholders`
 * writes SVGs into `public/media/seed/`, which Next serves statically.
 */

const globalForMinio = globalThis as unknown as {
  minio: Client | undefined;
};

function createClient(): Client {
  const e = env();
  const url = new URL(e.S3_ENDPOINT);
  return new Client({
    // `hostname`, not `host`: minio-js wants the host *without* the port and
    // rejects "localhost:9000" as an endpoint. Passing `.host` here made every
    // S3 write fail with InvalidEndpointError even under docker-compose.
    endPoint: url.hostname,
    port: Number(url.port || (e.S3_FORCE_PATH_STYLE ? 80 : 443)),
    useSSL: url.protocol === "https:",
    accessKey: e.S3_ACCESS_KEY_ID,
    secretKey: e.S3_SECRET_ACCESS_KEY,
    region: e.S3_REGION,
    pathStyle: e.S3_FORCE_PATH_STYLE,
  });
}

/**
 * The S3 client, created on first use and cached on `globalThis`.
 *
 * Deliberately lazy. Constructing it at module scope meant that merely importing
 * `storage.ts` — which the local driver never needs — could throw on a malformed
 * `S3_ENDPOINT`, turning a config mistake in a code path nobody is using into a
 * 500 on every upload route.
 */
export const minio: Client = new Proxy({} as Client, {
  get(_target, prop) {
    globalForMinio.minio ??= createClient();
    const client = globalForMinio.minio;
    const value = Reflect.get(client as object, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export const BUCKET = env().S3_BUCKET;

export type StorageDriver = "s3" | "local";

/** Root for the local driver. `.local-storage/` is gitignored. */
export const LOCAL_STORAGE_ROOT = path.resolve(process.cwd(), ".local-storage");

/**
 * Which driver to write with.
 *
 * `STORAGE_DRIVER` wins when set, so a demo can be pinned to disk even with a
 * MinIO running. Otherwise default to local whenever S3 is not configured —
 * that is the machine-without-Docker case. Never auto-switch per request.
 */
export function storageDriver(): StorageDriver {
  const explicit = process.env.STORAGE_DRIVER?.toLowerCase();
  if (explicit === "local" || explicit === "s3") return explicit;

  const configured = Boolean(
    process.env.S3_ENDPOINT &&
      process.env.S3_ACCESS_KEY_ID &&
      process.env.S3_SECRET_ACCESS_KEY &&
      process.env.S3_BUCKET,
  );
  return configured ? "s3" : "local";
}

export const isLocalDriver = (): boolean => storageDriver() === "local";

/**
 * Build the browser-facing URL for an object key.
 *
 * Under the local driver the key is served by this app's own route, so the URL
 * is app-relative. Under S3 it is `S3_PUBLIC_URL`-rooted.
 */
export function publicUrl(storageKey: string): string {
  if (isLocalDriver()) {
    return `/api/media/${storageKey.split("/").map(encodeURIComponent).join("/")}`;
  }
  const base = env().S3_PUBLIC_URL.replace(/\/+$/, "");
  return `${base}/${storageKey.split("/").map(encodeURIComponent).join("/")}`;
}

/** Ensure the S3 bucket exists. Idempotent; safe to call on every boot. */
export async function ensureBucket(): Promise<void> {
  if (isLocalDriver()) {
    await mkdir(LOCAL_STORAGE_ROOT, { recursive: true });
    return;
  }
  const exists = await minio.bucketExists(BUCKET).catch(() => false);
  if (!exists) {
    await minio.makeBucket(BUCKET, env().S3_REGION);
  }
}

export type PutObjectInput = {
  key: string;
  /** Buffer rather than Uint8Array: the minio client's body type is narrower
   *  than the DOM's, and widening it here would only move the cast. */
  body: Buffer;
  contentType: string;
  size?: number;
};

/**
 * Build a collision-free storage key.
 *
 * `randomUUID` because upload keys embed user-supplied slugs; two contributors
 * uploading `report.pdf` must not overwrite each other.
 */
export function buildStorageKey(kind: string, filename: string): string {
  const safe = filename
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-60);
  return `${kind}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${safe || "upload"}`;
}

/** Read the content type back off a stored local object. */
export function contentTypeFor(key: string): string {
  const ext = key.slice(key.lastIndexOf(".")).toLowerCase();
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".csv": "text/csv",
    ".nc": "application/x-netcdf",
    ".nc4": "application/x-netcdf",
    ".json": "application/json",
    ".txt": "text/plain; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Reject keys that would escape the storage root. */
export function isSafeStorageKey(key: string): boolean {
  if (!key || key.startsWith("/") || key.includes("..") || key.includes("\0")) {
    return false;
  }
  // Only the shapes this app generates: kind/date/uuid-filename.ext
  return /^[a-z0-9][a-z0-9/_-]*\.[a-z0-9]+$/i.test(key);
}

/** Upload an object, creating the bucket first if needed. */
export async function putObject(input: PutObjectInput): Promise<string> {
  await ensureBucket();

  if (isLocalDriver()) {
    const target = path.join(LOCAL_STORAGE_ROOT, input.key);
    if (!path.resolve(target).startsWith(LOCAL_STORAGE_ROOT + path.sep)) {
      throw new Error("refusing to write outside the local storage root");
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, input.body);
    return publicUrl(input.key);
  }

  await minio.putObject(
    BUCKET,
    input.key,
    input.body,
    input.size ?? input.body.byteLength,
    { "Content-Type": input.contentType },
  );
  return publicUrl(input.key);
}

/** Fetch an object as a Buffer. Used by the authenticated download route. */
export async function getObject(key: string): Promise<Buffer> {
  if (isLocalDriver()) {
    const target = path.join(LOCAL_STORAGE_ROOT, key);
    if (!path.resolve(target).startsWith(LOCAL_STORAGE_ROOT + path.sep)) {
      throw new Error("refusing to read outside the local storage root");
    }
    return readFile(target);
  }

  const stream = await minio.getObject(BUCKET, key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Stable id for a local object, used by the media route for ETag. */
export function localObjectEtag(key: string): string {
  return `"${createHash("sha1").update(key).digest("hex").slice(0, 16)}"`;
}
