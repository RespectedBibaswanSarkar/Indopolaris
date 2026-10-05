"""
The publish-time contextual bandit: a 9-armed Beta-Bernoulli sampler.

Section 6 asks for a bandit that picks *where and when* to publish an outreach
story, and learns from what happened. The arm space is the cross product of the
3 `TargetChannel` values and the 3 `TimeSlot` buckets — 9 arms, no more. Every
arm carries a Beta(alpha, beta) posterior seeded at Beta(1, 1), and the
posteriors live in Postgres (`BanditArmState`) rather than in process memory so
that exactly one source of truth survives a restart, a replica swap, or a
reviewer running the simulator on a different machine.

**Thompson Sampling.** `/recommend` draws one Beta sample per arm and returns
the argmax. Why sampling rather than taking the posterior mean (UCB1 / greedy):

  - It is the only rule here that explores for free. Under greedy selection an
    arm that starts at the prior with an unlucky first observation can never be
    retried, so the bandit converges to whatever it happened to try first.
  - It gives calibrated uncertainty for free too: an arm with 5 pulls all
    successes and an arm with 500 pulls at 60% overlap heavily; the 5-pull arm
    is still worth trying again.
  - It needs no exploration constant. UCB1 and epsilon-greedy both have a
    hyperparameter that is either mistuned (never explores) or absurd (explores
    randomly forever), and neither is defensible in a project review.

**The update is a Bernoulli one, not a regression.** `EngagementEvent.reward`
is a click-through rate normalised to [0,1], and the SQL constraints require
`0 <= reward <= 1` and `0 <= totalReward <= totalPulls`. So the incremental
update is:

    alpha += reward
    beta  += (1 - reward)

which is exactly a Bernoulli Beta conjugate update on the mean. A fractional
reward is fine: Beta posteriors accept real-valued pseudo-counts, and this is
the standard treatment of a Bernoulli sufficient statistic.

**Both endpoints are non-fatal on a missing database.** `/classify` degrades
to `tagging: "pending"`; the equivalent here is returning the posterior *means*
with no history, which is a valid uninformed recommendation. A publish decision
that blocks because Postgres was briefly unreachable would be worse than one
that starts from a fresh prior.

Reads go through `app.db`, never through a second connection. Two pools
pointing at the same rows is how a reader ends up serving a posterior that was
overwritten a millisecond ago.
"""

from __future__ import annotations

import logging
import math
import random
from dataclasses import dataclass
from typing import Any, Literal

logger = logging.getLogger("indopolaris.ml.bandit")

#: The `TargetChannel` enum in prisma/schema.prisma.
CHANNELS: tuple[str, ...] = ("website", "twitter", "instagram")
#: The `TimeSlot` enum in prisma/schema.prisma.
TIME_SLOTS: tuple[str, ...] = ("morning", "afternoon", "evening")

#: Sampler seed. Fixed so a demo run is reproducible; `/recommend` is passed a
#: fresh seed per request by the route so successive recommendations are not
#: identical.
DEFAULT_SEED = 42


def build_arm(channel: str, time_slot: str) -> str:
    """
    The arm key, matching the `bandit_arm_name_parsable` CHECK constraint.

    That constraint is `'^(website|instagram|twitter)_(morning|afternoon|evening)$'`,
    so this function and the migration must agree. They are kept in sync by
    `tests/test_bandit.py`, which asserts the generated set against the regex.
    """
    return f"{channel}_{time_slot}"


def parse_arm(arm: str) -> tuple[str, str]:
    """Inverse of `build_arm`. Raises ValueError on a malformed arm."""
    channel, _, time_slot = arm.partition("_")
    if channel not in CHANNELS or time_slot not in TIME_SLOTS:
        raise ValueError(f"malformed arm name: {arm!r}")
    return channel, time_slot


@dataclass(frozen=True)
class Arm:
    """One arm's posterior, as read from `BanditArmState`."""

    arm: str
    alpha: float
    beta: float
    total_pulls: int
    total_reward: float

    @property
    def channel(self) -> str:
        return parse_arm(self.arm)[0]

    @property
    def time_slot(self) -> str:
        return parse_arm(self.arm)[1]

    @property
    def mean(self) -> float:
        """Posterior mean, alpha / (alpha + beta). Beta(1,1) -> 0.5."""
        return self.alpha / (self.alpha + self.beta)

    @property
    def observed_mean(self) -> float:
        """
        Mean reward over *observed* pulls only — the empirical CTR.

        Distinct from `mean`, which includes the prior's pseudo-counts. With no
        pulls this is 0.0, not 0.5: reporting 0.5 would claim a 50% click-through
        rate for an arm nobody has ever published to.
        """
        if self.total_pulls == 0:
            return 0.0
        return self.total_reward / self.total_pulls


def prior_arms() -> list[Arm]:
    """All 9 arms at Beta(1, 1). Used when the database is unavailable."""
    return [
        Arm(arm=build_arm(channel, slot), alpha=1.0, beta=1.0, total_pulls=0, total_reward=0.0)
        for channel in CHANNELS
        for slot in TIME_SLOTS
    ]


def load_arms(settings: Any = None) -> list[Arm]:
    """
    Read every `BanditArmState` row, backfilling any missing arm at the prior.

    Arms are not seeded by a migration. A row appears the first time an arm
    receives feedback, so a fresh database legitimately has zero rows and
    `/recommend` must still return all 9 arms — otherwise the first publish
    would only ever be able to choose between the arms that already have state,
    which on a fresh deployment means none of them.
    """
    from app import db

    settings = settings or None
    try:
        rows = db.read_bandit_arms(settings)
    except Exception as exc:  # noqa: BLE001 — a recommendation must still happen
        logger.warning(
            "could not read BanditArmState; serving uninformed recommendations",
            extra={"extra_fields": {"error": f"{type(exc).__name__}: {exc}"}},
        )
        return prior_arms()

    by_arm = {row["arm"]: row for row in rows}
    arms: list[Arm] = []
    for channel in CHANNELS:
        for slot in TIME_SLOTS:
            name = build_arm(channel, slot)
            row = by_arm.get(name)
            if row is None:
                arms.append(
                    Arm(arm=name, alpha=1.0, beta=1.0, total_pulls=0, total_reward=0.0)
                )
            else:
                arms.append(
                    Arm(
                        arm=name,
                        # The CHECK constraint guarantees positivity, but a float
                        # that arrived as NaN would pass `> 0` comparisons
                        # unpredictably and poison every later mean. Clamping
                        # here means a bad row degrades to the prior instead of
                        # silently corrupting recommendations.
                        alpha=max(float(row["alpha"]), 1e-9),
                        beta=max(float(row["beta"]), 1e-9),
                        total_pulls=int(row["total_pulls"]),
                        total_reward=float(row["total_reward"]),
                    )
                )
    return arms


def select_arm(
    arms: list[Arm],
    *,
    seed: int | None = DEFAULT_SEED,
    exclude: tuple[str, ...] = (),
) -> tuple[Arm, dict[str, float]]:
    """
    Thompson Sampling: sample each arm's Beta posterior, return the argmax.

    Returns (chosen_arm, all_samples) so the caller can show the runner-up and
    the spread — a recommendation a reviewer cannot interrogate is a
    recommendation they will not trust.

    `exclude` holds back arms already tried for this draft. Without it a
    simulator that re-pulls in a tight loop can keep sampling the same arm and
    the posterior never moves off its prior, which looks exactly like a bandit
    that failed to learn.
    """
    candidates = [a for a in arms if a.arm not in exclude] or list(arms)

    rng = random.Random(seed)
    samples: dict[str, float] = {}
    for arm in candidates:
        # Beta(alpha, beta) via two Gamma draws — Marsaglia-Tsang, which is what
        # `random.betavariate` implements. spencer's attribute on Random is
        # exactly this, so there is no need for numpy's Generator here and the
        # whole sampler stays stdlib.
        samples[arm.arm] = rng.betavariate(arm.alpha, arm.beta)

    best = max(samples, key=lambda k: samples[k])
    chosen = next(a for a in candidates if a.arm == best)
    return chosen, samples


def expected_reward(arms: list[Arm], n_draws: int = 20_000, *, seed: int = DEFAULT_SEED) -> dict[str, float]:
    """
    Monte-Carlo estimate of each arm's posterior mean.

    For Beta posteriors the mean is closed-form (alpha / (alpha + beta)), so this
    is strictly less accurate than just computing it. It exists because it is
    the number to compare against the *sampled* value: a recommendation whose
    sample is far above its own mean is the bandit being appropriately
    curious, and quantifying that gap is how you tell exploration from a bug.
    Kept deliberately simple and documented as redundant rather than shipped as
    an optimisation nobody needs.
    """
    rng = random.Random(seed)
    out: dict[str, float] = {}
    for arm in arms:
        draws = [rng.betavariate(arm.alpha, arm.beta) for _ in range(n_draws)]
        out[arm.arm] = sum(draws) / n_draws
    return out


def update_posterior(arm: Arm, reward: float) -> tuple[float, float]:
    """
    Bernoulli conjugate update. Returns (new_alpha, new_beta).

    Kept as a pure function so the arithmetic is testable without a database —
    this is the one line that, if it were wrong, would produce a confidently
    wrong recommendation forever.
    """
    bounded = min(1.0, max(0.0, reward))
    return arm.alpha + bounded, arm.beta + (1.0 - bounded)


def summarise(arm: Arm) -> dict[str, Any]:
    """The per-arm block of the /recommend response."""
    channel, slot = parse_arm(arm.arm)
    return {
        "arm": arm.arm,
        "channel": channel,
        "timeSlot": slot,
        "alpha": round(arm.alpha, 4),
        "beta": round(arm.beta, 4),
        "mean": round(arm.mean, 4),
        "observedMean": round(arm.observed_mean, 4),
        "totalPulls": arm.total_pulls,
        "totalReward": round(arm.total_reward, 4),
    }


def learning_curve(cumulative: list[float]) -> list[float]:
    """
    Running average of `cumulative`. A helper for the simulator's plot.

    Not a model — a cumulative reward curve only shows a slope if the
    per-step rewards are averaged, which is why the simulator prints both.
    """
    if not cumulative:
        return []
    total = 0.0
    out: list[float] = []
    for i, value in enumerate(cumulative, start=1):
        total += value
        out.append(total / i)
    return out


def wilson_interval(successes: float, trials: int, z: float = 1.96) -> tuple[float, float]:
    """
    Normal-approximation interval on a click-through rate.

    Used by the simulator to print whether the observed CTR for an arm moved
    beyond noise. A bare CTR for an arm with 3 pulls is not evidence of anything.
    """
    if trials <= 0:
        return (0.0, 1.0)
    p = successes / trials
    denom = 1 + z * z / trials
    centre = (p + z * z / (2 * trials)) / denom
    spread = z * math.sqrt((p * (1 - p) + z * z / (4 * trials)) / trials) / denom
    return (max(0.0, centre - spread), min(1.0, centre + spread))
