"""Modal registration for the synthesis job. Kept apart from backend/synthesis.py so `modal deploy`
can import the app locally without the job's runtime deps (pydantic) installed."""

from pathlib import Path

from backend.modal_app import DATA, _python_base, _with_backend, app, gemini_secret, volume


@app.function(image=_with_backend(_python_base), secrets=[gemini_secret], volumes={DATA: volume}, timeout=300)
def start_synthesis(call_id: str, tenant_id: str | None = None) -> None:
    from backend.auth import DEFAULT_TENANT
    from backend.live_token import gemini_client
    from backend.synthesis import gemini_generate, run

    tid = tenant_id or DEFAULT_TENANT
    run(Path(DATA) / "calls" / tid / call_id, gemini_generate(gemini_client()), volume.commit, volume.reload)
