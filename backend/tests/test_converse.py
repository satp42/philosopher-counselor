import json

from fastapi.testclient import TestClient

from backend.converse import _memo, _render, _reply, _unmemo
from backend.synthesis import build_page
from backend.tests.conftest import ORIGIN, login, make_store, passage
from backend.web import create_web_app

LENSES = [
    {"tradition": "Stoicism", "query": "a promise", "stance": "aligned"},
    {"tradition": "Existentialism", "query": "a promise", "stance": "challenges"},
]


class FakeRetriever:
    async def warm(self):
        return None

    async def ready(self):
        return True

    async def search(self, query):
        return {"grounded": True, "passages": [passage("kant:1")]}

    async def lens_map(self, lenses):
        out = [
            {
                "lens_id": f"lens-{i + 1}",
                "tradition": lens["tradition"],
                "stance": lens["stance"],
                "grounded": True,
                "passages": [passage(f"e{i}:0")],
            }
            for i, lens in enumerate(lenses)
        ]
        return {"lenses": out, "challenges_grounded": True}


def app(tmp_path, generate, clock=None):
    store = make_store(tmp_path, **({"now": clock} if clock else {}))
    client = TestClient(
        create_web_app(call_store=store, retriever=FakeRetriever(), converse=generate, mint_token=lambda h, v: "t"),
        base_url="https://testserver",
    )
    login(client)
    return client, store


def test_text_call_runs_through_converse_lens_map_and_the_page(tmp_path, app_env):
    seen = []

    async def generate(contents):
        seen.append(contents)
        if len(seen) == 1:
            return {
                "role": "model",
                "parts": [
                    {"text": "Let me sit with this."},
                    {
                        "function_call": {"name": "map_lenses", "id": "call-1", "args": {"lenses": LENSES}},
                        "thought_signature": "sig-1",
                    },
                ],
            }
        return {"role": "model", "parts": [{"text": "Stoicism would notice the promise you made."}]}

    client, store = app(tmp_path, generate)
    created = client.post("/api/calls", json={"modality": "text"}, headers=ORIGIN)
    assert created.status_code == 201
    call_id = created.json()["id"]
    record = json.loads((store.root / call_id / "record.json").read_text())
    assert record["modality"] == "text" and record["variant"] is None
    assert client.post("/api/token", json={"call_id": call_id}, headers=ORIGIN).status_code == 409

    first = client.post(
        "/api/converse",
        json={"call_id": call_id, "history": [{"kind": "user", "text": "My sister asked me to co-sign."}]},
        headers=ORIGIN,
    )
    assert first.status_code == 200
    reply = first.json()
    assert reply["kind"] == "reply" and reply["calls"][0]["id"] == "call-1"
    assert _unmemo(reply["memo"])["parts"][1]["thought_signature"] == "sig-1"
    assert json.loads((store.root / call_id / "record.json").read_text())["turns"] == []

    mapped = client.post("/api/lens-map", json={"call_id": call_id, "lenses": LENSES}, headers=ORIGIN)
    assert mapped.status_code == 200

    second = client.post(
        "/api/converse",
        json={
            "call_id": call_id,
            "history": [
                {"kind": "user", "text": "My sister asked me to co-sign."},
                {
                    "kind": "guide",
                    "memo": reply["memo"],
                    "results": [{"id": "call-1", "name": "map_lenses", "response": {"lenses": mapped.json()["lenses"]}}],
                },
            ],
        },
        headers=ORIGIN,
    )
    assert second.status_code == 200 and second.json()["text"].startswith("Stoicism")
    echoed = seen[1][1]
    assert echoed["parts"][1]["thought_signature"] == "sig-1"
    assert echoed["parts"][1]["function_call"]["id"] == "call-1"
    assert seen[1][2]["parts"][0]["function_response"]["id"] == "call-1"

    events = {
        "events": [
            {"seq": 1, "type": "turn", "role": "user", "text": "My sister asked me to co-sign.", "ts": 1},
            {"seq": 2, "type": "turn", "role": "guide", "text": second.json()["text"], "ts": 2},
        ]
    }
    assert client.post(f"/api/calls/{call_id}/events", json=events, headers=ORIGIN).status_code == 204
    assert client.post(f"/api/calls/{call_id}/end", headers=ORIGIN).status_code == 202

    prompts = []

    def page_model(prompt, schema):
        prompts.append(prompt)
        return {"title": "A promise", "situation": "s", "open_questions": ["q?"]}

    page = build_page(json.loads((store.root / call_id / "record.json").read_text()), page_model)
    assert page["variant"] == "situation_notes"
    assert "written conversation" in prompts[0] and "misspelled" in prompts[0]
    assert "My sister asked me to co-sign." in prompts[0]


def test_voice_call_cannot_converse_and_a_blocked_reply_is_withheld(tmp_path, app_env):
    async def generate(contents):
        return None

    client, _ = app(tmp_path, generate)
    voice = client.post("/api/calls", headers=ORIGIN).json()["id"]
    history = {"call_id": voice, "history": [{"kind": "user", "text": "hello"}]}
    assert client.post("/api/converse", json=history, headers=ORIGIN).status_code == 409

    client.post(f"/api/calls/{voice}/end", headers=ORIGIN)
    text = client.post("/api/calls", json={"modality": "text"}, headers=ORIGIN).json()["id"]
    withheld = client.post("/api/converse", json={**history, "call_id": text}, headers=ORIGIN)
    assert withheld.status_code == 200 and withheld.json() == {"kind": "withheld"}


def test_crisis_blocks_retrieval_for_the_rest_of_the_call(tmp_path, app_env):
    async def generate(contents):
        return None

    client, _ = app(tmp_path, generate)
    call_id = client.post("/api/calls", json={"modality": "text"}, headers=ORIGIN).json()["id"]
    flag = {"events": [{"seq": 1, "type": "flag", "flag": "crisis"}]}
    assert client.post(f"/api/calls/{call_id}/events", json=flag, headers=ORIGIN).status_code == 204
    assert client.post("/api/retrieve", json={"call_id": call_id, "query": "stoicism"}, headers=ORIGIN).status_code == 403
    assert client.post("/api/lens-map", json={"call_id": call_id, "lenses": LENSES}, headers=ORIGIN).status_code == 403


def test_bad_history_is_422_and_an_oversized_body_is_413(tmp_path, app_env):
    async def generate(contents):
        raise AssertionError("generator should not run")

    client, _ = app(tmp_path, generate)
    call_id = client.post("/api/calls", json={"modality": "text"}, headers=ORIGIN).json()["id"]
    bad = client.post(
        "/api/converse",
        json={"call_id": call_id, "history": [{"kind": "guide", "memo": "%%%", "results": []}]},
        headers=ORIGIN,
    )
    assert bad.status_code == 422
    huge = client.post("/api/converse", content=b'{"call_id":"x","history":[]}' + b" " * (1024 * 1024), headers=ORIGIN)
    assert huge.status_code == 413


def test_memo_round_trips_a_thought_signature_and_assigns_missing_ids():
    content = {"role": "model", "parts": [{"function_call": {"name": "set_phase", "args": {"phase": "explore"}}, "thought_signature": "abc"}]}
    memo = _memo(content)
    assert _unmemo(memo) == content
    reply = _reply(content, 0)
    assert reply.calls[0].id == "g0-0" and reply.memo == memo
    from backend.converse import GuideItem, ToolResult, UserItem

    rendered = _render(
        [
            UserItem(kind="user", text="hello"),
            GuideItem(kind="guide", memo=memo, results=[ToolResult(id="g0-0", name="set_phase", response={"phase": "explore"})]),
        ]
    )
    assert rendered[1]["parts"][0]["thought_signature"] == "abc"
    assert "id" not in rendered[2]["parts"][0]["function_response"]
    assert _reply(None, 1).kind == "withheld"
