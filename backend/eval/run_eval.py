import json
import math
import statistics
import time
from pathlib import Path

from backend.modal_app import DATA, app, ci_image, volume
from backend.retrieval.retriever import Retriever, current_version, load_index

ROWS = Path(__file__).parent / "situations.jsonl"
FLOORS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]
BETAS = [0.05, 0.1, 0.2, 0.3]
LENS_FLOORS = [0.05, 0.1, 0.15, 0.25]
SETS = ["guide", "raw", "name"]


def recall(ranked: list[str], rel: set[str], k: int) -> float:
    return len(set(ranked[:k]) & rel) / len(rel)


def ndcg(ranked: list[str], rel: set[str], k: int = 10) -> float:
    dcg = sum(1 / math.log2(i + 2) for i, e in enumerate(ranked[:k]) if e in rel)
    return dcg / sum(1 / math.log2(i + 2) for i in range(min(k, len(rel))))


def p50_p95(ms: list[float]) -> str:
    return f"{statistics.median(ms):.0f} / {statistics.quantiles(ms, n=20)[18]:.0f}"


def table(header: list[str], rows: list[list]) -> str:
    lines = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    return "\n".join(lines + ["| " + " | ".join(f"{v:.3f}" if isinstance(v, float) else str(v) for v in row) + " |" for row in rows])


@app.function(image=ci_image, volumes={DATA: volume}, timeout=3 * 3600)
def evaluate() -> str:
    import numpy as np

    from backend.retrieval import search as s

    rows = [json.loads(line) for line in ROWS.read_text().splitlines()]
    ix = load_index(current_version())
    slugs = list(ix.slug_index)
    r = Retriever()
    assert r.warm.remote()["version"] == ix.version, "index/current moved under the eval"
    out = [f"index `{ix.version}`: {len(slugs)} entries, {len(ix.passages)} passages"]

    labels = [x for row in rows if row["kind"] == "situation" for x in row["relevant"]]
    out.append(f"situation labels in index: {sum(x in ix.slug_index for x in labels)}/{len(labels)}")
    queries = []
    for row in rows:
        texts = [("guide", row["query"]), ("raw", row["raw"])] if row["kind"] == "situation" else [(row["kind"], row["query"])]
        rel = {x for x in row["relevant"] if x in ix.slug_index}
        queries += [{"set": k, "id": row["id"], "text": t, "rel": rel, "labeled": bool(row["relevant"])} for k, t in texts]
    for k in SETS:
        qs = [q for q in queries if q["set"] == k]
        out.append(f"{k} queries with a label in index: {sum(bool(q['rel']) for q in qs)}/{len(qs)}")

    for q in queries:
        q["base"] = r.rank.remote(q["text"], False)
        q["alias"] = r.rank.remote(q["text"], True)
        q["bm25"] = list(dict.fromkeys(slugs[e] for e in ix.entry_of[s.bm25_top(ix.bm25, [q["text"]])[0]]))

    def scored(q, use_aliases: bool, beta: float):
        ids, scores = q["alias" if use_aliases else "base"]
        entries = ix.entry_of[ids]
        scores = np.array(scores)
        if beta:
            scores = s.ppr_blend(scores, entries, ix.graph, beta)
        return ids, scores, entries

    def ranking(q, use_aliases: bool, beta: float) -> list[str]:
        _, scores, entries = scored(q, use_aliases, beta)
        return list(dict.fromkeys(slugs[e] for e in entries[np.argsort(-scores, kind="stable")]))

    def metrics(rank_of, sets=SETS) -> list[float]:
        row = []
        for k in sets:
            qs = [q for q in queries if q["set"] == k and q["rel"]]
            ranked = [rank_of(q) for q in qs]
            row += [float(np.mean([f(x, q["rel"]) for x, q in zip(ranked, qs)])) for f in (
                lambda x, rel: recall(x, rel, 5), lambda x, rel: recall(x, rel, 10), ndcg)]
        return row

    configs = {
        "BM25 only": lambda q: q["bm25"],
        "baseline": lambda q: ranking(q, False, 0),
        f"+PPR (β={s.PPR_BETA})": lambda q: ranking(q, False, s.PPR_BETA),
        "+aliases": lambda q: ranking(q, True, 0),
        "+both": lambda q: ranking(q, True, s.PPR_BETA),
    }
    header = ["config"] + [f"{k} {m}" for k in SETS for m in ("R@5", "R@10", "nDCG@10")]
    out += ["\n### Ablations (entry-level)", table(header, [[name, *metrics(f)] for name, f in configs.items()])]
    out += ["\n### PPR β sweep (no aliases)", table(
        ["β", "guide nDCG@10", "raw nDCG@10", "name nDCG@10"],
        [[b, *metrics(lambda q, b=b: ranking(q, False, b))[2::3]] for b in BETAS],
    )]

    def prod(q):
        return scored(q, s.USE_ALIASES, s.PPR_BETA if s.USE_PPR else 0)

    sweep = []
    for f in FLOORS:
        row = [f]
        for k in ("guide", "raw", "name", "offtopic"):
            qs = [q for q in queries if q["set"] == k and (q["rel"] or not q["labeled"])]
            tops = [(q, s.top_passages(ids, sc, en.tolist(), floor=f)) for q in qs for ids, sc, en in [prod(q)]]
            row.append(f"{sum(bool(t) for _, t in tops)}/{len(qs)}")
            if k != "offtopic":
                row.append(f"{sum(any(slugs[ix.entry_of[i]] in q['rel'] for i, _ in t) for q, t in tops)}/{len(qs)}")
        sweep.append(row)
    out += [
        f"\n### Floor sweep (production flags: aliases={s.USE_ALIASES}, PPR={s.USE_PPR}); grounded / grounded on-label",
        table(["floor", "guide", "guide on-label", "raw", "raw on-label", "name", "name on-label", "off-topic (false)"], sweep),
    ]

    plans = [row for row in rows if row["kind"] == "situation"]
    lens_ms, lens_rows = [], []
    for f in sorted({*LENS_FLOORS, s.SCORE_FLOOR}):
        grounded, distinct, three, challenged = [], [], 0, 0
        for row in plans:
            t = time.perf_counter()
            res = r.lens_map.remote(row["lenses"], f)
            lens_ms.append((time.perf_counter() - t) * 1000)
            got = [lens for lens in res["lenses"] if lens["grounded"]]
            grounded.append(len(got))
            distinct.append(len({p["slug"] for lens in got for p in lens["passages"]}))
            three += len(got) >= 3
            challenged += res["challenges_grounded"]
        lens_rows.append([f, float(np.mean(grounded)), float(np.mean(distinct)), f"{three}/{len(plans)}", f"{challenged}/{len(plans)}"])
    out += ["\n### Lens mode", table(["floor", "grounded lenses", "distinct entries", "plans ≥3 grounded", "challenges_grounded"], lens_rows)]

    search_ms = []
    for q in queries:
        if q["set"] in ("guide", "raw"):
            t = time.perf_counter()
            r.search.remote(q["text"])
            search_ms.append((time.perf_counter() - t) * 1000)
    out += [
        "\n### Warm latency, round trip from a Modal container (ms, p50 / p95)",
        f"search: {p50_p95(search_ms)} (n={len(search_ms)}); lens_map: {p50_p95(lens_ms)} (n={len(lens_ms)})",
    ]

    out.append("\n### Misses (baseline nDCG@10 = 0) and names")
    for q in queries:
        base = ranking(q, False, 0)
        if q["set"] == "name":
            out.append(f"- name {q['id']}: base {base[:3]} / aliases {ranking(q, True, 0)[:3]}")
        elif q["rel"] and ndcg(base, q["rel"]) == 0:
            out.append(f"- {q['set']} {q['id']}: top {base[:5]} labels {sorted(q['rel'])}")
        elif q["set"] == "offtopic":
            _, scores, entries = prod(q)
            out.append(f"- offtopic {q['id']}: {slugs[entries[scores.argmax()]]} {scores.max():.3f}")
    return "\n".join(out)


@app.local_entrypoint()
def run_quality() -> None:
    print(evaluate.remote())
