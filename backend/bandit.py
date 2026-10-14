"""Thompson sampling over the Live config variants. One arm per call; the call records are the only state."""

import math
import random
from statistics import mean

from backend.guide.config import VARIANTS

PRIOR_MEAN = 0.5
SIGMA = 0.2  # rewards live in [0, 1]; prior N(PRIOR_MEAN, SIGMA²), each call's reward has noise SIGMA²
LATENCY_FLOOR_MS = 3000  # turn-end latency this long or worse scores 0
TOOL_SILENCE_FLOOR_MS = 6000


def reward(m: dict) -> float | None:
    """Equal-weight mean over the metrics present: hold pauses, answer fast, match the person's length while
    listening, no dead air after lookups. None when the call recorded nothing usable."""
    parts = []
    if m.get("utterances"):
        parts.append(1 - m.get("takeovers", 0) / m["utterances"])
    if (lat := m.get("turn_latency_ms")) is not None:
        parts.append(1 - min(lat / LATENCY_FLOOR_MS, 1))
    words = (m.get("words") or {}).get("listen") or {}
    if words.get("user") and words.get("guide"):
        parts.append(max(0.0, 1 - abs(math.log(words["guide"] / words["user"]))))
    if (gap := m.get("tool_silence_ms")) is not None:
        parts.append(1 - min(gap / TOOL_SILENCE_FLOOR_MS, 1))
    return mean(parts) if parts else None


def pick(records: list[dict], rng=random) -> str:
    rewards: dict[str, list[float]] = {v: [] for v in VARIANTS}
    for rec in records:
        r = reward(rec.get("metrics") or {})
        if r is not None and rec.get("variant") in rewards:
            rewards[rec["variant"]].append(r)

    def sample(rs: list[float]) -> float:
        n = len(rs) + 1  # the prior counts as one observation
        return rng.gauss((PRIOR_MEAN + sum(rs)) / n, SIGMA / math.sqrt(n))

    return max(VARIANTS, key=lambda v: sample(rewards[v]))
