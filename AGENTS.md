# Agent instructions

Contributors here are mostly coding agents. Prefer the supported path in each row; the enforcement column is what breaks the build if you drift.

## Rule table

| Rule | Mistake class | Enforced by |
|------|---------------|-------------|
| Every `Modality` has a stale window in `STALE_AFTER` | Voice-default stale sweep deleted text calls | Import assert in `backend/calls.py`; `test_stale_after_covers_every_modality` |
| Tool names match between Python and the Live dispatcher | Hand-synced PY/TS tool lists drift | `test_tool_names_are_the_contract`; `test_frontend_tool_handlers_match_python_tool_names` |
| Live tools use `NON_BLOCKING`; text/`generateContent` tools do not | Live Gemini flags copied into REST | `test_every_tool_is_non_blocking_without_scheduling`; `test_non_blocking_is_live_only` |
| `/api/converse` never writes the call record | Dual writers break recorder seq/idempotency | Module doc in `converse.py`; `test_text_call_runs_through_converse_lens_map_and_the_page` |
| Voice calls use `/api/token`; text calls use `/api/converse` | Cross-wired modality APIs | 409 guards + `test_voice_call_cannot_converse_and_a_blocked_reply_is_withheld` |
| Crisis blocks SEP retrieval on the server | Client-only crisis gate bypassed via API | `retrieval/routes.py` + `test_crisis_blocks_retrieval_for_the_rest_of_the_call` |
| Modal warm `spawn.get` timeout means still warming, not failure | Dropped warm handle → never ready | `test_unfinished_warm_keeps_waiting` |
| Tab title stays plain until unlock | View names leaked on lock screen | `frontend/src/documentTitle.ts` + `documentTitle.test.ts` |
| Warm poll and Live SDK preload only after unlock | Side effects before access gate | `useCallEngine` + `useCallEngine.test.ts` |
| HTTP error `detail` is a fixed string, never `str(e)` | Upstream errors and secrets in JSON | `test_http_exception_details_do_not_echo_exceptions` |
| Synthesis copy matches modality (`HEARD` / `CONVERSATION`) | Voice wording on text pages | Import assert in `backend/synthesis.py` |
| Recorder is the sole sequence producer | Converse or API appends turns | `recorder.ts` ponytail note; converse integration tests |

## Modality checklist

When adding or changing a call modality:

1. Extend `Modality` and `{voice}`/`{text}` tags in `backend/guide/config.py` (import fails on typos).
2. Add `STALE_AFTER`, synthesis strings, and route guards (`live_token` vs `converse`).
3. Reuse `createDispatcher`, `createRecorder`, and `closeCall` — do not fork hang-up or tool HTTP.
4. Add cross-modality negative tests (409 when the wrong API is used).

## Modal patterns

- Pending `.get()` on a spawned warm call raises builtin `TimeoutError`, not only `modal.exception.TimeoutError`. Treat both as “still warming”.
- Heavy imports for the web tier belong in `web_image.imports()` with `enable_memory_snapshot=True` on the function.
- Cross-container visibility for call records requires explicit `volume.commit()` at create/end/retry boundaries (see header comment in `calls.py`).

## Running checks

```bash
uv sync
uv run pytest -q backend/tests
cd frontend && npm test -- --run
```

Python pins live in `pyproject.toml` / `uv.lock` (keep aligned with `backend/modal_app.py` for deploy).

CI runs the same on push and pull requests to `main`.
