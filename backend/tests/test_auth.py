import time

import pytest
from fastapi.testclient import TestClient

from backend import auth
from backend.tests.conftest import ORIGIN, login
from backend.web import create_web_app


@pytest.fixture
def client(app_env):
    return TestClient(create_web_app(), base_url="https://testserver")


def test_correct_passphrase_sets_hardened_cookie_and_unlocks_session(client):
    r = login(client)
    assert r.status_code == 204
    cookie = r.headers["set-cookie"].lower()
    for attr in ("httponly", "secure", "samesite=strict", "max-age=2592000"):
        assert attr in cookie
    assert client.get("/api/session").status_code == 204


def test_wrong_passphrase_is_401_without_cookie(client):
    r = login(client, "nope")
    assert r.status_code == 401
    assert "set-cookie" not in r.headers
    assert client.get("/api/session").status_code == 401


def test_tampered_cookie_is_rejected(client):
    login(client)
    value = client.cookies.get(auth.COOKIE)
    client.cookies.clear()
    client.cookies.set(auth.COOKIE, value[:-1] + ("0" if value[-1] != "0" else "1"))
    assert client.get("/api/session").status_code == 401


def test_expired_cookie_is_rejected():
    key = b"k" * 64
    old = int(time.time()) - auth.SESSION_TTL - 10
    assert not auth.verify_session(auth.sign_session(old, key), key, time.time())


def test_cookie_signed_with_rotated_key_is_rejected():
    now = int(time.time())
    assert not auth.verify_session(auth.sign_session(now, b"old" * 20), b"new" * 20, now)


def test_garbage_cookie_values_are_rejected():
    for value in ("", "abc", "123", "x.y", None):
        assert not auth.verify_session(value, b"k", time.time())


def test_sixth_wrong_attempt_is_rate_limited_even_with_right_passphrase(client):
    for _ in range(auth.MAX_FAILS):
        assert login(client, "wrong").status_code == 401
    assert login(client, "wrong").status_code == 429
    assert login(client).status_code == 429


def test_foreign_origin_on_mutating_route_is_403(client):
    assert login(client, headers={"origin": "https://evil.example"}).status_code == 403


def test_missing_origin_needs_same_origin_fetch_metadata(client):
    assert login(client, headers={}).status_code == 403
    assert login(client, headers={"sec-fetch-site": "same-origin"}).status_code == 204


def test_docs_and_openapi_are_disabled(client):
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404


def test_protected_router_requires_session_and_origin(client):
    router = auth.protected_router()

    @router.post("/ping", status_code=204)
    def ping() -> None:
        pass

    client.app.include_router(router)
    assert client.post("/api/ping", headers=ORIGIN).status_code == 401
    login(client)
    assert client.post("/api/ping", headers=ORIGIN).status_code == 204
    assert client.post("/api/ping", headers={"origin": "https://evil.example"}).status_code == 403
