"""POST /api/converse: the text counterpart of an ephemeral token.

The persona, tools, and model are fixed here. The browser sends only the conversation. Nothing is written to the
call record, so the recorder stays the only sequence producer and a retry of the same history is safe.
"""

import base64
from collections import Counter
from collections.abc import Awaitable, Callable
import inspect
import json
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

from backend import auth
from backend.calls import CallStore, TextCall
from backend.guide.config import TEXT_MODEL, text_config
from backend.guide.tools import TOOL_NAMES, ToolName

MAX_BODY_BYTES = 1024 * 1024
MAX_TURNS_PER_CALL = 240

# Gemini contents -> the model's turn as a content dict, or None when nothing showable came back.
GenerateTurn = Callable[..., Awaitable[dict | None]]


class UserItem(BaseModel):
    kind: Literal["user"]
    text: str = Field(min_length=1, max_length=8000)


class ToolResult(BaseModel):
    id: str = Field(max_length=64)
    name: ToolName
    response: dict


class GuideItem(BaseModel):
    kind: Literal["guide"]
    memo: str = Field(max_length=256 * 1024)
    results: list[ToolResult] = []


Item = Annotated[UserItem | GuideItem, Field(discriminator="kind")]


class ConverseBody(BaseModel):
    call_id: str
    history: list[Item] = Field(min_length=1, max_length=400)


class Call(BaseModel):
    id: str
    name: ToolName
    args: dict = {}


class Reply(BaseModel):
    kind: Literal["reply"] = "reply"
    text: str
    calls: list[Call]
    memo: str


class Withheld(BaseModel):
    kind: Literal["withheld"] = "withheld"


GuideReply = Reply | Withheld


def _function_calls(content: dict) -> list[dict]:
    calls = []
    for part in content.get("parts") or []:
        call = part.get("function_call")
        if isinstance(call, dict):
            calls.append(call)
    return calls


def _memo(content: dict) -> str:
    """base64url JSON of the model's exact content, thought signatures included."""
    raw = json.dumps(content, separators=(",", ":"), ensure_ascii=False).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unmemo(memo: str) -> dict:
    """Inverse of _memo. ValueError unless it is a model turn whose calls are known tools."""
    pad = "=" * (-len(memo) % 4)
    try:
        data = json.loads(base64.urlsafe_b64decode(memo + pad))
    except (ValueError, json.JSONDecodeError) as exc:
        raise ValueError("bad memo") from exc
    if not isinstance(data, dict) or data.get("role") != "model":
        raise ValueError("bad memo")
    for call in _function_calls(data):
        if call.get("name") not in TOOL_NAMES:
            raise ValueError("unknown tool")
    return data


def _call_ids(content: dict, turn: int) -> list[str]:
    """Gemini's id when the call has one, otherwise a stable id for this guide turn."""
    ids = []
    for index, call in enumerate(_function_calls(content)):
        ids.append(call["id"] if call.get("id") else f"g{turn}-{index}")
    return ids


def _append_user(contents: list[dict], parts: list[dict]) -> None:
    if contents and contents[-1].get("role") == "user":
        contents[-1]["parts"].extend(parts)
        return
    contents.append({"role": "user", "parts": parts})


def _render(history: list[Item]) -> list[dict]:
    """Thread -> Gemini contents. ValueError (-> 422) when the thread is not something the guide should answer."""
    if not history or not isinstance(history[0], UserItem):
        raise ValueError("thread must start with the person")
    contents: list[dict] = []
    guide_index = -1
    for item in history:
        if isinstance(item, UserItem):
            _append_user(contents, [{"text": item.text}])
            continue
        guide_index += 1
        content = _unmemo(item.memo)
        expected = _call_ids(content, guide_index)
        got = [result.id for result in item.results]
        if got != expected:
            raise ValueError("results do not match the guide turn")
        contents.append(content)
        if item.results:
            parts = []
            for result, call in zip(item.results, _function_calls(content), strict=True):
                response = {"name": result.name, "response": result.response}
                if call.get("id"):
                    response["id"] = call["id"]
                parts.append({"function_response": response})
            _append_user(contents, parts)
    last = history[-1]
    if isinstance(last, UserItem):
        return contents
    if isinstance(last, GuideItem) and last.results:
        return contents
    raise ValueError("nothing for the guide to answer")


def _visible_text(content: dict) -> str:
    parts = []
    for part in content.get("parts") or []:
        if part.get("thought"):
            continue
        if text := part.get("text"):
            parts.append(text)
    return "".join(parts).strip()


def _reply(content: dict | None, turn: int) -> GuideReply:
    """Model content -> a reply the browser can show, or withheld when there is nothing to show."""
    if not content:
        return Withheld()
    text = _visible_text(content)
    try:
        calls = [
            Call(id=call_id, name=call.get("name"), args=call.get("args") or {})
            for call_id, call in zip(_call_ids(content, turn), _function_calls(content), strict=True)
        ]
    except ValidationError:
        return Withheld()
    if not text and not calls:
        return Withheld()
    return Reply(text=text, calls=calls, memo=_memo(content))


def router(store: CallStore, generate: GenerateTurn) -> APIRouter:
    """POST /api/converse. Does not check crisis: during care the model must keep answering."""
    api = auth.protected_router()
    turns: Counter[str] = Counter()
    takes_memory = len(inspect.signature(generate).parameters) >= 2

    @api.post("/converse")
    async def converse(request: Request) -> dict:
        body = await request.body()
        if len(body) > MAX_BODY_BYTES:
            raise HTTPException(status_code=413, detail="body too large")
        try:
            parsed = ConverseBody.model_validate_json(body)
        except ValidationError:
            raise HTTPException(status_code=422, detail="invalid body")
        call = await store.require_active(parsed.call_id)
        if not isinstance(call, TextCall):
            raise HTTPException(status_code=409, detail="not a text call")
        if turns[parsed.call_id] >= MAX_TURNS_PER_CALL:
            raise HTTPException(status_code=429, detail="conversation length limit")
        try:
            contents = _render(parsed.history)
        except ValueError:
            raise HTTPException(status_code=422, detail="invalid history")
        guide_turns = sum(isinstance(item, GuideItem) for item in parsed.history)
        try:
            content = await (generate(contents, call.memory) if takes_memory else generate(contents))
        except Exception as exc:
            print(f"converse failed call={parsed.call_id} error={type(exc).__name__}")
            raise HTTPException(status_code=502, detail="guide unavailable") from None
        turns[parsed.call_id] += 1
        return _reply(content, guide_turns).model_dump()

    return api


def gemini_turn(client) -> GenerateTurn:
    """Real generator. Returns the first candidate's content, or None when the reply was blocked or empty."""

    async def generate(contents: list[dict], memory: str | None = None) -> dict | None:
        response = await client.aio.models.generate_content(
            model=TEXT_MODEL,
            contents=contents,
            config=text_config(memory=memory),
        )
        candidates = getattr(response, "candidates", None) or []
        if not candidates or candidates[0].content is None:
            return None
        dumped = candidates[0].content.model_dump(mode="json", exclude_none=True)
        if not dumped.get("parts"):
            return None
        return dumped

    return generate
