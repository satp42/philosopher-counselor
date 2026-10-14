import hashlib
import hmac
import os
import time
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

COOKIE = "sc_session"
SESSION_TTL = 30 * 24 * 3600
MAX_FAILS = 5
LOCKOUT = 15 * 60
GLOBAL_FAILS_PER_MIN = 30
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

# ponytail: in-process state, correct only at max_containers=1; move to a Modal Dict to scale out.
_fails: dict[str, list[float]] = {}
_global_fails: list[float] = []


def _signing_key() -> bytes:
    return os.environ["APP_SIGNING_KEY"].encode()


def sign_session(issued: int, key: bytes) -> str:
    mac = hmac.new(key, str(issued).encode(), hashlib.sha256).hexdigest()
    return f"{issued}.{mac}"


def verify_session(value: str | None, key: bytes, now: float) -> bool:
    if not value:
        return False
    try:
        issued = int(value.split(".", 1)[0])
    except ValueError:
        return False
    if now - issued > SESSION_TTL or issued > now + 60:
        return False
    return hmac.compare_digest(sign_session(issued, key), value)


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _is_locked(ip: str, now: float) -> bool:
    _fails[ip] = [t for t in _fails.get(ip, []) if now - t < LOCKOUT]
    _global_fails[:] = [t for t in _global_fails if now - t < 60]
    return len(_fails[ip]) >= MAX_FAILS or len(_global_fails) >= GLOBAL_FAILS_PER_MIN


def _record_fail(ip: str, now: float) -> None:
    _fails.setdefault(ip, []).append(now)
    _global_fails.append(now)


def reset_rate_limits() -> None:
    _fails.clear()
    _global_fails.clear()


def require_session(request: Request) -> None:
    if not verify_session(request.cookies.get(COOKIE), _signing_key(), time.time()):
        raise HTTPException(status_code=401, detail="unauthorized")


def require_same_origin(request: Request) -> None:
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
    return APIRouter(prefix="/api", dependencies=[Depends(require_session), Depends(require_same_origin)])


router = APIRouter(prefix="/api")


class LoginBody(BaseModel):
    passphrase: str


@router.post("/login", status_code=204, dependencies=[Depends(require_same_origin)])
def login(body: LoginBody, request: Request, response: Response) -> None:
    now = time.time()
    ip = _client_ip(request)
    if _is_locked(ip, now):
        raise HTTPException(status_code=429, detail="too many attempts")
    expected = os.environ["APP_PASSPHRASE"].encode()
    if not hmac.compare_digest(body.passphrase.encode(), expected):
        _record_fail(ip, now)
        raise HTTPException(status_code=401, detail="unauthorized")
    response.set_cookie(
        COOKIE,
        sign_session(int(now), _signing_key()),
        max_age=SESSION_TTL,
        httponly=True,
        secure=True,
        samesite="strict",
        path="/",
    )


@router.get("/session", status_code=204, dependencies=[Depends(require_session)])
def session() -> None:
    pass
