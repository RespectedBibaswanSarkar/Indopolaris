/**
 * Tests for the Node -> ML client (`src/lib/ml.ts`).
 *
 * Focus is the logic the Python tests cannot reach: retry, backoff, timeout,
 * and — most importantly — the degradation contract. Section 6 requires that a
 * failing ML call never fails the surrounding upload; `classify()` returning
 * `ok: false` instead of throwing is what makes that true, and a regression
 * there is invisible to both `tsc` and the service's own test suite.
 *
 * Runs against a **stubbed global fetch**, not a live service, because the
 * behaviour under test is precisely what happens when there is no live service.
 *
 *   npm run test:ml-client
 *
 * `--conditions=react-server` is required because `src/lib/ml.ts` imports
 * `server-only`, which deliberately throws when resolved outside a React
 * Server Component environment.
 */

import assert from "node:assert/strict";
import test from "node:test";

/**
 * `src/lib/ml.ts` reads its configuration lazily — inside each request, not at
 * module load — so importing it before the env assignments below is safe. That
 * matters here because a top-level `await import()` would force this file to be
 * ESM, and the package is CommonJS.
 */
import { classify, mlHealth } from "../src/lib/ml";

/** Env the client reads through `src/lib/env.ts`. */
process.env.DATABASE_URL = "postgresql://indopolaris:pw@127.0.0.1:5432/indopolaris?schema=public";
process.env.S3_ENDPOINT = "http://127.0.0.1:9000";
process.env.S3_BUCKET = "indopolaris";
process.env.S3_ACCESS_KEY_ID = "x";
process.env.S3_SECRET_ACCESS_KEY = "y";
process.env.S3_PUBLIC_URL = "http://127.0.0.1:9000/indopolaris";
process.env.AUTH_SECRET = "test-secret-not-used-in-production";
process.env.ML_SERVICE_URL = "http://127.0.0.1:8000";
/**
 * Must be set here, before the first request, not inside the timeout test.
 * `src/lib/env.ts` memoises its parse on first use, so a value assigned later is
 * silently ignored — which looks exactly like "the timeout is not enforced".
 * A short timeout also keeps the suite from spending 10s on the two aborted
 * attempts the default would otherwise cause.
 */
process.env.ML_TIMEOUT_MS = "300";

const VALID_TEXT = "An acoustic profiler measured krill swarm abundance beneath the ice shelf.";

/** The subset of RequestInit the client actually uses. */
type ClientInit = RequestInit & {
  body: string;
  headers: Record<string, string>;
};

type StubCall = { url: string; init: ClientInit };

/**
 * Install a fetch stub and return a call log.
 * `handler` receives (url, init) and must return a Response or throw.
 */
function stubFetch(handler: (url: string, init: ClientInit) => Promise<Response>) {
  const calls: StubCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const recorded = init as ClientInit;
    calls.push({ url: String(input), init: recorded });
    return handler(String(input), recorded);
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const okClassify = {
  predictedTags: ["Biology / Ecology"],
  confidenceScores: {
    "Atmospheric & Space Science": 0.11,
    "Biology / Ecology": 0.62,
    "Data Science / Instrumentation": 0.15,
    "Logistics / Expedition-Ops": 0.05,
    "Outreach / Education / Policy": 0.07,
  },
  modelVersion: "v1",
};

test("classify returns a typed result on success", async () => {
  const stub = stubFetch(async () => new Response(JSON.stringify(okClassify), { status: 200 }));
  try {
    const outcome = await classify({ text: VALID_TEXT, sourceType: "Report" });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.deepEqual(outcome.result.predictedTags, ["Biology / Ecology"]);
      assert.equal(outcome.attempts, 1);
    }
  } finally {
    stub.restore();
  }
});

test("classify sends sourceId only when supplied", async () => {
  const stub = stubFetch(async () => new Response(JSON.stringify(okClassify), { status: 200 }));
  try {
    await classify({ text: VALID_TEXT, sourceType: "Report", sourceId: "abc123" });
    const body = JSON.parse(String(stub.calls[0].init.body));
    assert.equal(body.sourceId, "abc123");

    stub.calls.length = 0;
    await classify({ text: VALID_TEXT, sourceType: "Report" });
    const bare = JSON.parse(String(stub.calls[0].init.body));
    assert.equal("sourceId" in bare, false, "sourceId must be omitted, not null");
  } finally {
    stub.restore();
  }
});

test("classify rejects out-of-range text without touching the network", async () => {
  const stub = stubFetch(async () => {
    throw new Error("must not be called");
  });
  try {
    const outcome = await classify({ text: "   ", sourceType: "Report" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.unavailable, "invalid_input");
    assert.equal(stub.calls.length, 0, "no HTTP request should have been made");

    const tooLong = await classify({ text: "a".repeat(5001), sourceType: "Report" });
    assert.equal(tooLong.ok, false);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("classify does not retry a 503, and normalises the message", async () => {
  const stub = stubFetch(async () =>
    new Response(JSON.stringify({ error: { code: "MODEL_NOT_LOADED", message: "no artifact" } }), {
      status: 503,
    }),
  );
  try {
    const outcome = await classify({ text: VALID_TEXT, sourceType: "Report" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.unavailable, "model_not_loaded");
      assert.match(outcome.detail, /no model artifact loaded/i);
      assert.equal(
        outcome.detail.includes("no artifact"),
        false,
        "the upstream detail is not forwarded verbatim",
      );
    }
    // 503 is a dependency state, not a transport fault: a missing artifact will
    // not appear 250ms later, so retrying only doubles the wait.
    assert.equal(stub.calls.length, 1, "MODEL_NOT_LOADED must not be retried");
  } finally {
    stub.restore();
  }
});

test("classify retries once on a 500, then reports http_error", async () => {
  const stub = stubFetch(async () => new Response("boom", { status: 500 }));
  try {
    const outcome = await classify({ text: VALID_TEXT, sourceType: "Report" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.unavailable, "http_error");
    assert.equal(stub.calls.length, 2, "a 5xx should be retried exactly once");
  } finally {
    stub.restore();
  }
});

test("classify succeeds when the first attempt fails and the retry works", async () => {
  let attempt = 0;
  const stub = stubFetch(async () => {
    attempt++;
    if (attempt === 1) return new Response("flaky", { status: 502 });
    return new Response(JSON.stringify(okClassify), { status: 200 });
  });
  try {
    const outcome = await classify({ text: VALID_TEXT, sourceType: "Report" });
    assert.equal(outcome.ok, true);
    assert.equal(attempt, 2);
  } finally {
    stub.restore();
  }
});

test("classify does not retry a 422", async () => {
  const stub = stubFetch(async () =>
    new Response(JSON.stringify({ error: { code: "INVALID_INPUT", message: "text too long" } }), {
      status: 422,
    }),
  );
  try {
    const outcome = await classify({ text: VALID_TEXT, sourceType: "Report" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.unavailable, "invalid_input");
      assert.match(outcome.detail, /text too long/);
    }
    assert.equal(stub.calls.length, 1, "a malformed payload will be malformed again");
  } finally {
    stub.restore();
  }
});

test("classify degrades to network on connection failure — never throws", async () => {
  const stub = stubFetch(async () => {
    const error = new TypeError("fetch failed");
    error.cause = { code: "ECONNREFUSED" };
    throw error;
  });
  try {
    const outcome = await classify({ text: VALID_TEXT, sourceType: "Report" });
    assert.equal(outcome.ok, false, "classify() must never throw when the service is down");
    if (!outcome.ok) assert.equal(outcome.unavailable, "network");
    assert.equal(stub.calls.length, 2, "connection failure should be retried once");
  } finally {
    stub.restore();
  }
});

test("classify reports a timeout distinctly from a network error", async () => {
  const stub = stubFetch(async (_url, init) => {
    // Never settle on its own; only the client's AbortSignal ends it. This is
    // what a hung service actually looks like.
    const { signal } = init;
    assert.ok(signal, "every client attempt must pass an AbortSignal");
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  });
  try {
    const outcome = await classify({ text: VALID_TEXT, sourceType: "Report" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.unavailable, "timeout");
      assert.match(outcome.detail, /did not respond within 300ms/);
    }
    assert.equal(stub.calls.length, 2, "a timeout should be retried once");
  } finally {
    stub.restore();
  }
});

test("classify rejects a malformed 200 body instead of trusting it", async () => {
  const cases: Array<[string, unknown]> = [
    ["missing confidenceScores", { predictedTags: [], modelVersion: "v1" }],
    ["confidence out of range", { ...okClassify, confidenceScores: { "Biology / Ecology": 2.83 } }],
    ["NaN confidence", { ...okClassify, confidenceScores: { "Biology / Ecology": NaN } }],
    ["predictedTags not an array", { ...okClassify, predictedTags: "Biology" }],
    ["not an object", "a string"],
  ];

  for (const [label, body] of cases) {
    const stub = stubFetch(async () => new Response(JSON.stringify(body), { status: 200 }));
    try {
      const outcome = await classify({ text: VALID_TEXT, sourceType: "Report" });
      assert.equal(outcome.ok, false, `${label} should not be accepted`);
      if (!outcome.ok) assert.equal(outcome.unavailable, "malformed_response", label);
    } finally {
      stub.restore();
    }
  }
});

test("classify accepts an empty predictedTags list", async () => {
  // A confident "no tag" is a valid answer, not an error: the caller degrades the
  // record to tagging pending rather than attaching a weak guess.
  const stub = stubFetch(async () =>
    new Response(JSON.stringify({ ...okClassify, predictedTags: [] }), { status: 200 }),
  );
  try {
    const outcome = await classify({ text: VALID_TEXT, sourceType: "Report" });
    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.deepEqual(outcome.result.predictedTags, []);
  } finally {
    stub.restore();
  }
});

test("classify propagates a request id for cross-service tracing", async () => {
  const stub = stubFetch(async () => new Response(JSON.stringify(okClassify), { status: 200 }));
  try {
    await classify({ text: VALID_TEXT, sourceType: "Report" });
    const header = stub.calls[0].init.headers["X-Request-ID"];
    assert.ok(header, "an X-Request-ID header should always be sent");
  } finally {
    stub.restore();
  }
});

test("mlHealth reports unreachable without throwing", async () => {
  const stub = stubFetch(async () => {
    throw new TypeError("fetch failed");
  });
  try {
    const health = await mlHealth();
    assert.equal(health.reachable, false);
    assert.ok(health.detail.length > 0);
  } finally {
    stub.restore();
  }
});

test("mlHealth forwards a degraded-but-reachable service", async () => {
  const stub = stubFetch(async () =>
    new Response(
      JSON.stringify({
        status: "degraded",
        modelLoaded: false,
        modelVersion: null,
        checks: { model: { ok: false, detail: "artifact not found" } },
      }),
      { status: 200 },
    ),
  );
  try {
    const health = await mlHealth();
    assert.equal(health.reachable, true, "reachable is about the hop, not the model");
    assert.equal(health.modelLoaded, false);
    assert.equal(health.status, "degraded");
  } finally {
    stub.restore();
  }
});

test("mlHealth rejects a nonsense 200 body", async () => {
  const stub = stubFetch(async () => new Response(JSON.stringify({ hello: "world" }), { status: 200 }));
  try {
    const health = await mlHealth();
    assert.equal(health.reachable, false);
    assert.match(health.detail, /unexpected \/health body/);
  } finally {
    stub.restore();
  }
});
