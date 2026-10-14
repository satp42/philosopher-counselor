---
title: SEP retrieval eval and tuning
date: 2026-10-13
module: retrieval
tags: [retrieval, eval, reranker, ppr, aliases, latency]
---

# SEP retrieval eval and tuning

**Status: final, measured on the full index `v3` (1,870 entries, 117,490 passages) on 2026-10-13.** The v2 interim notes below are kept for history.
Re-run on the deployed app (spawned, survives client disconnects):
`python -c "import modal; print(modal.Function.from_name('sep-counselor', 'evaluate').remote())"`

## Final decisions (v3)

| Setting | Value | Why |
|---|---|---|
| `USE_ALIASES` | **on** | Misheard-name nDCG@10 0.673 → 0.795 (Kierkegaard, Spinoza now found); situation queries unchanged (0.519 → 0.515). |
| `USE_PPR` | off | +0.002 nDCG at best across β 0.05–0.3: noise. |
| `SCORE_FLOOR` | 0.15 | Guide queries ground 54/54 (49/54 on a labeled entry). Off-topic false grounding is 4/10 at 0.15 and still 2/10 at 0.5, so a higher floor costs real queries without fixing it; the guide only sends philosophical queries in practice. |
| Lens pinning | on | An entry titled after a lens's tradition (e.g. "Stoicism") joins that lens's candidates before rerank; lens mode grounds 5/5 lenses on distinct entries with a challenge lens in 54/54 plans. |
| Rerank depth / token cap | 20 / 384 | Lookup p50 541 ms, p95 586 ms round trip from inside Modal; lens map about 2 s. |

Raw personal phrasing stays weak (nDCG@10 0.31): first-stage recall, not the floor. The guide rewrites into philosophical vocabulary before querying, which is why guide-phrased queries are what matter.

### Full v3 results

index `v3`: 1870 entries, 117490 passages
situation labels in index: 246/246
guide queries with a label in index: 54/54
raw queries with a label in index: 54/54
name queries with a label in index: 10/10

### Ablations (entry-level)
| config | guide R@5 | guide R@10 | guide nDCG@10 | raw R@5 | raw R@10 | raw nDCG@10 | name R@5 | name R@10 | name nDCG@10 |
|---|---|---|---|---|---|---|---|---|---|
| BM25 only | 0.284 | 0.419 | 0.387 | 0.109 | 0.135 | 0.127 | 0.400 | 0.500 | 0.382 |
| baseline | 0.403 | 0.462 | 0.519 | 0.249 | 0.282 | 0.307 | 0.767 | 0.900 | 0.673 |
| +PPR (β=0.1) | 0.403 | 0.462 | 0.521 | 0.253 | 0.282 | 0.310 | 0.767 | 0.900 | 0.673 |
| +aliases | 0.403 | 0.451 | 0.515 | 0.249 | 0.282 | 0.310 | 0.917 | 0.950 | 0.795 |
| +both | 0.403 | 0.451 | 0.517 | 0.253 | 0.282 | 0.312 | 0.917 | 0.950 | 0.795 |

### PPR β sweep (no aliases)
| β | guide nDCG@10 | raw nDCG@10 | name nDCG@10 |
|---|---|---|---|
| 0.050 | 0.520 | 0.310 | 0.673 |
| 0.100 | 0.521 | 0.310 | 0.673 |
| 0.200 | 0.522 | 0.308 | 0.673 |
| 0.300 | 0.521 | 0.308 | 0.673 |

### Floor sweep (production flags: aliases=False, PPR=False); grounded / grounded on-label
| floor | guide | guide on-label | raw | raw on-label | name | name on-label | off-topic (false) |
|---|---|---|---|---|---|---|---|
| 0.050 | 54/54 | 49/54 | 53/54 | 38/54 | 10/10 | 7/10 | 5/10 |
| 0.100 | 54/54 | 49/54 | 52/54 | 37/54 | 10/10 | 7/10 | 5/10 |
| 0.150 | 54/54 | 49/54 | 52/54 | 37/54 | 10/10 | 7/10 | 4/10 |
| 0.200 | 54/54 | 49/54 | 51/54 | 36/54 | 10/10 | 7/10 | 4/10 |
| 0.250 | 54/54 | 49/54 | 50/54 | 36/54 | 10/10 | 7/10 | 4/10 |
| 0.300 | 54/54 | 49/54 | 50/54 | 35/54 | 10/10 | 7/10 | 4/10 |
| 0.400 | 53/54 | 48/54 | 47/54 | 35/54 | 10/10 | 7/10 | 3/10 |
| 0.500 | 53/54 | 47/54 | 46/54 | 35/54 | 10/10 | 7/10 | 2/10 |

### Lens mode
| floor | grounded lenses | distinct entries | plans ≥3 grounded | challenges_grounded |
|---|---|---|---|---|
| 0.050 | 5.000 | 5.000 | 54/54 | 54/54 |
| 0.100 | 5.000 | 5.000 | 54/54 | 54/54 |
| 0.150 | 5.000 | 5.000 | 54/54 | 54/54 |
| 0.250 | 5.000 | 5.000 | 54/54 | 54/54 |

### Warm latency, round trip from a Modal container (ms, p50 / p95)
search: 541 / 586 (n=108); lens_map: 1988 / 2066 (n=216)

## Interim notes (v2, 558 entries)

## Setup

- `backend/eval/situations.jsonl` has 54 life situations, 10 misheard-name queries and 10 off-topic queries.
  - Each situation carries a guide-phrased `query` (the way `consult_sep` is called), the person's `raw` words, a 5-lens `map_lenses` plan with at least one `challenges` lens, and 2–5 acceptable SEP slugs.
  - Labels were drafted by an LLM and are waiting for the user's spot-check. `backend/tests/test_eval_set.py` checks every slug against the SEP contents page.
- `backend/eval/run_eval.py` calls the `Retriever` through two eval-only hooks:
  - `rank(query, use_aliases)` returns the reranked candidates before PPR and before the floor. The eval applies PPR and the floor itself, so β and floor sweeps need only one reranker pass per query.
  - `lens_map(..., floor=)` overrides the floor for the lens-mode sweep.
- Metrics are computed at entry level over the reranked candidates (depth 20).
  - Labels whose entry is not in the index are dropped from the denominators.
  - Queries with no covered label are skipped.
- On v2, coverage was:
  - 64 of 246 situation labels in the index
  - 43 of 54 situations with at least one covered label
  - 4 of 10 name targets covered

## Ablations (v2, entry level)

| config | guide R@5 | guide R@10 | guide nDCG@10 | raw R@5 | raw R@10 | raw nDCG@10 | name R@10 | name nDCG@10 |
|---|---|---|---|---|---|---|---|---|
| BM25 only | 0.442 | 0.647 | 0.402 | 0.112 | 0.233 | 0.133 | 1.000 | 0.729 |
| **baseline** | 0.535 | 0.705 | 0.516 | 0.380 | 0.461 | 0.318 | 1.000 | 0.906 |
| +PPR (β=0.1) | 0.535 | 0.705 | 0.519 | 0.380 | 0.461 | 0.319 | 1.000 | 0.814 |
| +aliases | 0.535 | 0.705 | 0.516 | 0.380 | 0.461 | 0.318 | 1.000 | 0.906 |
| +both | 0.535 | 0.705 | 0.519 | 0.380 | 0.461 | 0.319 | 1.000 | 0.814 |

PPR β sweep, nDCG@10 (guide / raw / name):

| β | guide | raw | name |
|---|---|---|---|
| 0.05 | 0.525 | 0.318 | 0.814 |
| 0.1 | 0.519 | 0.319 | 0.814 |
| 0.2 | 0.520 | 0.319 | 0.814 |
| 0.3 | 0.526 | 0.319 | 0.814 |

- Baseline beats BM25 alone on every set, which passes the plan's check.
- PPR is within noise on situation queries at every β, and it hurts names: it pulls a related entry above the named thinker. **PPR stays off.**
- Aliases change nothing on v2, because every covered name target (Heidegger, Descartes, Camus, Beauvoir) is already found without them. **Aliases stay off for now.** This is decided by the six name targets outside v2 (Kierkegaard, Nietzsche, Epictetus, Schopenhauer, Spinoza, Epicurus), so it needs the full-index run.

## Score floor

Counts are of relevant queries: those grounded, then those grounded with at least one passage from a labeled entry. The off-topic column counts off-topic queries that were grounded anyway. Baseline flags.

| floor | guide | guide on-label | raw | raw on-label | off-topic (false) |
|---|---|---|---|---|---|
| 0.05 | 43/43 | 24/43 | 42/43 | 12/43 | 2/10 |
| 0.10 | 43/43 | 23/43 | 40/43 | 11/43 | 1/10 |
| **0.15** | 42/43 | 23/43 | 37/43 | 11/43 | 0/10 |
| 0.20 | 41/43 | 23/43 | 36/43 | 11/43 | 0/10 |
| 0.25 (old) | 41/43 | 23/43 | 34/43 | 11/43 | 0/10 |
| 0.30 | 41/43 | 23/43 | 34/43 | 10/43 | 0/10 |
| 0.40 | 38/43 | 21/43 | 34/43 | 10/43 | 0/10 |
| 0.50 | 37/43 | 20/43 | 31/43 | 9/43 | 0/10 |

- The highest off-topic score was 0.13 ("printer paper jam" landed on `chinese-room`). Every other off-topic query scored 0.054 or lower.
- **The floor is now 0.15**, the lowest floor with no false grounding. It recovers 3 raw situation queries that 0.25 left ungrounded, which is the "grief came back ungrounded" symptom.
- Raw phrasing grounds on a labeled entry only about 11/43 times at any floor; the guide's phrasing does it 23/43. This gap is in first-stage recall (raw R@10 0.46 vs 0.71), and no floor fixes it.
  - In production the guide writes the tool queries in philosophical vocabulary, and the instruction to write canonical names reinforces that. Raw transcript text should never reach retrieval.

## Reranker instruction (before and after)

- **Before (kept):** `Given a person's description of a life situation or question, retrieve encyclopedia passages discussing relevant philosophical ideas.`
- **After (tried, reverted):** `Given a person's description of their life situation or a question about it, judge whether the encyclopedia passage discusses a philosophical idea, argument or thinker that could help them think it through.`

| instruction | guide nDCG@10 | raw nDCG@10 | raw grounded @0.25 | off-topic false @0.15 / @0.25 | max off-topic score |
|---|---|---|---|---|---|
| before | 0.516 | 0.318 | 34/43 | 0/10 / 0/10 | 0.13 |
| after | 0.527 | 0.324 | 37/43 | 3/10 / 2/10 | 0.47 ("marathon training" → `aristotle`) |

- The lenient wording raises every score instead of separating relevant passages from irrelevant ones.
- Its on-label grounding did not improve. "Could help them think it through" is true of almost anything.
- The wording was not the problem. The floor was.

## Lens mode (v2, 54 plans of 5 lenses)

| floor | grounded lenses | distinct entries | plans ≥3 grounded | challenges_grounded |
|---|---|---|---|---|
| 0.05 | 4.98 | 4.98 | 54/54 | 53/54 |
| 0.10 | 4.94 | 4.94 | 54/54 | 52/54 |
| **0.15** | 4.91 | 4.91 | 54/54 | 50/54 |
| 0.25 | 4.67 | 4.67 | 54/54 | 44/54 |

- Lowering the floor to 0.15 raises the share of plans with a grounded challenging lens from 81% to 93%. That means fewer fallback `consult_sep` calls for a challenger.

## Latency (warm L4, depth 20, 384-token rerank cap)

| mode | server-side | round trip from another Modal container (p50 / p95) |
|---|---|---|
| search | about 445ms (p95 about 451ms) | 633 / 639ms |
| lens_map (5 lenses × 15) | about 1.75s | 1.94 / 1.95s |

- Both modes meet the plan's targets: under 500ms server-side for search, under 6s for lens_map.
- Search has only about 50ms of headroom, so keep the rerank depth at 20. Depth 30 is the plan's documented ~850ms case.
- The roughly 190ms gap between round trip and server time is Modal call overhead.
- The ephemeral eval app has no memory snapshot. That affects cold start only, not these warm numbers.

## Chosen settings (`backend/retrieval/search.py`)

| setting | value | why |
|---|---|---|
| `SCORE_FLOOR` | **0.15** (was 0.25) | lowest floor with no off-topic grounding; more raw situations and challengers grounded |
| `USE_PPR` | False | no situation gain at any β, and it hurts named-thinker queries |
| `PPR_BETA` | 0.1 (unused) | sweep was flat |
| `USE_ALIASES` | False (pending full index) | no measurable effect on v2's covered names |
| `RERANK_DEPTH` | 20 | latency headroom is about 50ms |
| reranker instruction | unchanged | the lenient wording causes false grounding |

## Caveats

- Every number here comes from v2: about 30% of entries, skewed toward A–E. On the full index, off-topic queries have more chances to hit plausible entries such as `sport` or `money-finance`. Re-check the 0.15 floor's false-grounding column there.
- The labels are one LLM's judgment and have not been spot-checked yet.
