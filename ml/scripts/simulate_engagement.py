#!/usr/bin/env python3
"""
Drive the bandit end-to-end against a live database and show it learning.

This is the real-time layer, and the point of the script is to make that
*visible*. It alternates `GET /recommend` and `POST /feedback` against a running
service, each feedback carrying a click-through rate drawn from the arm's
*true* hidden CTR, and prints the running mean reward per 25 pulls.

The learning curve that matters is not "reward goes up" — it is
**"reward goes up while the bandit concentrates its pulls on the arms that
actually perform."** Both are printed, and the concentration figure is the one
that distinguishes a working bandit from a lucky run:

  * A uniform-policy bandit also shows a rising reward curve when the environment
    is stationary, because the average of all arms is better than the average of
    a bad arm. Reward alone cannot tell them apart.
  * A bandit that has learned puts most of its pulls on the top arms.
    `pull_share` at the end is what proves it.

Ground truth is a fixed table of hidden CTRs, two good and seven bad, with
noise. The truth is printed up front, so the run can be checked by reading
rather than by trusting the summary.

Every event is written with `isSimulated: true`, which Section 6 requires so
synthetic feedback is permanently separable from real analytics. A simulator
that wrote indistinguishable rows would quietly poison any later analysis of
outreach performance.

Usage:
    # against a running service (see --base-url)
    ml/.venv/bin/python ml/scripts/simulate_engagement.py --base-url http://127.0.0.1:8000

    # or in-process, no HTTP at all — exercises the same code paths
    ml/.venv/bin/python ml/scripts/simulate_engagement.py --in-process
"""

from __future__ import annotations

import argparse
import os
import random
import sys
import time
from collections import defaultdict

ML_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ML_DIR)

from app import bandit  # noqa: E402

#: The hidden ground truth the environment generates rewards from.
#:
#: Deliberately not uniform and not sorted to match the channel order: if the
#: best arms were `website_*` the bandit could look correct by accident. Two
#: good arms in different channels and different slots forces it to actually
#: search.
TRUE_CTR: dict[str, float] = {
    "instagram_morning": 0.18,
    "twitter_afternoon": 0.15,
    "website_morning": 0.11,
    "instagram_afternoon": 0.045,
    "twitter_morning": 0.040,
    "website_afternoon": 0.035,
    "website_evening": 0.030,
    "twitter_evening": 0.028,
    "instagram_evening": 0.025,
}

#: Binomial noise. Enough that an arm's observed CTR tracks its true CTR within a
#: couple of points over a few hundred pulls, without being so small that the
#: bandit is just following a lookup table.
IMPRESSIONS_RANGE = (200, 1200)


def true_ctr(arm: str) -> float:
    return TRUE_CTR.get(arm, 0.05)


def sample_clicks(arm: str, rng: random.Random) -> tuple[int, int]:
    """One (impressions, clicks) observation from the arm's true CTR."""
    impressions = rng.randint(*IMPRESSIONS_RANGE)
    clicks = sum(1 for _ in range(impressions) if rng.random() < true_ctr(arm))
    # The SQL CHECK requires clicks <= impressions, which binomial sampling cannot
    # violate — but the clamp documents that the invariant is load-bearing.
    return impressions, min(clicks, impressions)


# ---------------------------------------------------------------------------
# Transports: HTTP against a live service, or in-process
# ---------------------------------------------------------------------------


class HttpTransport:
    """Talks to a running ml-service over HTTP — the real deployment path."""

    def __init__(self, base_url: str) -> None:
        import httpx2

        self._client = httpx2.Client(base_url=base_url.rstrip("/"), timeout=15.0)

    def recommend(self, seed_header: str) -> dict:
        response = self._client.get(
            "/recommend", headers={"X-Request-ID": seed_header}
        )
        response.raise_for_status()
        return response.json()

    def feedback(self, draft_id: str, arm: str, impressions: int, clicks: int) -> dict:
        channel, time_slot = bandit.parse_arm(arm)
        response = self._client.post(
            "/feedback",
            json={
                "draftId": draft_id,
                "channel": channel,
                "timeSlot": time_slot,
                "impressions": impressions,
                "clicks": clicks,
                "isSimulated": True,
            },
        )
        response.raise_for_status()
        return response.json()

    def close(self) -> None:
        self._client.close()


class InProcessTransport:
    """
    Calls the same functions the routes call, with no socket in between.

    Useful when no service is running: it still exercises `load_arms`,
    `select_arm`, `update_posterior` and `db.record_feedback`, so the posterior
    genuinely moves. It does *not* exercise FastAPI validation or the HTTP
    response shapes, which is why `--base-url` is the default and this is not.
    """

    def __init__(self) -> None:
        from app import db

        self._db = db

    def recommend(self, seed_header: str) -> dict:
        arms = bandit.load_arms()
        chosen, samples = bandit.select_arm(arms, seed=abs(hash(seed_header)))
        return {
            "arm": chosen.arm,
            "channel": chosen.channel,
            "timeSlot": chosen.time_slot,
            "exploration": samples[chosen.arm],
            "expectedReward": chosen.mean,
        }

    def feedback(self, draft_id: str, arm: str, impressions: int, clicks: int) -> dict:
        channel, time_slot = bandit.parse_arm(arm)
        recorded = self._db.record_feedback(
            outreach_draft_id=draft_id,
            channel=channel,
            time_slot=time_slot,
            impressions=impressions,
            clicks=clicks,
            is_simulated=True,
        )
        updated = next(
            (a for a in bandit.load_arms() if a.arm == arm),
            bandit.Arm(arm, 1.0, 1.0, 0, 0.0),
        )
        return {
            "recorded": recorded,
            "arm": arm,
            "reward": (clicks / impressions) if impressions else 0.0,
            "alpha": updated.alpha,
            "beta": updated.beta,
            "mean": updated.mean,
            "totalPulls": updated.total_pulls,
        }


# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------


def run(transport, *, steps: int, seed: int, draft_id: str, report_every: int) -> dict:
    rng = random.Random(seed)

    rewards: list[float] = []
    pulls: dict[str, int] = defaultdict(int)
    unrecorded = 0

    print(f"\nRunning {steps:,} recommend → feedback cycles (seed={seed})\n")
    print(f"{'step':>7}  {'reward':>8}  {'run avg':>8}  {'top arm':>22}  {'p95':>6}")
    print("-" * 62)

    for step in range(1, steps + 1):
        recommendation = transport.recommend(f"sim-{seed}-{step}")
        arm = recommendation["arm"]
        impressions, clicks = sample_clicks(arm, rng)

        result = transport.feedback(draft_id, arm, impressions, clicks)
        if not result.get("recorded", True):
            unrecorded += 1

        reward = clicks / impressions if impressions else 0.0
        rewards.append(reward)
        pulls[arm] += 1

        if step % report_every == 0 or step == steps:
            running = sum(rewards) / len(rewards)
            leader = max(pulls, key=lambda k: pulls[k])
            ordered = sorted(rewards)
            p95 = ordered[int(len(ordered) * 0.95)]
            print(
                f"{step:7,d}  {reward:8.4f}  {running:8.4f}  {leader:>22}  {p95:6.4f}"
            )

    curve = bandit.learning_curve(rewards)
    return {
        "rewards": rewards,
        "curve": curve,
        "pulls": dict(pulls),
        "unrecorded": unrecorded,
        "final_mean": curve[-1] if curve else 0.0,
    }


def report(result: dict, transport, steps: int) -> None:
    pulls: dict[str, int] = result["pulls"]
    curve: list[float] = result["curve"]

    # Halfway vs final: a rising curve is only meaningful if the slope is
    # positive. Compare the first and last thirds, which is robust to the noise
    # in any single window.
    third = max(1, len(curve) // 3)
    early = sum(curve[:third]) / third
    late = sum(curve[-third:]) / third

    print("\n" + "=" * 72)
    print("Result")
    print("=" * 72)
    print(f"  mean reward, first third   {early:.4f}")
    print(f"  mean reward, last third    {late:.4f}")
    print(f"  improvement                {late - early:+.4f}")
    print(f"  unrecorded feedback rows   {result['unrecorded']}")
    print()

    print("  Pull share by arm (true CTR in brackets):")
    ordered = sorted(pulls.items(), key=lambda kv: -kv[1])
    for arm, n in ordered:
        share = n / steps
        bar = "#" * int(round(share * 40))
        print(f"    {arm:22s} {n:5,d}  {share:5.1%}  [{true_ctr(arm):.3f}]  {bar}")

    # Concentration: what fraction of pulls went to the two genuinely best arms.
    # This, not the reward curve, is what proves the bandit searched.
    best_two = sorted(TRUE_CTR, key=lambda k: -TRUE_CTR[k])[:2]
    concentration = sum(pulls.get(a, 0) for a in best_two) / steps
    print()
    print(f"  best two arms {', '.join(best_two)} took {concentration:.1%} of pulls")
    print(f"  (uniform would be 22.2%)")
    print()

    # Posterior vs truth: the learned belief, and whether it is right.
    #
    # This section is only meaningful if we can read the posteriors back. Over
    # HTTP the feedback is written by the *service*, which has its own
    # DATABASE_URL; this process may have none (`npm run ml:simulate` does not
    # load .env). `load_arms` then returns the uniform prior and the table below
    # would print 9 rows of 0.5000 and 0 pulls — indistinguishable from a real
    # result that learned nothing. So say which it is.
    arms = bandit.load_arms()
    learned = sum(a.total_pulls for a in arms) > 0

    if learned:
        print("  Learned posterior vs truth:")
        print(f"    {'arm':22s} {'pulls':>6} {'posterior':>10} {'observed':>9} {'true':>7}  95% CI")
        rows = []
        for arm_obj in sorted(arms, key=lambda a: -a.mean):
            truth = true_ctr(arm_obj.arm)
            lo, hi = bandit.wilson_interval(arm_obj.total_reward, arm_obj.total_pulls)
            rows.append(
                f"    {arm_obj.arm:22s} {arm_obj.total_pulls:6d} {arm_obj.mean:10.4f} "
                f"{arm_obj.observed_mean:9.4f} {truth:7.3f}  [{lo:.3f}, {hi:.3f}]"
            )
        print("\n".join(rows))
    else:
        print("  Posterior vs truth: SKIPPED — could not read BanditArmState.")
        print("    The pull-share table above is from this run's own counters and is")
        print("    still valid; the posteriors themselves live in Postgres and were")
        print("    written by the service. To see them here, export DATABASE_URL and")
        print("    re-run, or query the table directly.")
    print("=" * 72, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", help="ml-service base URL, e.g. http://127.0.0.1:8000")
    parser.add_argument(
        "--in-process",
        action="store_true",
        help="call the bandit functions directly instead of over HTTP",
    )
    parser.add_argument("--steps", type=int, default=900, help="recommend/feedback cycles")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument(
        "--report-every", type=int, default=25, help="progress line interval"
    )
    parser.add_argument(
        "--draft-id",
        default="sim-draft-0000",
        # EngagementEvent has a non-null FK to OutreachDraft, so the id must be
        # a real draft row. The seed data creates some; this is the documented
        # one to use against a seeded database.
        help="OutreachDraft.id to attach synthetic events to",
    )
    args = parser.parse_args()

    if not args.in_process and not args.base_url:
        parser.error("pass --base-url or --in-process")

    print("IndoPolaris — bandit engagement simulation")
    print("=" * 72)
    print("\nHidden ground-truth CTRs the environment rewards from:")
    for arm, ctr in sorted(TRUE_CTR.items(), key=lambda kv: -kv[1]):
        print(f"    {ctr:.3f}  {arm}")
    print()

    transport = HttpTransport(args.base_url) if args.base_url else InProcessTransport()
    try:
        started = time.monotonic()
        result = run(
            transport,
            steps=args.steps,
            seed=args.seed,
            draft_id=args.draft_id,
            report_every=args.report_every,
        )
        print(f"\n({time.monotonic() - started:.1f}s)")
        report(result, transport, args.steps)
    finally:
        if isinstance(transport, HttpTransport):
            transport.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
