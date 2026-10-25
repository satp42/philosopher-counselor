import modal

from backend.corpus.crawl import build_entries, crawl
from backend.eval.run_eval import evaluate
from backend.modal_app import DATA, app, auth_secret, gemini_secret, volume, web_image
from backend.retrieval.build_index import build_index
from backend.retrieval.retriever import RetrieverClient
from backend.synthesis_job import start_synthesis

# Imported at module scope so the memory snapshot captures them (~1.2s of each cold start).
with web_image.imports():
    from pathlib import Path

    from backend.calls import CallStore
    from backend.converse import gemini_turn
    from backend.live_token import gemini_client, mint_token
    from backend.web import create_web_app

# Re-exported so they can be spawned detached from any local client.
__all__ = ["app", "build_entries", "build_index", "crawl", "evaluate", "web"]


# scaledown_window: the default 60s idle shutdown put a ~6s cold start in front of most page loads.
@app.function(
    image=web_image,
    secrets=[auth_secret, gemini_secret],
    volumes={DATA: volume},
    max_containers=1,
    scaledown_window=60 * 60,
    enable_memory_snapshot=True,
)
@modal.concurrent(max_inputs=100)
@modal.asgi_app()
def web():
    gemini = gemini_client()

    store = CallStore(
        Path(f"{DATA}/calls"),
        commit=volume.commit.aio,
        reload=volume.reload.aio,
        spawn_synthesis=lambda call_id, tenant_id: start_synthesis.spawn.aio(call_id, tenant_id),
    )
    return create_web_app(
        static_dir="/app/frontend/dist",
        call_store=store,
        mint_token=lambda handle, variant, memory=None: mint_token(gemini, handle, variant, memory=memory),
        retriever=RetrieverClient(),
        converse=gemini_turn(gemini),
    )
