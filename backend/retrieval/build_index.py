import json
import time

from backend.corpus.crawl import CORPUS
from backend.modal_app import DATA, app, volume
from backend.retrieval.chunk import doc_text
from backend.retrieval.retriever import EMBED_MODEL, INDEX, gpu_image, load_embedder


@app.function(image=gpu_image, gpu="L4", volumes={DATA: volume}, timeout=4 * 3600)
def build_index() -> dict:
    import numpy as np
    from scipy import sparse

    from backend.retrieval import aliases
    from backend.retrieval.chunk import chunk_entry
    from backend.retrieval.search import bm25_index

    t = time.perf_counter()
    volume.reload()
    with open(CORPUS / "entries.jsonl") as f:
        entries = [json.loads(line) for line in f]
    embedder = load_embedder("cuda")
    tokenizer = embedder.tokenizer

    def count(text: str) -> int:
        return len(tokenizer(text, add_special_tokens=False)["input_ids"])

    good, passages = [], []
    for e in entries:
        try:
            chunks = chunk_entry(e, count)
        except ValueError:
            print(f"skip {e['slug']}: bad url")
            continue
        if chunks:
            good.append(e)
            passages += chunks
    print(f"chunked entries={len(good)}/{len(entries)} passages={len(passages)} s={time.perf_counter() - t:.0f}")

    docs = [doc_text(p) for p in passages]
    emb = embedder.encode(docs, batch_size=64, normalize_embeddings=True, convert_to_numpy=True).astype(np.float16)
    print(f"embedded s={time.perf_counter() - t:.0f}")

    slugs = [e["slug"] for e in good]
    idx = {s: i for i, s in enumerate(slugs)}
    edges = [(idx[e["slug"]], idx[r]) for e in good for r in e["related"] if r in idx and r != e["slug"]]
    rows, cols = [a for a, _ in edges], [b for _, b in edges]
    adj = sparse.coo_matrix((np.ones(len(edges)), (rows, cols)), shape=(len(slugs), len(slugs))).tocsr()
    graph = ((adj + adj.T) > 0).astype(np.float32)

    INDEX.mkdir(parents=True, exist_ok=True)
    n = max((int(p.name[1:]) for p in INDEX.glob("v*") if p.name[1:].isdigit()), default=0) + 1
    out = INDEX / f"v{n}"
    out.mkdir()
    with open(out / "passages.jsonl", "w") as f:
        f.writelines(json.dumps(p, ensure_ascii=False) + "\n" for p in passages)
    np.save(out / "emb.npy", emb)
    bm25_index(docs).save(str(out / "bm25"))
    sparse.save_npz(out / "graph.npz", graph)
    table = aliases.build_table(good)
    (out / "aliases.json").write_text(json.dumps(table))
    meta = {
        "version": out.name,
        "embed_model": EMBED_MODEL,
        "entries": len(good),
        "passages": len(passages),
        "edges": int(graph.nnz),
        "aliases": len(table),
        "built_at": time.time(),
        "slugs": slugs,
        "titles": [e["title"] for e in good],
    }
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    volume.commit()

    tmp = INDEX / "current.tmp"
    tmp.write_text(out.name)
    tmp.rename(INDEX / "current")
    volume.commit()
    summary = {k: meta[k] for k in ("version", "entries", "passages", "edges", "aliases")}
    print(f"index built {summary} s={time.perf_counter() - t:.0f}")
    return summary


@app.local_entrypoint()
def build() -> None:
    print(build_index.remote())
