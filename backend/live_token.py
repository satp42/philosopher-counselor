import asyncio
from collections import Counter
from datetime import datetime, timedelta, timezone
import inspect
import os
from typing import Callable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend import auth
from backend.calls import VoiceCall
from backend.guide.config import API_VERSION, DEFAULT_VARIANT, MODEL, live_config

TOKEN_TTL = timedelta(minutes=30)
NEW_SESSION_WINDOW = timedelta(minutes=1)
MAX_MINTS_PER_CALL = 12  # one per ~9.5-min connection (tokens are single-use; resume needs a fresh mint), plus retries


def gemini_client():
    from google import genai

    return genai.Client(api_key=os.environ["GEMINI_API_KEY"], http_options={"api_version": API_VERSION})


def mint_token(
    client,
    resumption_handle: str | None = None,
    variant: str = DEFAULT_VARIANT,
    now: datetime | None = None,
    memory: str | None = None,
) -> str:
    now = now or datetime.now(timezone.utc)
    token = client.auth_tokens.create(
        config={
            "uses": 1,
            "expire_time": now + TOKEN_TTL,
            "new_session_expire_time": now + NEW_SESSION_WINDOW,
            "live_connect_constraints": {
                "model": MODEL,
                "config": live_config(resumption_handle, variant, memory=memory),
            },
            "http_options": {"api_version": API_VERSION},
        }
    )
    return token.name


class TokenBody(BaseModel):
    call_id: str
    resumption_handle: str | None = Field(default=None, max_length=4096)


def router(store, mint: Callable[..., str]) -> APIRouter:
    api = auth.protected_router()
    mints: Counter[str] = Counter()
    takes_memory = len(inspect.signature(mint).parameters) >= 3

    @api.post("/token")
    async def token(body: TokenBody) -> dict:
        call = await store.require_active(body.call_id)
        if not isinstance(call, VoiceCall):
            raise HTTPException(status_code=409, detail="not a voice call")
        variant = call.variant
        if mints[body.call_id] >= MAX_MINTS_PER_CALL:
            raise HTTPException(status_code=429, detail="token limit reached for this call")
        mints[body.call_id] += 1  # reserved before the await so concurrent requests can't overshoot
        args = (body.resumption_handle, variant, call.memory) if takes_memory else (body.resumption_handle, variant)
        try:
            name = await asyncio.to_thread(mint, *args)
        except Exception as e:
            mints[body.call_id] -= 1
            print(f"token mint failed call={body.call_id} error={type(e).__name__}")
            raise HTTPException(status_code=502, detail="could not start a voice session") from None
        return {"token": name, "model": MODEL, "api_version": API_VERSION}

    return api
