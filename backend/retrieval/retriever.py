import json
import time
from pathlib import Path
from types import SimpleNamespace

import modal

from backend.modal_app import DATA, PYTHON, RETRIEVAL_CPU_DEPS, _with_backend, app, volume
from backend.retrieval.chunk import doc_text

EMBED_MODEL = "Qwen/Qwen3-Embedding-0.6B"
RERANK_MODEL = "Qwen/Qwen3-Reranker-0.6B"
INDEX = Path(DATA) / "index"
TASK = "Given a person's description of a life situation or question, retrieve encyclopedia passages discussing relevant philosophical ideas."
QUERY_PREFIX = f"Instruct: {TASK}\nQuery:"
RERANK_MAX_TOKENS = 384  # ponytail: truncates each passage tail to ~260 tokens for latency; raise if a bigger GPU or U6 says so
_RERANK_PREFIX = (
    "<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct "
    'provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n'
)
_RERANK_SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"

gpu_image = _with_backend(
    modal.Image.debian_slim(python_version=PYTHON)
    .uv_pip_install("torch==2.14.1", "transformers==5.19.0", "sentence-transformers==6.1.0", *RETRIEVAL_CPU_DEPS)
    .env({"HF_HOME": "/models"})
    .run_commands(
        f"python -c \"from huggingface_hub import snapshot_download as d; d('{EMBED_MODEL}'); d('{RERANK_MODEL}')\""
    )
    .env({"HF_HUB_OFFLINE": "1"})
)


def load_embedder(device: str):
    import torch
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(
        EMBED_MODEL, device=device, model_kwargs={"dtype": torch.float16}, processor_kwargs={"padding_side": "left"}
    )


def current_version() -> str:
    return (INDEX / "current").read_text().strip()


def load_index(version: str) -> SimpleNamespace:
    import bm25s
    import numpy as np
    from scipy import sparse

    d = INDEX / version
    meta = json.loads((d / "meta.json").read_text())
    with open(d / "passages.jsonl") as f:
        passages = [json.loads(line) for line in f]
    slug_index = {s: i for i, s in enumerate(meta["slugs"])}
    return SimpleNamespace(
        version=version,
        passages=passages,
        titles=meta["titles"],
        slug_index=slug_index,
        entry_of=np.array([slug_index[p["slug"]] for p in passages]),
        emb=np.load(d / "emb.npy"),
        bm25=bm25s.BM25.load(str(d / "bm25")),
        graph=sparse.load_npz(d / "graph.npz").tocsr(),
        aliases=json.loads((d / "aliases.json").read_text()),
    )


@app.cls(image=gpu_image, gpu="L4", volumes={DATA: volume}, enable_memory_snapshot=True, scaledown_window=600, timeout=300)
class Retriever:
    @modal.enter(snap=True)
    def load(self):
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        t = time.perf_counter()
        self.embedder = load_embedder("cpu")
        self.rr_tok = AutoTokenizer.from_pretrained(RERANK_MODEL, padding_side="left")
        self.rr = AutoModelForCausalLM.from_pretrained(RERANK_MODEL, dtype=torch.float16).eval()
        self.no, self.yes = self.rr_tok.convert_tokens_to_ids(["no", "yes"])
        self.rr_prefix = self.rr_tok.encode(_RERANK_PREFIX, add_special_tokens=False)
        self.rr_suffix = self.rr_tok.encode(_RERANK_SUFFIX, add_special_tokens=False)
        self.ix = load_index(current_version())
        print(f"retriever loaded index={self.ix.version} passages={len(self.ix.passages)} s={time.perf_counter() - t:.1f}")

    @modal.enter(snap=False)
    def to_gpu(self):
        import torch

        t = time.perf_counter()
        volume.reload()
        if (version := current_version()) != self.ix.version:
            self.ix = load_index(version)
        self.embedder.to("cuda")
        self.rr.to("cuda")
        self.emb = torch.from_numpy(self.ix.emb).cuda()
        self._rerank([("warm-up", i) for i in self._candidates(["warm-up"], 20, [""])[0]])  # first CUDA calls are slow
        print(f"retriever on gpu index={self.ix.version} s={time.perf_counter() - t:.1f}")

    def _candidates(self, texts: list[str], depth: int, expansions: list[str], pins: list | None = None) -> list[list[int]]:
        import numpy as np
        import torch

        from backend.retrieval.search import FIRST_STAGE, PINNED_PER_ENTRY, bm25_top, rrf

        q = self.embedder.encode([QUERY_PREFIX + t for t in texts], normalize_embeddings=True, convert_to_tensor=True).half()
        dense = torch.topk(q @ self.emb.T, min(FIRST_STAGE, len(self.ix.passages))).indices.tolist()
        lexical = bm25_top(self.ix.bm25, [f"{t} {x}" for t, x in zip(texts, expansions)])
        out = [rrf([d, b])[:depth] for d, b in zip(dense, lexical)]
        for k, entry in enumerate(pins or []):
            if entry is None:
                continue
            idx = torch.from_numpy(np.flatnonzero(self.ix.entry_of == entry)).cuda()
            best = idx[torch.topk(q[k] @ self.emb[idx].T, min(PINNED_PER_ENTRY, len(idx))).indices].tolist()
            out[k] += [i for i in best if i not in out[k]]
        return out

    def _rerank(self, pairs: list[tuple[str, int]]):
        import numpy as np
        import torch

        texts = [f"<Instruct>: {TASK}\n<Query>: {q}\n<Document>: {doc_text(self.ix.passages[i])}" for q, i in pairs]
        room = RERANK_MAX_TOKENS - len(self.rr_prefix) - len(self.rr_suffix)
        ids = self.rr_tok(texts, truncation=True, max_length=room, return_attention_mask=False)["input_ids"]
        batch = self.rr_tok.pad({"input_ids": [self.rr_prefix + x + self.rr_suffix for x in ids]}, return_tensors="pt")
        with torch.inference_mode():
            logits = self.rr(**batch.to("cuda"), logits_to_keep=1).logits[:, -1, [self.no, self.yes]]
        return np.array(torch.log_softmax(logits.float(), dim=-1)[:, 1].exp().tolist())

    @modal.method()
    def warm(self) -> dict:
        return {"version": self.ix.version, "passages": len(self.ix.passages)}

    def _scored(self, query: str, use_aliases: bool):
        import numpy as np

        from backend.retrieval import aliases, search as s

        matched = [self.ix.slug_index[m] for m in aliases.match(query, self.ix.aliases)] if use_aliases else []
        ids = self._candidates([query], s.RERANK_DEPTH, [" ".join(self.ix.titles[e] for e in matched)])[0]
        entries = self.ix.entry_of[ids]
        return ids, self._rerank([(query, i) for i in ids]) + s.ALIAS_BOOST * np.isin(entries, matched), entries

    @modal.method()
    def rank(self, query: str, use_aliases: bool) -> tuple[list[int], list[float]]:
        ids, scores, _ = self._scored(query, use_aliases)
        return ids, scores.tolist()

    @modal.method()
    def search(self, query: str) -> dict:
        from backend.retrieval import search as s

        t = time.perf_counter()
        ids, scores, entries = self._scored(query, s.USE_ALIASES)
        if s.USE_PPR:
            scores = s.ppr_blend(scores, entries, self.ix.graph)
        top = s.top_passages(ids, scores, entries.tolist())
        print(f"search candidates={len(ids)} passages={len(top)} ms={(time.perf_counter() - t) * 1000:.0f}")
        return {"grounded": bool(top), "passages": [s.passage_out(self.ix.passages[i], score) for i, score in top]}

    @modal.method()
    def lens_map(self, lenses: list[dict], floor: float | None = None) -> dict:
        from backend.retrieval import search as s

        t = time.perf_counter()
        texts = [f"{lens['tradition']}: {lens['query']}" for lens in lenses]
        pins = [s.match_title(lens["tradition"], self.ix.titles) for lens in lenses]
        cands = self._candidates(texts, s.LENS_DEPTH, [""] * len(texts), pins)
        pairs = [(text, i) for text, ids in zip(texts, cands) for i in ids]
        scores = iter(self._rerank(pairs))
        scored = []
        for lens, ids in zip(lenses, cands):
            entries = self.ix.entry_of[ids].tolist()
            scored.append(
                [(i, e, next(scores) + s.title_prior(lens["tradition"], self.ix.titles[e])) for i, e in zip(ids, entries)]
            )
        stances = [lens["stance"] for lens in lenses]
        assigned, challenges_grounded = s.assign_lenses(scored, stances, s.SCORE_FLOOR if floor is None else floor)
        out = [
            {
                "lens_id": f"lens-{a['lens'] + 1}",
                "tradition": lenses[a["lens"]]["tradition"],
                "stance": lenses[a["lens"]]["stance"],
                "grounded": a["grounded"],
                "passages": [s.passage_out(self.ix.passages[i], score) for i, score in a["passages"]],
            }
            for a in assigned
        ]
        print(f"lens_map lenses={len(lenses)} grounded={sum(a['grounded'] for a in assigned)} ms={(time.perf_counter() - t) * 1000:.0f}")
        return {"lenses": out, "challenges_grounded": challenges_grounded}


class RetrieverClient:
    def __init__(self):
        self.cls = Retriever()
        self.warming = None

    async def warm(self) -> None:
        self.warming = await self.cls.warm.spawn.aio()

    async def ready(self) -> bool:
        if self.warming is None:
            return False
        try:
            await self.warming.get.aio(timeout=0)
            return True
        # An unfinished call raises the builtin TimeoutError, not modal.exception.TimeoutError.
        except (TimeoutError, modal.exception.TimeoutError):
            return False
        except Exception as e:
            print(f"warm failed error={type(e).__name__}")
            self.warming = None
            return False

    async def search(self, query) -> dict:
        return await self.cls.search.remote.aio(query)

    async def lens_map(self, lenses) -> dict:
        return await self.cls.lens_map.remote.aio(lenses)
