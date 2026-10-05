/**
 * Run a command against a throwaway PGlite database, then tear it down.
 *
 *   node scripts/with-db.mjs -- npm run db:migrate
 *   node scripts/with-db.mjs -- npm run db:seed
 *
 * Intended for CI and for machines without Docker. If a Postgres is already
 * listening on the port (e.g. the docker-compose `db` service), this script
 * uses that instead and never starts PGlite — so it degrades gracefully rather
 * than fighting an existing server.
 */

import { spawn } from "node:child_process";
import net from "node:net";
import process from "node:process";

import { config } from "dotenv";

// Load .env so the child inherits DATABASE_URL. Without this, any command
// wrapped here silently runs with no database configured — Prisma's CLI reads
// .env itself, but the Python service, the training scripts and the bandit
// simulator do not, and they would fall back to a uniform prior or skip their
// DB writes while still exiting 0. Explicit process env still wins.
config({ quiet: true });

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep === -1 || sep === argv.length - 1) {
  console.error("usage: node scripts/with-db.mjs -- <command> [args...]");
  process.exit(2);
}
const command = argv.slice(sep + 1);

const port = Number(process.env.PGLITE_PORT ?? 5432);
const host = process.env.PGLITE_HOST ?? "127.0.0.1";

function ping() {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

let pglite = null;

async function waitForPort(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

if (await ping()) {
  console.log(`[with-db] Postgres already listening on ${host}:${port} — using it.`);
} else {
  console.log(`[with-db] no server on ${host}:${port}, starting PGlite…`);
  pglite = spawn(process.execPath, ["scripts/pglite-server.mjs", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  pglite.stdout.on("data", (d) => process.stdout.write(`  ${d}`));
  pglite.stderr.on("data", (d) => process.stderr.write(`  ${d}`));
  pglite.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[with-db] PGlite exited early with code ${code}`);
      process.exit(code);
    }
  });
  if (!(await waitForPort(90_000))) {
    console.error("[with-db] timed out waiting for PGlite to accept connections");
    pglite.kill("SIGKILL");
    process.exit(1);
  }
}

const child = spawn(command[0], command.slice(1), {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: process.env,
});

const code = await new Promise((resolve) => {
  child.on("exit", (c, signal) => resolve(signal ? 1 : (c ?? 1)));
  process.on("SIGINT", () => child.kill("SIGINT"));
});

if (pglite) {
  pglite.kill("SIGTERM");
  // Give it a moment to flush the data directory to disk.
  await new Promise((r) => setTimeout(r, 1500));
  pglite.kill("SIGKILL");
}

process.exit(code);
