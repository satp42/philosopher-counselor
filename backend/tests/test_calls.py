import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.calls import MAX_BATCH_BYTES, EventBatch
from backend.tests.conftest import ORIGIN, login, make_store, passage
from backend.web import create_web_app

T0 = 1_000_000.0


@pytest.fixture
def env(tmp_path, app_env):
    clock = [T0]
    store = make_store(tmp_path, now=lambda: clock[0])
    client = TestClient(create_web_app(call_store=store), base_url="https://testserver")
    login(client)
    return SimpleNamespace(store=store, clock=clock, spawned=store.spawned, client=client, root=store.root)


def turns(start, n, text="t"):
    return {"events": [{"seq": s, "type": "turn", "role": "user", "text": f"{text}{s}", "ts": s} for s in range(start, start + n)]}


def create(env):
    r = env.client.post("/api/calls", headers=ORIGIN)
    assert r.status_code == 201
    return r.json()["id"]


def post(env, call_id, body):
    return env.client.post(f"/api/calls/{call_id}/events", json=body, headers=ORIGIN)


def get(env, call_id):
    return env.client.get(f"/api/calls/{call_id}").json()


def test_create_events_end_happy_path(env):
    call_id = create(env)
    assert post(env, call_id, turns(1, 3)).status_code == 204
    r = env.client.post(f"/api/calls/{call_id}/end", headers=ORIGIN)
    assert r.status_code == 202
    rec = get(env, call_id)
    assert [t["text"] for t in rec["turns"]] == ["t1", "t2", "t3"]
    assert rec["status"] == "generating" and rec["attempts"] == 1
    assert env.spawned == [call_id]
    assert env.client.post(f"/api/calls/{call_id}/end", headers=ORIGIN).status_code == 202
    assert env.spawned == [call_id]


def test_duplicate_batch_is_stored_once(env):
    call_id = create(env)
    post(env, call_id, turns(1, 2))
    post(env, call_id, turns(1, 2))
    assert len(get(env, call_id)["turns"]) == 2


def test_all_event_types_apply(env):
    call_id = create(env)
    events = [
        {"seq": 1, "type": "phase", "phase": "listen", "ts": 1},
        {"seq": 2, "type": "summary", "summary": "s", "leaning": "l"},
        {"seq": 3, "type": "ack", "passage_ids": ["p1", "p1"]},
        {"seq": 4, "type": "flag", "flag": "crisis"},
    ]
    assert post(env, call_id, {"events": events}).status_code == 204
    rec = get(env, call_id)
    assert rec["phases"] == [{"phase": "listen", "ts": 1}]
    assert (rec["summary"], rec["leaning"]) == ("s", "l")
    assert rec["acked_passage_ids"] == ["p1"]
    assert rec["flags"]["crisis"] and rec["last_seq"] == 4


def test_invalid_event_is_422(env):
    call_id = create(env)
    assert post(env, call_id, {"events": [{"seq": 1, "type": "nope"}]}).status_code == 422
    assert post(env, call_id, {"events": [{"seq": 0, "type": "flag", "flag": "crisis"}]}).status_code == 422
    lens_plan = {"seq": 1, "type": "lens_plan", "lens_plan": []}
    assert post(env, call_id, {"events": [lens_plan]}).status_code == 422


def test_batch_over_64kb_is_413_and_record_unchanged(env):
    call_id = create(env)
    post(env, call_id, turns(1, 1))
    big = turns(2, 1, text="x" * MAX_BATCH_BYTES)
    assert post(env, call_id, big).status_code == 413
    rec = get(env, call_id)
    assert len(rec["turns"]) == 1 and rec["last_seq"] == 1


def test_record_over_2mb_is_413_without_writing(env):
    call_id = create(env)
    for seq in range(1, 60):
        r = post(env, call_id, turns(seq, 1, text="x" * 60_000))
        if r.status_code == 413:
            break
        assert r.status_code == 204
    assert r.status_code == 413
    rec = get(env, call_id)
    assert rec["last_seq"] == seq - 1 and len(rec["turns"]) == seq - 1


def test_second_create_is_409_then_end_and_create_succeeds(env):
    call_id = create(env)
    r = env.client.post("/api/calls", headers=ORIGIN)
    assert r.status_code == 409
    assert r.json()["detail"] == {"active_id": call_id, "started_at": T0}
    env.client.post(f"/api/calls/{call_id}/end", headers=ORIGIN)
    assert create(env) != call_id


def test_unknown_and_ended_calls(env):
    assert post(env, "0" * 32, turns(1, 1)).status_code == 404
    assert env.client.post(f"/api/calls/{'0' * 32}/end", headers=ORIGIN).status_code == 404
    with pytest.raises(HTTPException) as err:
        asyncio.run(env.store.delete(".."))
    assert err.value.status_code == 404 and env.root.exists()
    call_id = create(env)
    env.client.post(f"/api/calls/{call_id}/end", json={"interrupted": True}, headers=ORIGIN)
    assert post(env, call_id, turns(1, 1)).status_code == 409
    assert get(env, call_id)["flags"]["interrupted"]


def test_stale_call_is_swept_on_list_and_fresh_one_left_alone(env):
    call_id = create(env)
    env.clock[0] += 10 * 60
    assert env.client.get("/api/calls").json()[0]["status"] == "active"
    assert env.spawned == []
    env.clock[0] += 6 * 60
    assert env.client.get("/api/calls").json()[0]["status"] == "generating"
    assert get(env, call_id)["flags"]["interrupted"]
    assert env.spawned == [call_id]


def test_stale_call_is_swept_when_read_directly(env):
    call_id = create(env)
    env.clock[0] += 16 * 60
    rec = get(env, call_id)
    assert rec["status"] == "generating" and rec["flags"]["interrupted"]
    assert env.spawned == [call_id]


def test_events_keep_a_call_fresh(env):
    call_id = create(env)
    env.clock[0] += 10 * 60
    post(env, call_id, turns(1, 1))
    env.clock[0] += 10 * 60
    assert env.client.get("/api/calls").json()[0]["status"] == "active"


def test_create_after_stale_call_sweeps_it(env):
    stale = create(env)
    env.clock[0] += 16 * 60
    fresh = create(env)
    assert fresh != stale and env.spawned == [stale]


def test_end_and_sweep_race_requests_synthesis_once(env):
    call_id = create(env)
    env.clock[0] += 16 * 60

    async def race():
        await asyncio.gather(
            env.store.end_call(call_id), env.store.list_calls(), env.store.end_call(call_id), env.store.list_calls()
        )

    asyncio.run(race())
    assert env.spawned == [call_id]


def test_concurrent_event_posts_lose_no_turns(env):
    call_id = create(env)

    async def burst():
        await asyncio.gather(
            *(env.store.append_events(call_id, EventBatch.model_validate(turns(1 + 3 * i, 3)).events) for i in range(6))
        )

    asyncio.run(burst())
    assert [t["text"] for t in get(env, call_id)["turns"]] == [f"t{s}" for s in range(1, 19)]


def test_record_served_only_for_active_calls(env):
    call_id = create(env)
    p1 = passage("p1", text="long passage text", excerpt="long passage text")
    asyncio.run(env.store.record_served(call_id, [p1]))
    rec = get(env, call_id)
    assert rec["served_passage_ids"] == ["p1"]
    assert "long passage text" not in json.dumps(rec)
    assert json.loads((env.root / call_id / "record.json").read_text())["served_passages"]["p1"] == p1
    env.client.post(f"/api/calls/{call_id}/end", headers=ORIGIN)
    with pytest.raises(HTTPException) as err:
        asyncio.run(env.store.record_served(call_id, [p1]))
    assert err.value.status_code == 409


def test_record_served_keeps_lens_plan_and_consulted_lenses(env):
    call_id = create(env)
    plan = [{"lens_id": "lens-1", "tradition": "Stoicism", "stance": "aligned", "grounded": True}]
    recorded = asyncio.run(env.store.record_served(call_id, [passage("p1")], lens_plan=plan))
    assert recorded == [{**plan[0], "lens_id": "m1-lens-1"}]
    for lens_id in ("m1-lens-1", None, "m1-lens-1", "m1-lens-2"):
        asyncio.run(env.store.record_served(call_id, [], consulted_lens_id=lens_id))
    rec = get(env, call_id)
    assert rec["lens_plan"] == recorded and rec["consulted_lens_ids"] == ["m1-lens-1", "m1-lens-2"]
    assert asyncio.run(env.store.record_served(call_id, [], lens_plan=plan))[0]["lens_id"] == "m2-lens-1"


def test_unreadable_record_is_skipped_and_logged_by_id_only(env, capsys):
    bad = "b" * 32
    (env.root / bad).mkdir()
    (env.root / bad / "record.json").write_text('{"id": "' + bad + '", "turns": [{"text": "secret-trunc')
    call_id = create(env)
    assert [c["id"] for c in env.client.get("/api/calls").json()] == [call_id]
    out = capsys.readouterr().out
    assert f"call {bad} record unreadable" in out and "secret-trunc" not in out
    assert [p.name for p in (env.root / call_id).iterdir()] == ["record.json"]
    assert env.client.delete(f"/api/calls/{bad}", headers=ORIGIN).status_code == 204


def test_synthesis_file_overrides_displayed_status(env):
    call_id = create(env)
    env.client.post(f"/api/calls/{call_id}/end", headers=ORIGIN)
    synth = {"status": "ready", "attempt": 1, "page": {"title": "On leaving"}}
    (env.root / call_id / "synthesis.json").write_text(json.dumps(synth))
    listed = env.client.get("/api/calls").json()
    assert listed == [{"id": call_id, "started_at": T0, "status": "ready", "title": "On leaving"}]
    assert get(env, call_id)["synthesis"] == synth


def test_list_is_newest_first_and_delete_removes(env):
    first = create(env)
    env.client.post(f"/api/calls/{first}/end", headers=ORIGIN)
    env.clock[0] += 60
    second = create(env)
    assert [c["id"] for c in env.client.get("/api/calls").json()] == [second, first]
    assert env.client.delete(f"/api/calls/{first}", headers=ORIGIN).status_code == 204
    assert [c["id"] for c in env.client.get("/api/calls").json()] == [second]
    assert env.client.get(f"/api/calls/{first}").status_code == 404


def test_call_routes_require_session_and_origin(env):
    call_id = create(env)
    anon = TestClient(env.client.app, base_url="https://testserver")
    assert anon.get("/api/calls").status_code == 401
    assert anon.get(f"/api/calls/{call_id}").status_code == 401
    assert anon.post("/api/calls", headers=ORIGIN).status_code == 401
    assert anon.post(f"/api/calls/{call_id}/events", json=turns(1, 1), headers=ORIGIN).status_code == 401
    assert anon.post(f"/api/calls/{call_id}/end", headers=ORIGIN).status_code == 401
    assert anon.delete(f"/api/calls/{call_id}", headers=ORIGIN).status_code == 401
    evil = {"origin": "https://evil.example"}
    assert post(env, call_id, turns(1, 1)).status_code == 204
    assert env.client.post(f"/api/calls/{call_id}/events", json=turns(2, 1), headers=evil).status_code == 403
    assert env.client.delete(f"/api/calls/{call_id}", headers=evil).status_code == 403
    assert len(get(env, call_id)["turns"]) == 1


def test_status_when_synthesis_spawn_never_ran():
    from backend.calls import STUCK_AFTER, _status

    rec = {"status": "ending", "spawned_at": 1000.0, "attempts": 1}
    assert _status(rec, None, 1000.0 + 60) == "generating"
    assert _status(rec, None, 1000.0 + STUCK_AFTER + 1) == "failed"


def test_status_ignores_a_synthesis_file_from_an_earlier_attempt():
    from backend.calls import _status

    rec = {"status": "ending", "spawned_at": 1000.0, "attempts": 2}
    assert _status(rec, {"status": "failed", "attempt": 1}, 1060.0) == "generating"
    assert _status(rec, {"status": "ready", "attempt": 2}, 1060.0) == "ready"
