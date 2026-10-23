import json

import pytest
from fastapi.testclient import TestClient

from backend.corpus import SEP
from backend.synthesis import build_page, run
from backend.tests.conftest import ORIGIN, login_and_call, make_store, passage
from backend.web import create_web_app

T0 = 1_000_000.0
TRADITIONS = [("Stoicism", "aligned"), ("Existentialism", "challenges"), ("Buddhism", "aligned"), ("Kantian ethics", "challenges")]
PLAN = [
    {"lens_id": f"lens-{i}", "tradition": t, "stance": s, "grounded": True, "passage_ids": [f"map{i}"]}
    for i, (t, s) in enumerate(TRADITIONS, 1)
]


def record(phases=("listen", "mapping", "explore", "synthesize"), plan=PLAN, served=(), acked=None, consulted=(), crisis=False):
    served = {p["passage_id"]: p for p in served}
    if acked is None:
        acked = [*served, *(pid for l in plan or [] for pid in l["passage_ids"])]
    return {
        "id": "a" * 32,
        "status": "ending",
        "flags": {"crisis": crisis, "interrupted": False},
        "phases": [{"phase": p, "ts": 1} for p in phases],
        "turns": [{"role": "user", "text": "secret-transcript-text", "ts": 1}, {"role": "guide", "text": "hm", "ts": 2}],
        "summary": "deciding whether to leave",
        "leaning": "stay",
        "lens_plan": plan,
        "consulted_lens_ids": list(consulted),
        "served_passages": served,
        "acked_passage_ids": acked,
    }


def lens(lens_id, citations, tradition=None):
    i = int(lens_id.split("-")[1]) - 1
    return {"lens_id": lens_id, "tradition": tradition or TRADITIONS[i][0], "stance": TRADITIONS[i][1], "take": "t", "citations": citations}


class Model:
    def __init__(self, out):
        self.out, self.calls = out, []

    def __call__(self, prompt, schema):
        self.calls.append((prompt, schema))
        if isinstance(self.out, Exception):
            raise self.out
        return self.out


def page_out(lenses):
    return {"title": "On staying", "situation": "s", "lenses": lenses, "synthesis": "y", "open_questions": ["q?"]}


NOTES = {"title": "Notes", "situation": "s", "open_questions": ["q?"]}


def test_full_page_cites_only_allowlisted_sep_passages():
    served = [passage("p1", words=90), passage("p2")]
    model = Model(page_out([lens("lens-1", ["p1"], "Stoicism"), lens("lens-2", ["p2", "p1"])]))
    page = build_page(record(plan=PLAN[:2], served=served), model)
    assert page["variant"] == "full" and page["title"] == "On staying" and page["unexplored"] == []
    cites = [c for l in page["lenses"] for c in l["citations"]]
    assert [c["passage_id"] for c in cites] == ["p1", "p2", "p1"]
    for c in cites:
        assert c["url"].startswith(f"{SEP}/entries/") and c["entry_title"] == f"Entry {c['passage_id']}"
        assert len(c["excerpt"].split()) <= 60
    assert cites[0]["excerpt"].endswith("…")
    assert not any(l["own_reading"] for l in page["lenses"])
    prompt, schema = model.calls[0]
    assert "lenses" in schema["properties"] and "[p1] Entry p1" in prompt and "misheard" in prompt
    assert "a voice conversation" in prompt


def test_typed_call_tells_the_page_writer_names_may_be_misspelled():
    model = Model(NOTES)
    page = build_page({**record(phases=("listen",), plan=None, acked=[]), "modality": "text"}, model)
    assert page["variant"] == "situation_notes"
    assert "misspelled" in model.calls[0][0] and "a written conversation" in model.calls[0][0]
    assert "misheard" not in model.calls[0][0]


def test_citations_outside_allowlist_or_off_sep_are_dropped_and_rest_kept():
    served = [passage("p1"), passage("served-only"), passage("bad-url", url="https://evil.example/x")]
    model = Model(page_out([lens("lens-1", ["p1", "unknown", "served-only", "bad-url"])]))
    page = build_page(record(plan=PLAN[:1], served=served, acked=["map1", "p1", "bad-url", "never-served"]), model)
    assert [c["passage_id"] for c in page["lenses"][0]["citations"]] == ["p1"]
    assert "served-only" not in model.calls[0][0]


def test_lens_with_all_citations_dropped_is_the_guides_own_reading():
    model = Model(page_out([lens("lens-1", ["p1"]), lens("lens-2", ["made-up"])]))
    page = build_page(record(plan=PLAN[:2], served=[passage("p1")]), model)
    by_id = {l["lens_id"]: l for l in page["lenses"]}
    assert not by_id["lens-1"]["own_reading"]
    assert by_id["lens-2"]["own_reading"] and by_id["lens-2"]["citations"] == []


def test_ae7_ended_mid_explore_lists_unexplored_lenses():
    served = [passage("m1"), passage("r1"), passage("r2")]
    model = Model(page_out([lens(f"lens-{i}", []) for i in range(1, 5)]))
    page = build_page(record(phases=("listen", "mapping", "explore"), served=served, consulted=["lens-1", "lens-2"]), model)
    assert page["variant"] == "partial"
    assert [l["lens_id"] for l in page["lenses"]] == ["lens-1", "lens-2"]
    assert page["unexplored"] == [{"tradition": "Buddhism", "stance": "aligned"}, {"tradition": "Kantian ethics", "stance": "challenges"}]
    prompt = model.calls[0][0]
    assert "ended before the guide finished" in prompt and "lens-3" not in prompt


def test_only_lenses_that_reached_the_model_are_offered_or_listed_unexplored():
    plan = [{**PLAN[0], "passage_ids": []}, *PLAN[1:]]
    model = Model(page_out([lens("lens-1", []), lens("lens-3", [])]))
    page = build_page(record(phases=("listen", "mapping", "explore"), plan=plan, acked=["map2"], consulted=["lens-1"]), model)
    assert page["variant"] == "partial" and [l["lens_id"] for l in page["lenses"]] == ["lens-1"]
    assert page["unexplored"] == [{"tradition": "Existentialism", "stance": "challenges"}]
    assert "Buddhism" not in model.calls[0][0] and "Kantian" not in model.calls[0][0]


@pytest.mark.parametrize(
    "phases,plan,acked",
    [
        (("listen",), None, []),
        (("listen", "mapping"), None, []),
        (("listen", "mapping"), [], []),
        (("listen", "mapping"), PLAN, []),
        (("listen", "mapping"), PLAN, ["p1"]),
    ],
)
def test_r26_no_delivered_lens_gives_situation_notes(phases, plan, acked):
    model = Model(NOTES)
    page = build_page(record(phases=phases, plan=plan, served=[passage("p1")], acked=acked), model)
    assert page["variant"] == "situation_notes" and page["lenses"] == [] and page["synthesis"] is None
    prompt, schema = model.calls[0]
    assert "lenses" not in schema["properties"] and "PASSAGES" not in prompt


def test_ae6_crisis_gives_resources_and_notes_without_asking_for_philosophy():
    model = Model(NOTES)
    page = build_page(record(served=[passage("p1")], crisis=True), model)
    assert page["variant"] == "crisis" and page["lenses"] == [] and page["unexplored"] == []
    prompt, schema = model.calls[0]
    assert "lenses" not in schema["properties"] and "synthesis" not in schema["properties"]
    assert "LENSES" not in prompt and "p1w0" not in prompt and "No philosophy" in prompt


@pytest.fixture
def env(tmp_path, app_env):
    clock = [T0]
    store = make_store(tmp_path, now=lambda: clock[0])
    client = TestClient(create_web_app(call_store=store), base_url="https://testserver")
    call_id = login_and_call(client)
    client.post(f"/api/calls/{call_id}/end", headers=ORIGIN)
    return client, store.root / call_id, store.spawned, clock


def test_model_error_fails_then_retry_reaches_ready_without_touching_record(env, capsys):
    client, call_dir, spawned, _ = env
    call_id = call_dir.name
    url = f"/api/calls/{call_id}"
    before = (call_dir / "record.json").read_bytes()

    assert run(call_dir, Model(RuntimeError("boom")), lambda: None, lambda: None) == "failed"
    assert (call_dir / "record.json").read_bytes() == before
    got = client.get(url).json()
    assert got["status"] == "failed" and got["synthesis"]["error"] == "The page couldn't be written."

    assert client.post(f"{url}/retry", headers=ORIGIN).status_code == 202
    assert spawned == [call_id, call_id]
    assert client.get(url).json()["status"] == "generating"
    assert client.post(f"{url}/retry", headers=ORIGIN).status_code == 409

    before = (call_dir / "record.json").read_bytes()
    assert run(call_dir, Model(NOTES), lambda: None, lambda: None) == "ready"
    assert (call_dir / "record.json").read_bytes() == before
    got = client.get(url).json()
    assert got["status"] == "ready" and got["synthesis"]["page"]["variant"] == "situation_notes"
    assert client.get("/api/calls").json()[0]["title"] == "Notes"
    assert client.post(f"{url}/retry", headers=ORIGIN).status_code == 409
    assert "secret-transcript-text" not in capsys.readouterr().out


def test_stuck_generating_reads_as_failed_and_can_be_retried(env):
    client, call_dir, spawned, clock = env
    (call_dir / "synthesis.json").write_text(json.dumps({"status": "generating", "attempt": 1}))
    url = f"/api/calls/{call_dir.name}"
    assert client.get(url).json()["status"] == "generating"
    assert client.post(f"{url}/retry", headers=ORIGIN).status_code == 409
    clock[0] += 11 * 60
    assert client.get(url).json()["status"] == "failed"
    assert client.post(f"{url}/retry", headers=ORIGIN).status_code == 202
    assert len(spawned) == 2


def test_job_writes_nothing_for_a_call_deleted_mid_generation(env):
    client, call_dir, _, _ = env

    def generate(prompt, schema):
        assert client.delete(f"/api/calls/{call_dir.name}", headers=ORIGIN).status_code == 204
        return NOTES

    run(call_dir, generate, lambda: None, lambda: None)
    assert not call_dir.exists()
