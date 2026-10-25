import asyncio
import base64
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from urllib.parse import urlsplit

from authlib.integrations.requests_client import OAuth2Session
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

COOKIE = "sc_session"
OAUTH_COOKIE = "sc_oauth_state"
SESSION_TTL = 30 * 24 * 3600
OAUTH_STATE_TTL = 10 * 60
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
SCOPE = "openid email profile"

DEFAULT_SUB = "default"
_TENANT_RE = re.compile(r"[0-9a-f]{32}")


def tenant_id_for(sub: str) -> str:
    """Derive a fixed-width 32-char hex tenant identifier from an OAuth account subject."""
    if _TENANT_RE.fullmatch(sub):
        return sub
    return hashlib.sha256(sub.encode()).hexdigest()[:32]


DEFAULT_TENANT = tenant_id_for(DEFAULT_SUB)


class Account(BaseModel):
    """Authenticated OAuth account identity and its isolated tenant identifier."""

    tenant_id: str
    sub: str
    email: str | None = None
    name: str | None = None


_current_account: ContextVar[Account | None] = ContextVar("sc_account", default=None)


def current_account() -> Account | None:
    """Return the authenticated account bound to the active request context, if any."""
    return _current_account.get()


def current_tenant() -> str:
    """Return the active request's tenant ID, falling back to DEFAULT_TENANT outside HTTP requests."""
    account = _current_account.get()
    return account.tenant_id if account else DEFAULT_TENANT


@contextmanager
def as_tenant(sub_or_tenant: str) -> Iterator[Account]:
    """Bind a tenant context explicitly for background jobs or tests."""
    account = Account(tenant_id=tenant_id_for(sub_or_tenant), sub=sub_or_tenant)
    token = _current_account.set(account)
    try:
        yield account
    finally:
        _current_account.reset(token)


def _signing_key() -> bytes:
    return os.environ["APP_SIGNING_KEY"].encode()


def _sign_payload(payload: dict, key: bytes) -> str:
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    encoded = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    mac = hmac.new(key, encoded.encode(), hashlib.sha256).hexdigest()
    return f"{encoded}.{mac}"


def _verify_payload(value: str | None, key: bytes, now: float, ttl: int) -> dict | None:
    if not value or "." not in value:
        return None
    encoded, mac = value.rsplit(".", 1)
    expected = hmac.new(key, encoded.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, mac):
        return None
    pad = "=" * (-len(encoded) % 4)
    try:
        data = json.loads(base64.urlsafe_b64decode(encoded + pad))
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("i"), int):
        return None
    issued = data["i"]
    if now - issued > ttl or issued > now + 60:
        return None
    return data


def sign_session(
    issued: int,
    key: bytes,
    sub: str = DEFAULT_SUB,
    email: str | None = None,
    name: str | None = None,
) -> str:
    """Sign an authenticated account session token with HMAC-SHA256."""
    return _sign_payload({"i": int(issued), "s": sub, "e": email, "n": name}, key)


def verify_session(value: str | None, key: bytes, now: float) -> Account | None:
    """Verify a signed session cookie and return its Account, or None if invalid or expired."""
    data = _verify_payload(value, key, now, SESSION_TTL)
    if not data:
        return None
    sub = data.get("s")
    if not isinstance(sub, str) or not sub.strip():
        return None
    email = data.get("e") if isinstance(data.get("e"), str) else None
    name = data.get("n") if isinstance(data.get("n"), str) else None
    return Account(tenant_id=tenant_id_for(sub), sub=sub, email=email, name=name)


def sign_oauth_state(issued: int, key: bytes, state: str, code_verifier: str) -> str:
    """Sign an OAuth 2.0 state and PKCE verifier cookie payload."""
    return _sign_payload({"i": int(issued), "st": state, "cv": code_verifier}, key)


def verify_oauth_state(value: str | None, state: str | None, key: bytes, now: float) -> str | None:
    """Verify the OAuth state cookie against the callback state query parameter and return the PKCE verifier."""
    if not state:
        return None
    data = _verify_payload(value, key, now, OAUTH_STATE_TTL)
    if not data:
        return None
    saved_state = data.get("st")
    verifier = data.get("cv")
    if not isinstance(saved_state, str) or not isinstance(verifier, str):
        return None
    if not hmac.compare_digest(saved_state, state):
        return None
    return verifier


def oauth_session(redirect_uri: str) -> OAuth2Session:
    """Construct a lightweight Authlib OAuth2Session with S256 PKCE enabled."""
    return OAuth2Session(
        client_id=os.environ["OAUTH_CLIENT_ID"],
        client_secret=os.environ["OAUTH_CLIENT_SECRET"],
        scope=os.environ.get("OAUTH_SCOPE", SCOPE),
        redirect_uri=redirect_uri,
        code_challenge_method="S256",
    )


def exchange_code(code: str, code_verifier: str, redirect_uri: str) -> dict:
    """Exchange an authorization code for tokens and fetch the user's OIDC profile via Authlib."""
    with oauth_session(redirect_uri) as session:
        session.fetch_token(
            os.environ.get("OAUTH_TOKEN_URL", TOKEN_URL),
            code=code,
            code_verifier=code_verifier,
        )
        resp = session.get(os.environ.get("OAUTH_USERINFO_URL", USERINFO_URL), timeout=10)
        if resp.status_code != 200:
            raise RuntimeError(f"userinfo status {resp.status_code}")
        return resp.json()


async def require_session(request: Request) -> AsyncIterator[Account]:
    """Authenticate the session cookie and bind the account's tenant to the request context."""
    account = verify_session(request.cookies.get(COOKIE), _signing_key(), time.time())
    if not account:
        raise HTTPException(status_code=401, detail="unauthorized")
    token = _current_account.set(account)
    try:
        yield account
    finally:
        _current_account.reset(token)


def require_same_origin(request: Request) -> None:
    """Enforce same-origin header validation on all state-mutating requests."""
    if request.method in SAFE_METHODS:
        return
    origin = request.headers.get("origin")
    if origin is None:
        if request.headers.get("sec-fetch-site") == "same-origin":
            return
        raise HTTPException(status_code=403, detail="forbidden")
    if urlsplit(origin).netloc != request.headers.get("host"):
        raise HTTPException(status_code=403, detail="forbidden")


def protected_router() -> APIRouter:
    """Return an /api router protected by OAuth session authentication and same-origin checks."""
    return APIRouter(prefix="/api", dependencies=[Depends(require_session), Depends(require_same_origin)])


ExchangeCode = Callable[[str, str, str], dict]


def _callback_uri(request: Request) -> str:
    return str(request.url_for("oauth_callback"))


def build_router(exchange: ExchangeCode | None = None) -> APIRouter:
    """Build the authentication router with optional code-exchange injection for tests."""
    api = APIRouter(prefix="/api")
    do_exchange = exchange or exchange_code

    @api.get("/auth/login")
    def oauth_login(request: Request) -> Response:
        state = secrets.token_urlsafe(24)
        verifier = secrets.token_urlsafe(48)
        authorize_url = os.environ.get("OAUTH_AUTHORIZE_URL", AUTHORIZE_URL)
        with oauth_session(_callback_uri(request)) as session:
            url, _ = session.create_authorization_url(authorize_url, state=state, code_verifier=verifier)
        response = RedirectResponse(url, status_code=302)
        response.set_cookie(
            OAUTH_COOKIE,
            sign_oauth_state(int(time.time()), _signing_key(), state, verifier),
            max_age=OAUTH_STATE_TTL,
            httponly=True,
            secure=True,
            samesite="lax",
            path="/",
        )
        return response

    @api.get("/auth/callback", name="oauth_callback")
    async def oauth_callback(
        request: Request,
        code: str | None = None,
        state: str | None = None,
        error: str | None = None,
    ) -> Response:
        now = time.time()
        key = _signing_key()
        verifier = verify_oauth_state(request.cookies.get(OAUTH_COOKIE), state, key, now)
        if error or not code or not verifier:
            raise HTTPException(status_code=401, detail="oauth failed")
        try:
            profile = await asyncio.to_thread(do_exchange, code, verifier, _callback_uri(request))
        except Exception as exc:
            print(f"oauth callback exchange failed error={type(exc).__name__}")
            raise HTTPException(status_code=401, detail="oauth failed") from None
        sub = str(profile.get("sub") or profile.get("id") or "").strip() if isinstance(profile, dict) else ""
        if not sub:
            raise HTTPException(status_code=401, detail="oauth failed")
        email = profile.get("email") if isinstance(profile.get("email"), str) else None
        name = profile.get("name") if isinstance(profile.get("name"), str) else None
        response = RedirectResponse("/", status_code=302)
        response.delete_cookie(OAUTH_COOKIE, path="/")
        response.set_cookie(
            COOKIE,
            sign_session(int(now), key, sub=sub, email=email, name=name),
            max_age=SESSION_TTL,
            httponly=True,
            secure=True,
            samesite="lax",
            path="/",
        )
        return response

    @api.post("/auth/logout", status_code=204, dependencies=[Depends(require_same_origin)])
    @api.post("/logout", status_code=204, dependencies=[Depends(require_same_origin)])
    def logout(response: Response) -> None:
        response.delete_cookie(COOKIE, path="/")

    @api.get("/session")
    def session(account: Account = Depends(require_session)) -> dict:
        return account.model_dump()

    return api


router = build_router()
