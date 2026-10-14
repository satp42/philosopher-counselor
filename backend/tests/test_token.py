import pytest
from fastapi.testclient import TestClient

from backend.guide.config import VARIANTS
from backend.live_token import MAX_MINTS_PER_CALL
from backend.tests.conftest import ORIGIN, login_and_call, make_store
from backend.web import create_web_app


@pytest.fixture
def setup(app_env, tmp_path):
    minted = []

    def mint(handle, variant):
        minted.append(handle)
        assert variant in VARIANTS
        if handle == "explode":
            raise RuntimeError("upstream said: key AIzaSECRET is invalid")
        return "auth_tokens/fake"

    client = TestClient(create_web_app(call_store=make_store(tmp_path), mint_token=mint), base_url="https://testserver")
    return client, minted


def test_token_minted_for_active_call(setup):
    client, minted = setup
    call_id = login_and_call(client)
    r = client.post("/api/token", json={"call_id": call_id}, headers=ORIGIN)
    assert r.status_code == 200
    assert r.json() == {"token": "auth_tokens/fake", "model": "gemini-3.8-live-extended-thinking", "api_version": "v1beta"}
    assert minted == [None]


def test_resumption_handle_is_passed_through(setup):
    client, minted = setup
    call_id = login_and_call(client)
    client.post("/api/token", json={"call_id": call_id, "resumption_handle": "h1"}, headers=ORIGIN)
    assert minted == ["h1"]


def test_token_requires_session(setup):
    client, _ = setup
    assert client.post("/api/token", json={"call_id": "a" * 32}, headers=ORIGIN).status_code == 401


def test_token_refused_for_unknown_or_ended_call(setup):
    client, _ = setup
    call_id = login_and_call(client)
    assert client.post("/api/token", json={"call_id": "f" * 32}, headers=ORIGIN).status_code == 404
    client.post(f"/api/calls/{call_id}/end", headers=ORIGIN)
    assert client.post("/api/token", json={"call_id": call_id}, headers=ORIGIN).status_code == 409


def test_mints_are_capped_per_call(setup):
    client, _ = setup
    call_id = login_and_call(client)
    for _ in range(MAX_MINTS_PER_CALL):
        assert client.post("/api/token", json={"call_id": call_id}, headers=ORIGIN).status_code == 200
    assert client.post("/api/token", json={"call_id": call_id}, headers=ORIGIN).status_code == 429


def test_upstream_failure_is_502_without_leaking_details(setup, capsys):
    client, _ = setup
    call_id = login_and_call(client)
    r = client.post("/api/token", json={"call_id": call_id, "resumption_handle": "explode"}, headers=ORIGIN)
    assert r.status_code == 502
    assert "AIza" not in r.text
    assert "AIza" not in capsys.readouterr().out


def test_failed_mints_do_not_use_up_the_cap(setup):
    client, minted = setup
    call_id = login_and_call(client)
    for _ in range(3):
        assert client.post("/api/token", json={"call_id": call_id, "resumption_handle": "explode"}, headers=ORIGIN).status_code == 502
    for _ in range(MAX_MINTS_PER_CALL):
        assert client.post("/api/token", json={"call_id": call_id}, headers=ORIGIN).status_code == 200
    assert client.post("/api/token", json={"call_id": call_id}, headers=ORIGIN).status_code == 429
    assert len(minted) == 3 + MAX_MINTS_PER_CALL
