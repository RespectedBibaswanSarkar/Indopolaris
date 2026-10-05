/**
 * Zero-dependency Postgres for local development, for machines without Docker.
 *
 * PGlite is real PostgreSQL (compiled to WASM) running in-process. The
 * `pglite-socket` adapter exposes it on a TCP port speaking the Postgres wire
 * protocol, so `psql`, the Prisma CLI and `@prisma/client` all connect to it
 * exactly as they would to the `db` service in docker-compose.yml. Nothing in
 * the application needs to know which one it is talking to.
 *
 * This is a development convenience only. It is single-connection and
 * single-process: do not deploy it.
 *
 *   node scripts/pglite-server.mjs
 *   # -> postgresql://postgres:postgres@127.0.0.1:5432/indopolaris
 *
 * Flags:
 *   --port <n>      listen port           (default 5432)
 *   --data-dir <p>  persistence directory (default .pglite)
 *   --fresh         delete the data dir before starting
 */

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const argv = process.argv.slice(2);

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) return true;
  return next;
}

const port = Number(flag("port", 5432));
const host = String(flag("host", "127.0.0.1"));
const dataDir = path.resolve(String(flag("data-dir", ".pglite")));

if (argv.includes("--fresh")) {
  await rm(dataDir, { recursive: true, force: true });
  console.log(`[pglite] removed ${dataDir}`);
}

await mkdir(dataDir, { recursive: true });

console.log(`[pglite] opening data dir ${dataDir}`);
const db = await PGlite.create({ dataDir });

// PGlite ships as a single database named by the connection; create the
// application database on first boot so DATABASE_URL can always name it.
const { rows: dbs } = await db.query(
  "SELECT datname FROM pg_database WHERE datname = 'indopolaris'",
);
if (dbs.length === 0) {
  // CREATE DATABASE cannot run inside a transaction block, and PGlite's
  // default `db` handle is autocommit, so this is safe.
  await db.exec("CREATE DATABASE indopolaris");
  console.log("[pglite] created database `indopolaris`");
}

// `prisma migrate dev` opens a second connection for its shadow database, so the
// library default of 1 is not enough.
const server = new PGLiteSocketServer({ db, port, host, maxConnections: 16 });
await server.start();
console.log(`[pglite] listening on ${host}:${port} (db: indopolaris)`);
console.log("[pglite] ready — run `npm run db:migrate` in another terminal");

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[pglite] ${signal} received, flushing and closing…`);
  try {
    await server.stop();
    await db.close();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
