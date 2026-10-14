import numpy as np
import pytest
from fastapi.testclient import TestClient
from scipy import sparse

from backend.retrieval import search
from backend.retrieval.chunk import excerpt
from backend.retrieval.search import assign_lenses, bm25_index, bm25_top, passage_out, ppr, ppr_blend, rrf, top_passages
from backend.tests.conftest import ORIGIN, login_and_call, make_store, passage
from backend.web import create_web_app

SECRET_QUERY = "my sister's divorce and the inheritance"


def graph(n, edges):
    a = sparse.coo_matrix((np.ones(len(edges)), tuple(zip(*edges))), shape=(n, n)).tocsr()
    return ((a + a.T) > 0).astype(np.float32)


def test_rrf_fuses_two_rankings():
    assert rrf([[1, 2, 3], [3, 1, 4]]) == [1, 3, 2, 4]


def test_ppr_ranks_neighbors_above_non_neighbors():
    r = ppr(graph(5, [(0, 1), (0, 2), (3, 4)]), np.array([1.0, 0, 0, 0, 0]))
    assert min(r[1], r[2]) > max(r[3], r[4])
    assert r[0] == r.max()


def test_ppr_blend_breaks_ties_toward_related_entries():
    scores = np.array([0.9, 0.5, 0.5])
    blended = ppr_blend(scores, np.array([0, 1, 3]), graph(5, [(0, 1), (3, 4)]))
    assert blended[1] > blended[2]


def test_quick_lookup_caps_passages_per_entry():
    assert top_passages([10, 11, 12, 13], [0.9, 0.8, 0.7, 0.6], [0, 0, 0, 1]) == [(10, 0.9), (11, 0.8), (13, 0.6)]


def test_quick_lookup_drops_passages_below_floor():
    assert top_passages([10, 11], [0.9, search.SCORE_FLOOR - 0.01], [0, 1]) == [(10, 0.9)]


def test_two_lenses_wanting_one_entry_get_distinct_entries_with_optimal_total():
    cands = [
        [(100, 0, 0.9), (101, 1, 0.8)],
        [(200, 0, 0.85), (201, 1, 0.5)],
    ]
    lenses, _ = assign_lenses(cands, ["aligned", "aligned"])
    assert lenses[0]["passages"] == [(101, 0.8)] and lenses[1]["passages"] == [(200, 0.85)]


def test_lens_below_floor_is_ungrounded_and_challenges_flag_false():
    cands = [[(100, 0, 0.9), (102, 0, 0.7), (103, 0, 0.6)], [(200, 1, 0.1)]]
    lenses, challenges_grounded = assign_lenses(cands, ["aligned", "challenges"])
    assert lenses[0]["grounded"] and lenses[0]["passages"] == [(100, 0.9), (102, 0.7)]
    assert lenses[1] == {"lens": 1, "grounded": False, "passages": []}
    assert challenges_grounded is False


def test_grounded_challenges_lens_sets_flag():
    _, challenges_grounded = assign_lenses([[(1, 0, 0.9)], [(2, 1, 0.8)]], ["aligned", "challenges"])
    assert challenges_grounded is True


def test_lens_map_keeps_at_most_five_grounded_and_the_challenger():
    cands = [[(i, i, 0.9 - i * 0.1)] for i in range(6)]
    stances = ["aligned"] * 5 + ["challenges"]
    lenses, challenges_grounded = assign_lenses(cands, stances)
    assert [lens["lens"] for lens in lenses] == [0, 1, 2, 3, 5]
    assert challenges_grounded is True


def test_bm25_ranks_lexical_match_first_and_ignores_unknown_words():
    index = bm25_index(["the anxiety of choice and dread", "virtue and the good life", "free will and determinism"])
    lexical, unknown, stopwords, virtue = bm25_top(index, ["dread and anxiety", "zzzz qqqq", "the and of", "virtue"])
    assert lexical[0] == 0 and virtue == [1]
    assert unknown == [] and stopwords == []


def test_passage_shape_and_excerpt():
    p = {"id": "kant:3", "slug": "kant", "entry_title": "Immanuel Kant", "section_path": ["2. Ethics", "2.1 Duty"],
         "anchor_url": "https://plato.stanford.edu/entries/kant/#Eth", "prefix": "x", "text": " ".join(["w"] * 100)}
    out = passage_out(p, np.float64(0.876543))
    assert set(out) == {"passage_id", "slug", "entry_title", "section_path", "url", "text", "excerpt", "score"}
    assert out["section_path"] == "2. Ethics > 2.1 Duty"
    assert passage_out({**p, "section_path": []}, 0.5)["section_path"] == ""
    assert type(out["score"]) is float and out["score"] == 0.8765 and out["url"] == p["anchor_url"]
    assert len(out["excerpt"].split()) == 60
    assert excerpt("short text") == "short text"


class FakeRetriever:
    def __init__(self):
        self.warmed = 0
        self.fail = False

    async def warm(self):
        self.warmed += 1

    async def ready(self):
        return self.warmed > 0

    async def search(self, query):
        if self.fail:
            raise RuntimeError(f"upstream: key AIzaSECRET rejected query {query}")
        return {"grounded": True, "passages": [passage("kant:1"), passage("hume:2")]}

    async def lens_map(self, lenses):
        if self.fail:
            raise RuntimeError(f"upstream: key AIzaSECRET rejected lenses {lenses}")
        out = [{"lens_id": f"lens-{i + 1}", "tradition": lens["tradition"], "stance": lens["stance"], "grounded": True,
                "passages": [passage(f"e{i}:0")]} for i, lens in enumerate(lenses)]
        return {"lenses": out, "challenges_grounded": True}


@pytest.fixture
def env(app_env, tmp_path):
    store = make_store(tmp_path)
    retriever = FakeRetriever()
    client = TestClient(create_web_app(call_store=store, retriever=retriever), base_url="https://testserver")
    return client, store, retriever


LENSES = [{"tradition": "Stoicism", "query": "q1", "stance": "aligned"}, {"tradition": "Existentialism", "query": "q2", "stance": "challenges"}]


def test_retrieval_routes_require_session(env):
    client, _, _ = env
    assert client.post("/api/retrieve", json={"call_id": "a" * 32, "query": "x"}, headers=ORIGIN).status_code == 401
    assert client.post("/api/lens-map", json={"call_id": "a" * 32, "lenses": LENSES}, headers=ORIGIN).status_code == 401
    assert client.post("/api/warm", headers=ORIGIN).status_code == 401
    assert client.get("/api/warm/status").status_code == 401


def test_retrieve_refused_for_ended_call(env):
    client, _, _ = env
    call_id = login_and_call(client)
    client.post(f"/api/calls/{call_id}/end", headers=ORIGIN)
    assert client.post("/api/retrieve", json={"call_id": call_id, "query": "x"}, headers=ORIGIN).status_code == 409
    assert client.post("/api/lens-map", json={"call_id": call_id, "lenses": LENSES}, headers=ORIGIN).status_code == 409


def test_retrieve_returns_passages_and_records_them_served(env, capsys):
    client, store, _ = env
    call_id = login_and_call(client)
    r = client.post("/api/retrieve", json={"call_id": call_id, "query": SECRET_QUERY, "lens_id": "lens-2", "stance": "challenges"}, headers=ORIGIN)
    assert r.status_code == 200
    body = r.json()
    assert list(body) == ["lens_id", "stance", "grounded", "passages"]
    assert (body["lens_id"], body["stance"], body["grounded"]) == ("lens-2", "challenges", True)
    rec = store._read(call_id)
    assert set(rec["served_passages"]) == {"kant:1", "hume:2"}
    assert rec["consulted_lens_ids"] == ["lens-2"]
    assert "divorce" not in capsys.readouterr().out
    client.post("/api/retrieve", json={"call_id": call_id, "query": "follow-up"}, headers=ORIGIN)
    assert store._read(call_id)["consulted_lens_ids"] == ["lens-2"]


def test_lens_map_records_every_lens_passage(env):
    client, store, _ = env
    call_id = login_and_call(client)
    r = client.post("/api/lens-map", json={"call_id": call_id, "lenses": LENSES}, headers=ORIGIN)
    assert r.status_code == 200
    assert r.json()["challenges_grounded"] is True
    assert [lens["lens_id"] for lens in r.json()["lenses"]] == ["m1-lens-1", "m1-lens-2"]
    rec = store._read(call_id)
    assert set(rec["served_passages"]) == {"e0:0", "e1:0"}
    assert rec["lens_plan"] == [
        {"lens_id": "m1-lens-1", "tradition": "Stoicism", "stance": "aligned", "grounded": True, "passage_ids": ["e0:0"]},
        {"lens_id": "m1-lens-2", "tradition": "Existentialism", "stance": "challenges", "grounded": True, "passage_ids": ["e1:0"]},
    ]
    assert rec["consulted_lens_ids"] == []


def test_remapping_gives_fresh_lens_ids_so_old_consults_dont_carry_over(env):
    client, store, _ = env
    call_id = login_and_call(client)
    client.post("/api/lens-map", json={"call_id": call_id, "lenses": LENSES}, headers=ORIGIN)
    client.post("/api/retrieve", json={"call_id": call_id, "query": "q", "lens_id": "m1-lens-1"}, headers=ORIGIN)
    r = client.post("/api/lens-map", json={"call_id": call_id, "lenses": LENSES}, headers=ORIGIN)
    assert [lens["lens_id"] for lens in r.json()["lenses"]] == ["m2-lens-1", "m2-lens-2"]
    rec = store._read(call_id)
    assert [lens["lens_id"] for lens in rec["lens_plan"]] == ["m2-lens-1", "m2-lens-2"]
    assert rec["consulted_lens_ids"] == ["m1-lens-1"]


@pytest.mark.parametrize("path,body", [("/api/retrieve", {"query": SECRET_QUERY}), ("/api/lens-map", {"lenses": LENSES})])
def test_retriever_failure_is_502_without_leaking_or_recording(env, capsys, path, body):
    client, store, retriever = env
    call_id = login_and_call(client)
    retriever.fail = True
    r = client.post(path, json={"call_id": call_id, **body}, headers=ORIGIN)
    assert r.status_code == 502 and r.json() == {"detail": "retrieval unavailable"}
    out = capsys.readouterr().out
    for leak in ("AIza", "divorce", "q1"):
        assert leak not in r.text and leak not in out
    rec = store._read(call_id)
    assert rec["served_passages"] == {} and rec["lens_plan"] is None and rec["consulted_lens_ids"] == []


@pytest.mark.parametrize(
    "lenses",
    [LENSES[:1], LENSES * 5, [{"tradition": "x" * 121, "query": "q", "stance": "aligned"}] * 2, [{"tradition": "x", "query": "q", "stance": "neutral"}] * 2],
)
def test_lens_map_validates_input(env, lenses):
    client, _, _ = env
    call_id = login_and_call(client)
    assert client.post("/api/lens-map", json={"call_id": call_id, "lenses": lenses}, headers=ORIGIN).status_code == 422


def test_overlong_query_rejected(env):
    client, _, _ = env
    call_id = login_and_call(client)
    assert client.post("/api/retrieve", json={"call_id": call_id, "query": "x" * 1001}, headers=ORIGIN).status_code == 422


def test_warm_spawns_and_status_reports_ready(env):
    client, _, retriever = env
    login_and_call(client)
    assert client.get("/api/warm/status").json() == {"ready": False}
    assert client.post("/api/warm", headers=ORIGIN).status_code == 202
    assert retriever.warmed == 1
    assert client.get("/api/warm/status").json() == {"ready": True}


def test_match_title_pins_entry_named_after_tradition():
    from backend.retrieval.search import match_title

    titles = ["Desire", "Stoicism", "Søren Kierkegaard", "Confucius"]
    assert match_title("Stoicism", titles) == 1
    assert match_title("stoicism ", titles) == 1
    assert match_title("Confucianism", titles) is None
    assert match_title("Buddhism", titles) is None
