import random
from collections import Counter

import pytest

from backend import bandit
from backend.guide.config import VARIANTS

GOOD = {"utterances": 10, "takeovers": 0, "turn_latency_ms": 600, "tool_silence_ms": 1500, "words": {"listen": {"user": 100, "guide": 100}}}
BAD = {"utterances": 10, "takeovers": 8, "turn_latency_ms": 3000, "tool_silence_ms": 9000, "words": {"listen": {"user": 100, "guide": 800}}}


def test_reward_bounds_and_partial_metrics():
    assert bandit.reward(GOOD) == pytest.approx((1 + 0.8 + 1 + 0.75) / 4)
    assert bandit.reward(BAD) < 0.1
    assert bandit.reward({}) is None
    assert bandit.reward({"utterances": 0}) is None  # a call with no guide speech says nothing
    assert bandit.reward({"utterances": 4, "takeovers": 1}) == 0.75


def test_pick_prefers_the_arm_with_better_rewards():
    records = [{"variant": "s1500-brief", "metrics": GOOD}] * 6 + [{"variant": v, "metrics": BAD} for v in VARIANTS if v != "s1500-brief"] * 6
    records += [{"variant": "s900", "metrics": None}, {"variant": "unknown", "metrics": GOOD}, {}]
    picks = Counter(bandit.pick(records, random.Random(i)) for i in range(200))
    assert picks["s1500-brief"] > 180


def test_pick_explores_every_arm_with_no_data():
    picks = Counter(bandit.pick([], random.Random(i)) for i in range(300))
    assert set(picks) == set(VARIANTS)
