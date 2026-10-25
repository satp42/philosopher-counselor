import time
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from backend import auth
from backend.tests.conftest import ORIGIN, login
from backend.web import create_web_app


@pytest.fixture
def setup(app_env):
    exchanged = []

    def exchange(code: str, verifier: str, redirect_uri: str) -> dict:
        exchanged.append((code, verifier, redirect_uri))
        if code == "explode":
            raise RuntimeError("upstream token exchange failed")
        if code == "no-sub":
            return {"email": "nobody@example.com"}
        return {"sub": f"oauth-user-{code}", "email": f"{code}@example.com", "name": f"User {code}"}

    client = TestClient(create_web_app(oauth_exchange=exchange), base_url="https://testserver")
    return client, exchanged


def test_oauth_login_redirects_with_pkce_and_callback_sets_tenant_session(setup):
    client, exchanged = setup
    r = client.get("/api/auth/login", follow_redirects=False)
    assert r.status_code == 302
    loc = urlsplit(r.headers["location"])
    assert (loc.scheme, loc.netloc) == ("https", "accounts.google.com")
    params = parse_qs(loc.query)
    assert params["client_id"] == ["test-client-id"]
    assert params["code_challenge_method"] == ["S256"]
    assert params["code_challenge"]
    state = params["state"][0]
    assert auth.OAUTH_COOKIE in client.cookies

    cb = client.get(f"/api/auth/callback?code=alice&state={state}", follow_redirects=False)
    assert cb.status_code == 302
    assert cb.headers["location"] == "/"
    cookie = cb.headers.get_list("set-cookie")
    session_header = next(h.lower() for h in cookie if auth.COOKIE in h)
    for attr in ("httponly", "secure", "samesite=lax", "max-age=2592000"):
        assert attr in session_header
    assert len(exchanged) == 1
    assert exchanged[0][0] == "alice" and len(exchanged[0][1]) >= 43

    sess = client.get("/api/session")
    assert sess.status_code == 200
    assert sess.json() == {
        "tenant_id": auth.tenant_id_for("oauth-user-alice"),
        "sub": "oauth-user-alice",
        "email": "alice@example.com",
        "name": "User alice",
    }


def test_callback_rejects_mismatched_state_or_missing_cookie_or_provider_error(setup):
    client, exchanged = setup
    r = client.get("/api/auth/login", follow_redirects=False)
    state = parse_qs(urlsplit(r.headers["location"]).query)["state"][0]

    assert client.get(f"/api/auth/callback?code=alice&state=wrong-state").status_code == 401
    assert client.get(f"/api/auth/callback?error=access_denied&state={state}").status_code == 401
    assert client.get(f"/api/auth/callback?code=explode&state={state}").status_code == 401
    assert client.get(f"/api/auth/callback?code=no-sub&state={state}").status_code == 401
    client.cookies.clear()
    assert client.get(f"/api/auth/callback?code=alice&state={state}").status_code == 401
    assert client.get("/api/session").status_code == 401
    assert len(exchanged) == 2


def test_logout_clears_session_and_requires_same_origin(setup):
    client, _ = setup
    login(client, sub="alice")
    assert client.get("/api/session").status_code == 200
    assert client.post("/api/auth/logout", headers={"origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/auth/logout", headers=ORIGIN).status_code == 204
    assert client.get("/api/session").status_code == 401


def test_tampered_cookie_is_rejected(setup):
    client, _ = setup
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


def test_missing_origin_needs_same_origin_fetch_metadata(setup):
    client, _ = setup
    assert client.post("/api/auth/logout", headers={}).status_code == 403
    assert client.post("/api/auth/logout", headers={"sec-fetch-site": "same-origin"}).status_code == 204


def test_docs_and_openapi_are_disabled(setup):
    client, _ = setup
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404


def test_protected_router_requires_session_and_origin_and_binds_tenant(setup):
    client, _ = setup
    router = auth.protected_router()

    @router.post("/ping")
    def ping() -> dict:
        return {"tenant": auth.current_tenant()}

    client.app.include_router(router)
    assert client.post("/api/ping", headers=ORIGIN).status_code == 401
    login(client, sub="tenant-alpha")
    r = client.post("/api/ping", headers=ORIGIN)
    assert r.status_code == 200
    assert r.json() == {"tenant": auth.tenant_id_for("tenant-alpha")}
    assert client.post("/api/ping", headers={"origin": "https://evil.example"}).status_code == 403
