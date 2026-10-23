"""Writes are not committed one by one: Modal commits in the background and on
container exit. Only writes another container must see right away commit
explicitly (create, end before spawning synthesis, retry, delete).
"""

import asyncio
import json
import os
import re
import shutil
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

from backend import auth, bandit
from backend.guide.config import DEFAULT_VARIANT, MODALITIES, Modality

MAX_BATCH_BYTES = 64 * 1024
MAX_RECORD_BYTES = 2 * 1024 * 1024
# A typed conversation pauses longer than speech. Either kind still ends as interrupted.
STALE_AFTER: dict[Modality, int] = {"voice": 15 * 60, "text": 60 * 60}
STUCK_AFTER = 10 * 60
_ID = re.compile(r"[0-9a-f]{32}")


class _Event(BaseModel):
    seq: int = Field(ge=1)


class TurnEvent(_Event):
    type: Literal["turn"]
    role: Literal["user", "guide"]
    text: str
    ts: float


class PhaseEvent(_Event):
    type: Literal["phase"]
    phase: str = Field(max_length=32)
    ts: float


class SummaryEvent(_Event):
    type: Literal["summary"]
    summary: str
    leaning: str | None = None


class AckEvent(_Event):
    type: Literal["ack"]
    passage_ids: list[str]


class FlagEvent(_Event):
    type: Literal["flag"]
    flag: Literal["crisis", "interrupted"]


class MetricsEvent(_Event):
    """The client's end-of-call conversation metrics (frontend/src/live/metrics.ts); read by backend/bandit.py."""

    type: Literal["metrics"]
    metrics: dict


Event = Annotated[
    TurnEvent | PhaseEvent | SummaryEvent | AckEvent | FlagEvent | MetricsEvent, Field(discriminator="type")
]


class EventBatch(BaseModel):
    events: list[Event]


class EndBody(BaseModel):
    interrupted: bool = False


class CreateBody(BaseModel):
    modality: Modality = "voice"  # a client that posts nothing, or {}, still starts a voice call


def modality_of(rec: dict) -> Modality:
    """Records written before text mode have no field and are voice."""
    value = rec.get("modality", "voice")
    return value if value in MODALITIES else "voice"


@dataclass(frozen=True)
class VoiceCall:
    variant: str
    crisis: bool


@dataclass(frozen=True)
class TextCall:
    crisis: bool


ActiveCall = VoiceCall | TextCall


def _status(rec: dict, synth: dict | None, now: float) -> str:
    if rec["status"] != "ending":
        return rec["status"]
    if synth and synth.get("attempt") == rec.get("attempts") and synth.get("status") in ("ready", "failed"):
        return synth["status"]
    return "failed" if now - rec.get("spawned_at", 0) > STUCK_AFTER else "generating"


class CallStore:
    def __init__(
        self,
        root: Path,
        commit: Callable[[], Awaitable[None]],
        reload: Callable[[], Awaitable[None]],
        spawn_synthesis: Callable[[str], Awaitable[object]],
        now: Callable[[], float] = time.time,
    ):
        self.root = root
        self.commit = commit
        self.reload = reload
        self.spawn_synthesis = spawn_synthesis
        self.now = now
        # ponytail: one global lock for every record and the reload; per-call locks if traffic ever grows.
        self.lock = asyncio.Lock()
        root.mkdir(parents=True, exist_ok=True)

    def _dir(self, call_id: str) -> Path:
        if not _ID.fullmatch(call_id) or not (self.root / call_id / "record.json").exists():
            raise HTTPException(status_code=404, detail="not found")
        return self.root / call_id

    def _read(self, call_id: str) -> dict:
        return json.loads((self._dir(call_id) / "record.json").read_text())

    def _read_active(self, call_id: str) -> dict:
        rec = self._read(call_id)
        if rec["status"] != "active":
            raise HTTPException(status_code=409, detail="call ended")
        return rec

    def _records(self) -> list[dict]:
        records = []
        for p in self.root.glob("*/record.json"):
            try:
                records.append(json.loads(p.read_text()))
            except (OSError, ValueError):
                print(f"call {p.parent.name} record unreadable, skipped")
        return records

    def _synthesis(self, call_id: str) -> dict | None:
        path = self.root / call_id / "synthesis.json"
        return json.loads(path.read_text()) if path.exists() else None

    def _write(self, rec: dict) -> None:
        data = json.dumps(rec)
        if len(data.encode()) > MAX_RECORD_BYTES:
            raise HTTPException(status_code=413, detail="record too large")
        path = self.root / rec["id"] / "record.json"
        path.parent.mkdir(exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(data)
        os.replace(tmp, path)

    async def _spawn(self, rec: dict) -> None:
        """Start a synthesis attempt; committed first so the job's container sees the record."""
        rec["attempts"] = rec.get("attempts", 0) + 1
        rec["spawned_at"] = self.now()
        self._write(rec)
        await self.commit()
        await self.spawn_synthesis(rec["id"])

    async def _end(self, rec: dict, interrupted: bool) -> dict:
        if rec["status"] != "active":
            return rec
        rec["status"] = "ending"
        rec["flags"]["interrupted"] = rec["flags"]["interrupted"] or interrupted
        await self._spawn(rec)
        print(f"call {rec['id']} ending interrupted={rec['flags']['interrupted']}")
        return rec

    async def _sweep(self, records: list[dict]) -> None:
        for rec in records:
            window = STALE_AFTER[modality_of(rec)]
            if rec["status"] == "active" and self.now() - rec["last_event_at"] > window:
                await self._end(rec, interrupted=True)

    async def _load(self, call_id: str) -> tuple[dict, dict | None]:
        await self.reload()
        rec = self._read(call_id)
        await self._sweep([rec])
        return rec, self._synthesis(call_id)

    async def create(self, modality: Modality = "voice") -> dict:
        async with self.lock:
            records = self._records()
            await self._sweep(records)
            active = [r for r in records if r["status"] == "active"]
            if active:
                raise HTTPException(
                    status_code=409, detail={"active_id": active[0]["id"], "started_at": active[0]["started_at"]}
                )
            now = self.now()
            # Text is not an arm: the bandit learns from spoken turn-taking only.
            variant = bandit.pick(records) if modality == "voice" else None
            rec = {
                "id": uuid.uuid4().hex,
                "modality": modality,
                "variant": variant,
                "status": "active",
                "flags": {"interrupted": False, "crisis": False},
                "started_at": now,
                "last_event_at": now,
                "last_seq": 0,
                "phases": [],
                "turns": [],
                "summary": None,
                "leaning": None,
                "lens_plan": None,
                "consulted_lens_ids": [],
                "served_passages": {},
                "acked_passage_ids": [],
                "metrics": None,
            }
            self._write(rec)
            await self.commit()
            print(f"call {rec['id']} created modality={modality} variant={variant}")
            return {"id": rec["id"]}

    async def append_events(self, call_id: str, events: list[Event]) -> None:
        async with self.lock:
            rec = self._read_active(call_id)
            for e in sorted(events, key=lambda e: e.seq):
                if e.seq <= rec["last_seq"]:
                    continue
                rec["last_seq"] = e.seq
                match e:
                    case TurnEvent():
                        rec["turns"].append({"role": e.role, "text": e.text, "ts": e.ts})
                    case PhaseEvent():
                        rec["phases"].append({"phase": e.phase, "ts": e.ts})
                    case SummaryEvent():
                        rec["summary"], rec["leaning"] = e.summary, e.leaning
                    case AckEvent():
                        acked = rec["acked_passage_ids"]
                        acked.extend(p for p in dict.fromkeys(e.passage_ids) if p not in acked)
                    case FlagEvent():
                        rec["flags"][e.flag] = True
                    case MetricsEvent():
                        rec["metrics"] = e.metrics
            rec["last_event_at"] = self.now()
            self._write(rec)

    async def require_active(self, call_id: str) -> ActiveCall:
        """The call is active. Routes read the variant from a voice call and the crisis flag from either."""
        async with self.lock:
            rec = self._read_active(call_id)
            crisis = bool(rec["flags"].get("crisis"))
            if modality_of(rec) == "text":
                return TextCall(crisis)
            return VoiceCall(rec.get("variant") or DEFAULT_VARIANT, crisis)

    async def record_served(
        self, call_id: str, passages: list[dict], lens_plan: list[dict] | None = None, consulted_lens_id: str | None = None
    ) -> list[dict] | None:
        """Returns the recorded lens plan, its ids namespaced per mapping (m<n>-<id>) so a lens id consulted under
        an earlier plan never matches a later one."""
        async with self.lock:
            rec = self._read_active(call_id)
            for p in passages:
                rec["served_passages"][p["passage_id"]] = p
            if lens_plan is not None:
                rec["lens_maps"] = n = rec.get("lens_maps", 0) + 1
                rec["lens_plan"] = lens_plan = [{**lens, "lens_id": f"m{n}-{lens['lens_id']}"} for lens in lens_plan]
            consulted = rec.setdefault("consulted_lens_ids", [])  # setdefault: records created before the field
            if consulted_lens_id and consulted_lens_id not in consulted:
                consulted.append(consulted_lens_id)
            rec["last_event_at"] = self.now()
            self._write(rec)
            return lens_plan

    async def end_call(self, call_id: str, interrupted: bool = False) -> dict:
        async with self.lock:
            rec = await self._end(self._read(call_id), interrupted)
            return {"id": rec["id"], "status": rec["status"]}

    async def list_calls(self) -> list[dict]:
        async with self.lock:
            await self.reload()
            records = self._records()
            await self._sweep(records)
            calls = []
            for rec in records:
                synth = self._synthesis(rec["id"])
                title = ((synth or {}).get("page") or {}).get("title")
                status = _status(rec, synth, self.now())
                calls.append({"id": rec["id"], "started_at": rec["started_at"], "status": status, "title": title})
            return sorted(calls, key=lambda c: c["started_at"], reverse=True)

    async def get_call(self, call_id: str) -> dict:
        async with self.lock:
            rec, synth = await self._load(call_id)
            rec["served_passage_ids"] = list(rec.pop("served_passages"))
            rec["status"] = _status(rec, synth, self.now())
            rec["synthesis"] = synth
            return rec

    async def retry(self, call_id: str) -> dict:
        async with self.lock:
            rec, synth = await self._load(call_id)
            if _status(rec, synth, self.now()) != "failed":
                raise HTTPException(status_code=409, detail="not failed")
            await self._spawn(rec)
            print(f"call {call_id} synthesis attempt={rec['attempts']}")
            return {"id": call_id, "status": "generating"}

    async def delete(self, call_id: str) -> None:
        async with self.lock:
            shutil.rmtree(self._dir(call_id))
            await self.commit()
            print(f"call {call_id} deleted")


def router(store: CallStore) -> APIRouter:
    r = auth.protected_router()

    @r.post("/calls", status_code=201)
    async def create_call(body: CreateBody | None = None) -> dict:
        return await store.create((body or CreateBody()).modality)

    @r.post("/calls/{call_id}/events", status_code=204)
    async def post_events(call_id: str, request: Request) -> None:
        # Parsed by hand so the size cap applies before validation and beacons with any content type work.
        body = await request.body()
        if len(body) > MAX_BATCH_BYTES:
            raise HTTPException(status_code=413, detail="batch too large")
        try:
            batch = EventBatch.model_validate_json(body)
        except ValidationError:
            raise HTTPException(status_code=422, detail="invalid events")
        await store.append_events(call_id, batch.events)

    @r.post("/calls/{call_id}/end", status_code=202)
    async def end_call(call_id: str, request: Request) -> dict:
        body = await request.body()
        try:
            interrupted = EndBody.model_validate_json(body).interrupted if body else False
        except ValidationError:
            raise HTTPException(status_code=422, detail="invalid body")
        return await store.end_call(call_id, interrupted)

    @r.get("/calls")
    async def list_calls() -> list[dict]:
        return await store.list_calls()

    @r.get("/calls/{call_id}")
    async def get_call(call_id: str) -> dict:
        return await store.get_call(call_id)

    @r.post("/calls/{call_id}/retry", status_code=202)
    async def retry(call_id: str) -> dict:
        return await store.retry(call_id)

    @r.delete("/calls/{call_id}", status_code=204)
    async def delete_call(call_id: str) -> None:
        await store.delete(call_id)

    return r
