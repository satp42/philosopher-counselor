import bm25s
import numpy as np
import Stemmer
from rapidfuzz import fuzz, process
from scipy import sparse
from scipy.optimize import linear_sum_assignment

from backend.retrieval.aliases import fold
from backend.retrieval.chunk import excerpt

RRF_K = 60
FIRST_STAGE = 100
RERANK_DEPTH = 20
LENS_DEPTH = 15
TOP_N = 3
PER_ENTRY_CAP = 2
PER_LENS = 2
MAX_GROUNDED = 5
SCORE_FLOOR = 0.15
USE_PPR = False
PPR_ALPHA = 0.5
PPR_BETA = 0.1
USE_ALIASES = True
ALIAS_BOOST = 0.1
TITLE_PRIOR = 0.1
PINNED_PER_ENTRY = 3
_UNREACHABLE = -1e6

_stemmer = Stemmer.Stemmer("english")


def bm25_index(texts: list[str]) -> bm25s.BM25:
    index = bm25s.BM25()
    index.index(bm25s.tokenize(texts, stopwords="en", stemmer=_stemmer, show_progress=False), show_progress=False)
    return index


def bm25_top(index: bm25s.BM25, queries: list[str], k: int = FIRST_STAGE) -> list[list[int]]:
    tokens = bm25s.tokenize(queries, stopwords="en", stemmer=_stemmer, return_ids=False, show_progress=False)
    live = [i for i, t in enumerate(tokens) if t]
    out = [[] for _ in queries]
    if live:
        k = min(k, index.scores["num_docs"])
        ids, scores = index.retrieve([tokens[i] for i in live], k=k, show_progress=False, n_threads=1)
        for i, row_ids, row_scores in zip(live, ids, scores):
            out[i] = [int(d) for d, s in zip(row_ids, row_scores) if s > 0]
    return out


def rrf(rankings: list[list[int]], k: int = RRF_K) -> list[int]:
    fused: dict[int, float] = {}
    for ranking in rankings:
        for rank, doc in enumerate(ranking):
            fused[doc] = fused.get(doc, 0.0) + 1.0 / (k + rank + 1)
    return sorted(fused, key=lambda d: -fused[d])


def ppr(adj: sparse.csr_matrix, seed: np.ndarray, alpha: float = PPR_ALPHA, iters: int = 50) -> np.ndarray:
    deg = np.asarray(adj.sum(axis=0)).ravel()
    walk = adj @ sparse.diags(np.divide(1.0, deg, out=np.zeros_like(deg, dtype=float), where=deg > 0))
    s = seed / seed.sum()
    r = s.copy()
    for _ in range(iters):
        nxt = alpha * s + (1 - alpha) * (walk @ r)
        if np.abs(nxt - r).sum() < 1e-9:
            break
        r = nxt
    return r


def ppr_blend(scores: np.ndarray, entries: np.ndarray, adj: sparse.csr_matrix, beta: float = PPR_BETA) -> np.ndarray:
    seed = np.zeros(adj.shape[0])
    np.maximum.at(seed, entries, np.clip(scores, 0, None))
    if not seed.any():
        return scores
    r = ppr(adj, seed)
    return scores + beta * r[entries] / r.max()


def title_prior(tradition: str, title: str) -> float:
    return TITLE_PRIOR if fuzz.ratio(fold(tradition), fold(title)) >= 90 else 0.0


def match_title(tradition: str, titles: list[str]) -> int | None:
    hit = process.extractOne(fold(tradition), [fold(t) for t in titles], scorer=fuzz.ratio, score_cutoff=90)
    return hit[2] if hit else None


def top_passages(ids: list[int], scores: list[float], entries: list[int], n: int = TOP_N, cap: int = PER_ENTRY_CAP, floor: float = SCORE_FLOOR) -> list[tuple[int, float]]:
    out, per_entry = [], {}
    for i in np.argsort(scores)[::-1]:
        if scores[i] < floor or len(out) == n:
            break
        if per_entry.get(entries[i], 0) < cap:
            per_entry[entries[i]] = per_entry.get(entries[i], 0) + 1
            out.append((ids[i], float(scores[i])))
    return out


def assign_lenses(cands: list[list[tuple[int, int, float]]], stances: list[str], floor: float = SCORE_FLOOR) -> tuple[list[dict], bool]:
    """cands[lens] = [(passage, entry, score)]. Gives grounded lenses distinct entries, maximizing total score.

    Returns one {"lens": i, "grounded", "passages": [(passage, score)]} per kept lens, and challenges_grounded.
    """
    entries = sorted({e for c in cands for _, e, _ in c})
    col = {e: j for j, e in enumerate(entries)}
    m = np.full((len(cands), max(len(entries), 1)), _UNREACHABLE)
    for i, c in enumerate(cands):
        for _, e, s in c:
            if s >= floor:
                m[i, col[e]] = max(m[i, col[e]], s)
    assigned = {r: entries[c] for r, c in zip(*linear_sum_assignment(m, maximize=True)) if m[r, c] > _UNREACHABLE}

    grounded = sorted(assigned, key=lambda i: -m[i, col[assigned[i]]])
    keep = grounded[:MAX_GROUNDED]
    challengers = [i for i in grounded if stances[i] == "challenges"]
    if challengers and not any(stances[i] == "challenges" for i in keep):
        keep[-1] = challengers[0]
    dropped = set(grounded) - set(keep)

    lenses = []
    for i, c in enumerate(cands):
        if i in dropped:
            continue
        mine = sorted(((p, s) for p, e, s in c if i in assigned and e == assigned[i] and s >= floor), key=lambda x: -x[1])
        lenses.append({"lens": i, "grounded": i in assigned, "passages": mine[:PER_LENS]})
    return lenses, any(lens["grounded"] and stances[lens["lens"]] == "challenges" for lens in lenses)


def passage_out(p: dict, score: float) -> dict:
    return {
        "passage_id": p["id"],
        "slug": p["slug"],
        "entry_title": p["entry_title"],
        "section_path": " > ".join(p["section_path"]),
        "url": p["anchor_url"],
        "text": p["text"],
        "excerpt": excerpt(p["text"]),
        "score": round(float(score), 4),  # plain float: the web tier has no numpy to unpickle with
    }
