/**
 * End-to-end smoke test for the Node -> ML integration (Phase 2).
 *
 * Why this exists alongside the Python tests: those assert the service's own
 * contract, and typechecking asserts the generated types match the schema they
 * came from. Neither proves the two sides agree on the *wire* — status codes,
 * degradation, timeouts. Only a real call across the boundary does.
 *
 * Two passes, because the interesting half of Section 6 is what happens when the
 * ML service is not there:
 *
 *   Pass 1  ML service up    -> /api/ml/health reports the loaded model version
 *   Pass 2  ML service down  -> /api/ml/health still answers, with 503
 *
 * A naive test only ever runs the first pass, which is precisely the state that
 * works in development and fails in production.
 *
 *   npm run bootstrap            # once: venv, corpus, model
 *   npm run ml:serve &           # terminal 1
 *   npm run build && npm run smoke:ml
 */

import { spawn } from "node:child_process";
import process from "node:process";

const PORT = Number(process.env.ML_SMOKE_PORT ?? 3101);
const ML_URL = process.env.ML_SERVICE_URL ?? "http://127.0.0.1:8000";
/** A reserved, never-listening port. Connection refused, deterministically. */
const DEAD_ML_URL = "http://127.0.0.1:1";

let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

async function waitForServer(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { cache: "no-store" });
      if (res.status === 200 || res.status === 503) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function waitForMlService(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ML_URL}/health`, { cache: "no-store", signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Resolve once a child has actually exited, so the port is free for the next pass. */
function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Boot the built app once against a given ML service URL, on its own port.
 *
 * A distinct port per pass is load-bearing, not tidiness: `next start` releases
 * its port asynchronously, so reusing one lets pass 2's `waitForServer` find
 * pass 1's still-dying process and silently assert against the *previous*
 * configuration — which is how a degradation test ends up passing for the wrong
 * reason.
 */
async function withServer(mlServiceUrl, port, fn) {
  const base = `http://127.0.0.1:${port}`;
  const server = spawn("npx", ["next", "start", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), ML_SERVICE_URL: mlServiceUrl },
  });

  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));

  try {
    if (!(await waitForServer(port))) {
      console.log("  FAIL  server never became reachable");
      console.log(log.slice(-2000));
      failures++;
      return;
    }
    await fn(base);
  } finally {
    server.kill("SIGTERM");
    await waitForExit(server);
    server.kill("SIGKILL");
  }
}

async function main() {
  console.log(`\nIndoPolaris — ML integration smoke test\n`);

  if (!(await waitForMlService())) {
    console.log(`  FAIL  ml-service is not reachable at ${ML_URL}`);
    console.log("        start it with:  npm run ml:serve");
    process.exit(1);
  }

  // ---- pass 1: ML service reachable --------------------------------------
  console.log(`  pass 1 — ML service up at ${ML_URL}`);
  await withServer(ML_URL, PORT, async (base) => {
    const response = await fetch(`${base}/api/ml/health`, { cache: "no-store" });
    const body = await response.json();

    check("GET /api/ml/health returns 200", response.status === 200, `got ${response.status}`);
    check("proxy reports the service reachable", body.reachable === true, JSON.stringify(body));
    check("proxy reports the model loaded", body.modelLoaded === true, JSON.stringify(body));
    check(
      "proxy reports the model version",
      body.modelVersion === "v1",
      `got ${JSON.stringify(body.modelVersion)}`,
    );
    check("status is ok", body.status === "ok", body.status);
    check(
      "upstream model check is forwarded",
      body.checks?.model?.ok === true,
      JSON.stringify(body.checks),
    );
    check(
      "latency is reported in ms",
      typeof body.latencyMs === "number" && body.latencyMs >= 0,
      `got ${JSON.stringify(body.latencyMs)}`,
    );
  });

  // ---- pass 2: ML service unreachable -------------------------------------
  const DEAD_PORT = PORT + 1;
  console.log(`\n  pass 2 — ML service down at ${DEAD_ML_URL}`);
  await withServer(DEAD_ML_URL, DEAD_PORT, async (base) => {
    const startedAt = performance.now();
    const response = await fetch(`${base}/api/ml/health`, { cache: "no-store" });
    const elapsed = performance.now() - startedAt;
    const body = await response.json();

    // The contract: answer 503 with a readable reason, promptly. A 500 here
    // would mean the error escaped as an exception; a hang would mean the
    // timeout is not wired up.
    check("GET /api/ml/health returns 503, not 500", response.status === 503, `got ${response.status}`);
    check("proxy reports the service unreachable", body.reachable === false, JSON.stringify(body));
    check("status is degraded", body.status === "degraded", body.status);
    check(
      "the reason is actionable, not empty",
      typeof body.detail === "string" && body.detail.length > 0,
      `got ${JSON.stringify(body.detail)}`,
    );
    check(
      "connection refused rather than a timeout",
      /ECONNREFUSED|fetch failed|refused/i.test(body.detail),
      `expected a refusal message, got: ${body.detail}`,
    );
    // 2 attempts x (connect-fail) + 250ms backoff. Generous ceiling that still
    // catches a client that ignored the AbortSignal entirely.
    check(
      "fails fast instead of hanging",
      elapsed < 10_000,
      `took ${Math.round(elapsed)}ms`,
    );
  });

  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nsmoke-ml error:", error);
  process.exit(1);
});
