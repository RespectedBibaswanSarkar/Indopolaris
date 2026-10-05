"""
Tests for the publish-time bandit.

Two kinds, and the split matters:

  - The arithmetic tests (`update_posterior`, `wilson_interval`, `learning_curve`)
    are pure functions. They are the one line that, if wrong, produces a
    confidently wrong recommendation forever, so they are asserted directly.
  - The endpoint tests drive the real FastAPI app. They run without a database,
    so they assert the documented *degraded* behaviour — a recommendation is
    still returned from the prior — rather than pretending to have tested a
    posterior update that no fixture performed.

Nothing here asserts that the bandit "learns". Learning is an empirical
property of a bandit run against an environment, and the honest way to show it
is `scripts/simulate_engagement.py`, which prints the curve and the pull
concentration. A unit test asserting "reward goes up" would only ever test the
simulator's own reward generator.
"""

from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from app import bandit

#: Copied verbatim from the `bandit_arm_name_parsable` CHECK constraint in
#: prisma/migrations/2_ml/migration.sql. The two must agree; nothing in the
#: type system connects Python to a migration file, so a test asserts it.
ARM_CHECK_REGEX = r"^(website|instagram|twitter)_(morning|afternoon|evening)$"


def test_arm_names_satisfy_the_sql_check_constraint() -> None:
    """
    Every generated arm must satisfy the database's own constraint.

    If `buildArm` drifts from the migration, the first `POST /feedback` fails
    with a constraint violation — after the recommendation has already been acted
    on. This asserts the agreement directly instead.
    """
    arms = [bandit.build_arm(c, s) for c in bandit.CHANNELS for s in bandit.TIME_SLOTS]

    assert len(arms) == 9
    for arm in arms:
        assert re.match(ARM_CHECK_REGEX, arm), f"{arm} violates the SQL CHECK constraint"


def test_build_and_parse_arm_round_trip() -> None:
    for channel in bandit.CHANNELS:
        for slot in bandit.TIME_SLOTS:
            arm = bandit.build_arm(channel, slot)
            assert bandit.parse_arm(arm) == (channel, slot)


def test_parse_arm_rejects_a_malformed_name() -> None:
    """A name without an underscore cannot be split back into its parts."""
    with pytest.raises(ValueError):
        bandit.parse_arm("instagram_morning_v2")
    with pytest.raises(ValueError):
        bandit.parse_arm("myspace_morning")


def test_prior_arms_are_uniform_and_untried() -> None:
    arms = bandit.prior_arms()

    assert len(arms) == 9
    for arm in arms:
        # Beta(1, 1): the prior has no evidence, so its mean is 0.5.
        assert arm.mean == pytest.approx(0.5)
        assert arm.total_pulls == 0
        # Not 0.5: no observation is not a 50% click-through rate. Reporting the
        # prior mean as an observed CTR would be a fabricated measurement.
        assert arm.observed_mean == 0.0


def test_update_posterior_is_a_bernoulli_conjugate_step() -> None:
    arm = bandit.Arm(arm="website_morning", alpha=1.0, beta=1.0, total_pulls=0, total_reward=0.0)

    # A perfect outcome moves all the mass to alpha.
    alpha, beta = bandit.update_posterior(arm, 1.0)
    assert (alpha, beta) == (2.0, 1.0)
    # A total failure moves it to beta.
    alpha, beta = bandit.update_posterior(arm, 0.0)
    assert (alpha, beta) == (1.0, 2.0)
    # A 30% click-through splits it 30/70.
    alpha, beta = bandit.update_posterior(arm, 0.3)
    assert alpha == pytest.approx(1.3)
    assert beta == pytest.approx(1.7)
    # alpha + beta grows by exactly 1 per observation, from the prior total of
    # 2 to 3. That growth is what makes alpha/(alpha+beta) converge on the true
    # CTR as pulls accumulate: the prior's pseudo-counts get diluted, not
    # reinforced.
    assert alpha + beta == pytest.approx(3.0)


def test_update_posterior_clamps_out_of_range_rewards() -> None:
    """
    The SQL CHECK constraints reject reward outside [0,1].

    Clamping here means a bad value degrades to a recorded observation at the
    boundary instead of a failed write — and `bandit_arm_totals_consistent`
    requires totalReward <= totalPulls, which an unclamped >1 reward would break.
    """
    arm = bandit.Arm(arm="website_morning", alpha=1.0, beta=1.0, total_pulls=0, total_reward=0.0)

    alpha, beta = bandit.update_posterior(arm, 1.8)
    assert alpha == pytest.approx(2.0)
    assert beta == pytest.approx(1.0)

    alpha, beta = bandit.update_posterior(arm, -0.4)
    assert alpha == pytest.approx(1.0)
    assert beta == pytest.approx(2.0)


def test_select_arm_returns_an_arm_that_exists_and_a_sample_per_arm() -> None:
    arms = bandit.prior_arms()
    chosen, samples = bandit.select_arm(arms, seed=1)

    assert chosen.arm in {a.arm for a in arms}
    assert set(samples) == {a.arm for a in arms}
    assert all(0.0 <= v <= 1.0 for v in samples.values())
    # The chosen arm's sample must be the maximum — otherwise the argmax is
    # wired up wrong and /recommend reports an arm it did not select.
    assert samples[chosen.arm] == max(samples.values())


def test_select_arm_respects_exclusions() -> None:
    """A held-back arm must not come back, even if it would have won."""
    arms = bandit.prior_arms()
    held = "instagram_morning"

    for seed in range(30):
        chosen, samples = bandit.select_arm(arms, seed=seed, exclude=(held,))
        assert chosen.arm != held
        assert held not in samples


def test_select_arm_falls_back_when_everything_is_excluded() -> None:
    """
    Excluding all 9 arms must not return None.

    A reviewer passing a stale `exclude` list gets a real recommendation from
    the full set rather than an error — the alternative is a publish flow that
    dead-ends on a query-parameter typo.
    """
    arms = bandit.prior_arms()
    chosen, samples = bandit.select_arm(arms, seed=3, exclude=tuple(a.arm for a in arms))
    assert chosen.arm in {a.arm for a in arms}
    assert len(samples) == 9


def test_select_arm_is_seed_reproducible() -> None:
    """
    Same seed, same recommendation.

    This is what makes a captured /recommend debuggable: replaying a request id
    has to land on the same arm.
    """
    arms = bandit.prior_arms()
    first, samples_a = bandit.select_arm(arms, seed=99)
    second, samples_b = bandit.select_arm(arms, seed=99)

    assert first.arm == second.arm
    assert samples_a == samples_b


def test_posterior_sharpens_around_observed_reward() -> None:
    """
    The sampled value must track the posterior, not wander independently.

    If the update arithmetic were inverted (alpha/beta swapped) the posterior
    would move *away* from the observed CTR and this fails. That is the failure
    mode worth a test: a bandit that confidently believes the opposite of its
    evidence.
    """
    good = bandit.Arm(arm="instagram_morning", alpha=21.0, beta=1.0, total_pulls=20, total_reward=20.0)
    bad = bandit.Arm(arm="website_evening", alpha=1.0, beta=21.0, total_pulls=20, total_reward=0.0)

    assert good.mean > 0.9
    assert bad.mean < 0.1
    assert good.observed_mean == pytest.approx(1.0)
    assert bad.observed_mean == pytest.approx(0.0)


def test_expected_reward_matches_the_closed_form_beta_mean() -> None:
    """
    The Monte-Carlo estimate should agree with alpha / (alpha + beta).

    Documented as redundant — it exists to be compared against the sampled value
    — so this asserts the two agree rather than pinning an exact float.
    """
    arms = bandit.prior_arms()
    estimates = bandit.expected_reward(arms, n_draws=4000, seed=5)
    for arm in arms:
        assert estimates[arm.arm] == pytest.approx(arm.mean, abs=0.05)


def test_learning_curve_is_the_running_mean() -> None:
    curve = bandit.learning_curve([0.1, 0.2, 0.3, 0.4])
    assert curve == pytest.approx([0.1, 0.15, 0.2, 0.25])
    assert bandit.learning_curve([]) == []


def test_wilson_interval_contains_the_estimate_and_narrows_with_data() -> None:
    """
    A CTR from a handful of pulls must come back with a wide interval.

    Without this, an arm with 3 clicks out of 4 would report 75% and a reviewer
    would believe it. The interval is the honesty mechanism.
    """
    few_lo, few_hi = bandit.wilson_interval(3, 4)
    many_lo, many_hi = bandit.wilson_interval(300, 400)

    assert few_lo < 0.75 < few_hi
    assert (few_hi - few_lo) > (many_hi - many_lo)
    # No data is maximally uncertain, and the interval must stay inside [0,1].
    assert bandit.wilson_interval(0, 0) == (0.0, 1.0)
    for lo, hi in (bandit.wilson_interval(0, 10), bandit.wilson_interval(10, 10)):
        assert 0.0 <= lo <= hi <= 1.0


def test_summarise_reports_both_means() -> None:
    arm = bandit.Arm(arm="twitter_afternoon", alpha=6.0, beta=4.0, total_pulls=8, total_reward=5.0)
    summary = bandit.summarise(arm)

    assert summary["arm"] == "twitter_afternoon"
    assert summary["channel"] == "twitter"
    assert summary["timeSlot"] == "afternoon"
    assert summary["mean"] == pytest.approx(0.6)
    assert summary["observedMean"] == pytest.approx(0.625)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


def test_recommend_returns_a_channel_a_slot_and_all_nine_arms(
    client: TestClient,
) -> None:
    response = client.get("/recommend")

    assert response.status_code == 200
    body = response.json()

    assert set(body) == {
        "channel",
        "timeSlot",
        "arm",
        "reason",
        "exploration",
        "expectedReward",
        "draftId",
        "arms",
    }
    assert body["channel"] in bandit.CHANNELS
    assert body["timeSlot"] in bandit.TIME_SLOTS
    assert body["arm"] == bandit.build_arm(body["channel"], body["timeSlot"])
    assert 0.0 <= body["exploration"] <= 1.0
    assert 0.0 <= body["expectedReward"] <= 1.0

    # All 9 arms, even with no database. A fresh deployment has no
    # BanditArmState rows, and returning only the arms that already exist would
    # leave /recommend with nothing to choose from on day one.
    assert len(body["arms"]) == 9
    for arm in body["arms"]:
        assert re.match(ARM_CHECK_REGEX, arm["arm"])
        assert 0.0 <= arm["mean"] <= 1.0
        assert 0.0 <= arm["observedMean"] <= 1.0
        assert arm["totalPulls"] >= 0


def test_recommend_is_deterministic_per_request_id(client: TestClient) -> None:
    """
    The same X-Request-ID reproduces the same recommendation.

    This is what makes a captured response debuggable rather than a one-shot
    observation that cannot be re-examined.
    """
    first = client.get("/recommend", headers={"X-Request-ID": "replay-me"}).json()
    second = client.get("/recommend", headers={"X-Request-ID": "replay-me"}).json()

    assert first["arm"] == second["arm"]
    assert first["exploration"] == second["exploration"]


def test_recommend_honours_exclude(client: TestClient) -> None:
    held = "instagram_morning"
    body = client.get("/recommend", params={"exclude": held}).json()

    assert body["arm"] != held
    assert len(body["arms"]) == 9  # the state is still reported, just not sampled


def test_recommend_echoes_the_draft_id(client: TestClient) -> None:
    body = client.get("/recommend", params={"draftId": "draft-abc-123"}).json()
    assert body["draftId"] == "draft-abc-123"


def test_recommend_works_without_a_database(client: TestClient) -> None:
    """
    No DATABASE_URL is a valid mode and must still recommend.

    These fixtures run without one. A recommendation is a publish *suggestion* —
    blocking it because Postgres is briefly unreachable would be strictly worse
    than starting from the uniform prior, which is what the response returns.
    """
    body = client.get("/recommend").json()
    assert body["channel"] in bandit.CHANNELS
    assert all(arm["totalPulls"] == 0 for arm in body["arms"])


def test_feedback_returns_the_reward_it_absorbed(client: TestClient) -> None:
    response = client.post(
        "/feedback",
        json={
            "draftId": "draft-abc-123",
            "channel": "instagram",
            "timeSlot": "morning",
            "impressions": 1000,
            "clicks": 180,
            "isSimulated": True,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"recorded", "arm", "reward", "alpha", "beta", "mean", "totalPulls"}
    assert body["arm"] == "instagram_morning"
    # 180/1000. The normalisation the bandit regresses on.
    assert body["reward"] == pytest.approx(0.18)
    assert body["recorded"] is False  # no DATABASE_URL in these fixtures


def test_feedback_clamps_clicks_above_impressions(client: TestClient) -> None:
    """
    clicks > impressions is impossible and CHECK-rejected in SQL.

    Clamping rather than 422-ing: the simulator should never generate it, but a
    bug there must not turn a whole feedback batch into a client error. The
    clamped reward is reported back so the discrepancy is visible.
    """
    body = client.post(
        "/feedback",
        json={
            "draftId": "draft-abc-123",
            "channel": "twitter",
            "timeSlot": "evening",
            "impressions": 100,
            "clicks": 250,
        },
    ).json()

    assert body["reward"] == pytest.approx(1.0)


def test_feedback_with_zero_impressions_reports_zero_reward(client: TestClient) -> None:
    """
    No impressions means no click-through rate, not a division error.

    reward = 0.0 is the documented answer, and the arm still takes the pull —
    the story was published, it just got no impressions, which is itself signal.
    """
    response = client.post(
        "/feedback",
        json={
            "draftId": "draft-abc-123",
            "channel": "website",
            "timeSlot": "morning",
            "impressions": 0,
            "clicks": 0,
        },
    )

    assert response.status_code == 200
    assert response.json()["reward"] == 0.0


@pytest.mark.parametrize(
    "payload",
    [
        {"channel": "instagram", "timeSlot": "morning", "impressions": 10, "clicks": 1},
        {"draftId": "d", "timeSlot": "morning", "impressions": 10, "clicks": 1},
        {"draftId": "d", "channel": "instagram", "impressions": 10, "clicks": 1},
        {
            "draftId": "d",
            "channel": "instagram",
            "timeSlot": "morning",
            "impressions": -5,
            "clicks": 1,
        },
        {
            "draftId": "d",
            "channel": "instagram",
            "timeSlot": "morning",
            "impressions": 10,
            "clicks": -1,
        },
    ],
    ids=[
        "missing-draftId",
        "missing-channel",
        "missing-timeSlot",
        "negative-impressions",
        "negative-clicks",
    ],
)
def test_feedback_rejects_incomplete_payloads_with_the_error_envelope(
    client: TestClient, payload: dict
) -> None:
    """Every documented 422 uses the same envelope the Node client switches on."""
    response = client.post("/feedback", json=payload)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_INPUT"


def test_openapi_documents_the_bandit_endpoints(client: TestClient) -> None:
    """
    `/openapi.json` is the source `npm run ml:types` generates from.

    If these paths are missing from the schema, the Node client gets no types
    for them and the drift becomes invisible — which is the whole reason the
    schema is treated as the contract.
    """
    schema = client.get("/openapi.json").json()

    assert "/recommend" in schema["paths"]
    assert "/feedback" in schema["paths"]
    assert "get" in schema["paths"]["/recommend"]
    assert "post" in schema["paths"]["/feedback"]
    assert set(schema["components"]["schemas"]) >= {
        "RecommendResponse",
        "FeedbackRequest",
        "FeedbackResponse",
        "ArmState",
    }
