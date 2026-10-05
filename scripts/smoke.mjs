/**
 * End-to-end smoke test.
 *
 * Boots the production build against a live database and asserts that the app
 * actually serves pages and talks to Postgres. `tsc` and `next build` both pass
 * on a machine with no database at all, so neither of them proves the wiring
 * works — this does.
 *
 *   npm run db:migrate && npm run db:seed && npm run smoke
 *
 * Or, without Docker:
 *   node scripts/with-db.mjs -- npm run smoke
 */

import { spawn } from "node:child_process";
import process from "node:process";

const PORT = Number(process.env.SMOKE_PORT ?? 3100);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`, { cache: "no-store" });
      if (res.status === 200 || res.status === 503) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const server = spawn("npx", ["next", "start", "--port", String(PORT)], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(PORT) },
});

let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

async function shutdown() {
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));
  server.kill("SIGKILL");
}

try {
  console.log("\nIndoPolaris — smoke test\n");

  const up = await waitForServer();
  if (!up) {
    console.log("  FAIL  server never became reachable");
    console.log(serverLog.slice(-2000));
    failures++;
  } else {
    // --- health ----------------------------------------------------------
    const health = await fetch(`${BASE}/api/health`, { cache: "no-store" });
    const body = await health.json();

    check("GET /api/health returns 200", health.status === 200, `got ${health.status}`);
    check("database check passes", body.checks?.database?.ok === true, JSON.stringify(body.checks?.database));
    check("search function is installed", body.checks?.search?.ok === true, JSON.stringify(body.checks?.search));
    check(
      "health reports the seeded expedition count",
      Number(body.checks?.database?.detail?.split(" ")[0]) >= 4,
      `detail: ${body.checks?.database?.detail}`,
    );
    check("status is ok", body.status === "ok", body.status);

    const expeditionCount = Number(body.checks?.database?.detail?.split(" ")[0]);

    // --- home page -------------------------------------------------------
    const home = await fetch(BASE, { cache: "no-store" });
    const html = await home.text();

    check("GET / returns 200", home.status === 200, `got ${home.status}`);
    check("page title is set", html.includes("IndoPolaris"), "expected the wordmark in <title>");
    check("tagline renders", html.includes("India") && html.includes("Window to the Poles"));
    // Parse the counter out of the rendered <dt>/<dd> pair instead of testing
    // `html.includes("4")`. The loose version passed against a database holding
    // zero expeditions, because a "4" appears in a year, a hex colour and a
    // stroke-width — so the check could not fail for the reason it exists.
    // React's SSR text markers (`<!-- -->`) are allowed for between the tags.
    const counter = html.match(
      /Expeditions\s*(?:<!--[\s\S]*?-->)?\s*<\/dt>\s*<dd[^>]*>\s*(?:<!--[\s\S]*?-->)?\s*(\d+)/,
    );
    check(
      "the expedition counter is rendered",
      counter !== null,
      "could not find the Expeditions <dt>/<dd> pair in the HTML",
    );
    check(
      "the counter reflects the database, not the build",
      counter !== null && Number(counter[1]) === expeditionCount,
      `page shows ${counter?.[1]}, /api/health reports ${expeditionCount}`,
    );
    check(
      "the counter reflects seeded data",
      counter !== null && Number(counter[1]) >= 4,
      `expected at least 4 seeded expeditions, got ${counter?.[1]}`,
    );
    check("document declares a language", /<html[^>]+lang="en"/.test(html), "missing lang attribute");

    // --- accessibility floor --------------------------------------------
    // Not a substitute for the Phase 7 audit, but a cheap regression guard on
    // the two things Section 6 calls out most strongly.
    const noAlt = [...html.matchAll(/<img\b[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => !/\balt=/.test(tag));
    check("every <img> has an alt attribute", noAlt.length === 0, noAlt.join("\n        "));

    // --- 404 -------------------------------------------------------------
    const missing = await fetch(`${BASE}/definitely-not-a-page`, { cache: "no-store" });
    check("unknown route returns 404", missing.status === 404, `got ${missing.status}`);
  }
} finally {
  await shutdown();
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
