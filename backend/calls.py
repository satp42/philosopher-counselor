"""Writes are not committed one by one: Modal commits in the background and on
container exit. Only writes another container must see right away commit
explicitly (create, end before spawning synthesis, retry, delete, memory).
"""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
import inspect
import json
import os
import re
import shutil
import time
from typing import Annotated, Literal
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

from backend import auth, bandit
from backend.guide.config import DEFAULT_VARIANT, MODALITIES, Modality

MAX_BATCH_BYTES = 64 * 1024
MAX_RECORD_BYTES = 2 * 1024 * 1024
MAX_MEMORY_BYTES = 256 * 1024
MAX_MEMORY_ENTRIES = 50
MAX_CONTEXT_ENTRIES = 5
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


class MemoryBody(BaseModel):
    notes: list[Annotated[str, Field(min_length=1, max_length=500)]] = Field(default=[], max_length=50)


def modality_of(rec: dict) -> Modality:
    """Records written before text mode have no field and are voice."""
    value = rec.get("modality", "voice")
    return value if value in MODALITIES else "voice"


@dataclass(frozen=True)
class VoiceCall:
    variant: str
    crisis: bool
    memory: str | None = None


@dataclass(frozen=True)
class TextCall:
    crisis: bool
    memory: str | None = None


ActiveCall = VoiceCall | TextCall


def _status(rec: dict, synth: dict | None, now: float) -> str:
    if rec["status"] != "ending":
        return rec["status"]
    if synth and synth.get("attempt") == rec.get("attempts") and synth.get("status") in ("ready", "failed"):
        return synth["status"]
    return "failed" if now - rec.get("spawned_at", 0) > STUCK_AFTER else "generating"


def read_tenant_memory(tenant_dir: Path) -> dict:
    """Read the tenant's memory.json or return an empty memory structure."""
    path = tenant_dir / "memory.json"
    if path.exists():
        try:
            data = json.loads(path.read_text())
            if isinstance(data, dict):
                return {
                    "notes": list(data.get("notes") or []),
                    "entries": list(data.get("entries") or []),
                    "updated_at": data.get("updated_at"),
                }
        except (OSError, ValueError):
            pass
    return {"notes": [], "entries": [], "updated_at": None}


def write_tenant_memory(tenant_dir: Path, memory: dict) -> None:
    """Atomically write the tenant's memory.json on the Modal volume."""
    data = json.dumps(memory)
    if len(data.encode()) > MAX_MEMORY_BYTES:
        raise HTTPException(status_code=413, detail="memory too large")
    tenant_dir.mkdir(parents=True, exist_ok=True)
    path = tenant_dir / "memory.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(data)
    os.replace(tmp, path)


def sync_call_to_memory(tenant_dir: Path, rec: dict, page: dict | None = None, now: float | None = None) -> None:
    """Upsert or purge a conversation's distilled entry in the account tenant's memory.json."""
    mem = read_tenant_memory(tenant_dir)
    call_id = rec["id"]
    entries = [e for e in mem["entries"] if e.get("call_id") != call_id]
    if rec.get("flags", {}).get("crisis") or (page and page.get("variant") == "crisis"):
        if len(entries) != len(mem["entries"]):
            mem["entries"] = entries
            mem["updated_at"] = now or time.time()
            write_tenant_memory(tenant_dir, mem)
        return
    summary = (page or {}).get("situation") or rec.get("summary") or ""
    if not summary:
        return
    existing = next((e for e in mem["entries"] if e.get("call_id") == call_id), {})
    if page and page.get("lenses"):
        traditions = [l["tradition"] for l in page["lenses"] if l.get("tradition")]
    elif rec.get("lens_plan"):
        traditions = [l["tradition"] for l in rec["lens_plan"] if l.get("grounded") and l.get("tradition")]
    else:
        traditions = existing.get("traditions") or []
    ts = now if now is not None else time.time()
    entry = {
        "call_id": call_id,
        "started_at": rec.get("started_at", ts),
        "updated_at": ts,
        "title": (page or {}).get("title") or existing.get("title"),
        "summary": summary,
        "leaning": rec.get("leaning") or existing.get("leaning"),
        "traditions": traditions,
        "open_questions": (page or {}).get("open_questions") or existing.get("open_questions") or [],
    }
    entries.append(entry)
    entries.sort(key=lambda e: e.get("started_at", 0), reverse=True)
    mem["entries"] = entries[:MAX_MEMORY_ENTRIES]
    mem["updated_at"] = ts
    write_tenant_memory(tenant_dir, mem)


class CallStore:
    def __init__(
        self,
        root: Path,
        commit: Callable[[], Awaitable[None]],
        reload: Callable[[], Awaitable[None]],
        spawn_synthesis: Callable[..., Awaitable[object]],
        now: Callable[[], float] = time.time,
    ):
        self.root = root
        self.commit = commit
        self.reload = reload
        self.spawn_synthesis = spawn_synthesis
        self.now = now
        self._spawn_takes_tenant = len(inspect.signature(spawn_synthesis).parameters) >= 2
        # ponytail: one global lock for every record and the reload; per-call locks if traffic ever grows.
        self.lock = asyncio.Lock()
        root.mkdir(parents=True, exist_ok=True)
        (root / auth.DEFAULT_TENANT).mkdir(parents=True, exist_ok=True)

    def tenant_dir(self, tenant_id: str | None = None) -> Path:
        tid = tenant_id or auth.current_tenant()
        if not _ID.fullmatch(tid):
            raise HTTPException(status_code=404, detail="not found")
        return self.root / tid

    def _dir(self, call_id: str, tenant_id: str | None = None) -> Path:
        base = self.tenant_dir(tenant_id)
        if not _ID.fullmatch(call_id) or not (base / call_id / "record.json").exists():
            raise HTTPException(status_code=404, detail="not found")
        return base / call_id

    def _read(self, call_id: str, tenant_id: str | None = None) -> dict:
        return json.loads((self._dir(call_id, tenant_id) / "record.json").read_text())

    def _read_active(self, call_id: str, tenant_id: str | None = None) -> dict:
        rec = self._read(call_id, tenant_id)
        if rec["status"] != "active":
            raise HTTPException(status_code=409, detail="call ended")
        return rec

    def _records(self, tenant_id: str | None = None) -> list[dict]:
        base = self.tenant_dir(tenant_id)
        if not base.exists():
            return []
        records = []
        for p in base.glob("*/record.json"):
            try:
                records.append(json.loads(p.read_text()))
            except (OSError, ValueError):
                print(f"call {p.parent.name} record unreadable, skipped")
        return records

    def _synthesis(self, call_id: str, tenant_id: str | None = None) -> dict | None:
        path = self.tenant_dir(tenant_id) / call_id / "synthesis.json"
        return json.loads(path.read_text()) if path.exists() else None

    def _write(self, rec: dict, tenant_id: str | None = None) -> None:
        data = json.dumps(rec)
        if len(data.encode()) > MAX_RECORD_BYTES:
            raise HTTPException(status_code=413, detail="record too large")
        path = self.tenant_dir(tenant_id) / rec["id"] / "record.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(data)
        os.replace(tmp, path)

    def _memory_context(self, tenant_id: str | None = None, exclude_call_id: str | None = None) -> str | None:
        mem = read_tenant_memory(self.tenant_dir(tenant_id))
        lines: list[str] = []
        for note in mem["notes"]:
            lines.append(f"- Note: {note}")
        entries = [e for e in mem["entries"] if e.get("call_id") != exclude_call_id and e.get("summary")]
        for entry in entries[:MAX_CONTEXT_ENTRIES]:
            label = entry.get("title") or "Earlier conversation"
            detail = f"- {label}: {entry['summary']}"
            if entry.get("leaning"):
                detail += f" (leaning: {entry['leaning']})"
            if entry.get("traditions"):
                detail += f" [explored: {', '.join(entry['traditions'])}]"
            lines.append(detail)
        return "\n".join(lines) if lines else None

    async def _spawn(self, rec: dict, tenant_id: str | None = None) -> None:
        """Start a synthesis attempt; committed first so the job's container sees the record."""
        tid = tenant_id or auth.current_tenant()
        rec["attempts"] = rec.get("attempts", 0) + 1
        rec["spawned_at"] = self.now()
        self._write(rec, tid)
        await self.commit()
        if self._spawn_takes_tenant:
            await self.spawn_synthesis(rec["id"], tid)
        else:
            await self.spawn_synthesis(rec["id"])

    async def _end(self, rec: dict, interrupted: bool, tenant_id: str | None = None) -> dict:
        if rec["status"] != "active":
            return rec
        tid = tenant_id or auth.current_tenant()
        rec["status"] = "ending"
        rec["flags"]["interrupted"] = rec["flags"]["interrupted"] or interrupted
        sync_call_to_memory(self.tenant_dir(tid), rec, now=self.now())
        await self._spawn(rec, tid)
        print(f"call {rec['id']} ending interrupted={rec['flags']['interrupted']}")
        return rec

    async def _sweep(self, records: list[dict], tenant_id: str | None = None) -> None:
        for rec in records:
            window = STALE_AFTER[modality_of(rec)]
            if rec["status"] == "active" and self.now() - rec["last_event_at"] > window:
                await self._end(rec, interrupted=True, tenant_id=tenant_id)

    async def _load(self, call_id: str, tenant_id: str | None = None) -> tuple[dict, dict | None]:
        await self.reload()
        rec = self._read(call_id, tenant_id)
        await self._sweep([rec], tenant_id)
        return rec, self._synthesis(call_id, tenant_id)

    async def create(self, modality: Modality = "voice", tenant_id: str | None = None) -> dict:
        async with self.lock:
            tid = tenant_id or auth.current_tenant()
            records = self._records(tid)
            await self._sweep(records, tid)
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
                "tenant_id": tid,
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
            self._write(rec, tid)
            await self.commit()
            print(f"call {rec['id']} created modality={modality} variant={variant}")
            return {"id": rec["id"]}

    async def append_events(self, call_id: str, events: list[Event], tenant_id: str | None = None) -> None:
        async with self.lock:
            tid = tenant_id or auth.current_tenant()
            rec = self._read_active(call_id, tid)
            memory_touched = False
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
                        memory_touched = True
                    case AckEvent():
                        acked = rec["acked_passage_ids"]
                        acked.extend(p for p in dict.fromkeys(e.passage_ids) if p not in acked)
                    case FlagEvent():
                        rec["flags"][e.flag] = True
                        if e.flag == "crisis":
                            memory_touched = True
                    case MetricsEvent():
                        rec["metrics"] = e.metrics
            rec["last_event_at"] = self.now()
            self._write(rec, tid)
            if memory_touched:
                sync_call_to_memory(self.tenant_dir(tid), rec, now=self.now())

    async def require_active(self, call_id: str, tenant_id: str | None = None) -> ActiveCall:
        """The call is active. Routes read the variant from a voice call, crisis flag, and tenant memory."""
        async with self.lock:
            tid = tenant_id or auth.current_tenant()
            rec = self._read_active(call_id, tid)
            crisis = bool(rec["flags"].get("crisis"))
            memory = None if crisis else self._memory_context(tid, exclude_call_id=call_id)
            if modality_of(rec) == "text":
                return TextCall(crisis, memory)
            return VoiceCall(rec.get("variant") or DEFAULT_VARIANT, crisis, memory)

    async def record_served(
        self,
        call_id: str,
        passages: list[dict],
        lens_plan: list[dict] | None = None,
        consulted_lens_id: str | None = None,
        tenant_id: str | None = None,
    ) -> list[dict] | None:
        """Returns the recorded lens plan, its ids namespaced per mapping (m<n>-<id>) so a lens id consulted under
        an earlier plan never matches a later one."""
        async with self.lock:
            tid = tenant_id or auth.current_tenant()
            rec = self._read_active(call_id, tid)
            for p in passages:
                rec["served_passages"][p["passage_id"]] = p
            if lens_plan is not None:
                rec["lens_maps"] = n = rec.get("lens_maps", 0) + 1
                rec["lens_plan"] = lens_plan = [{**lens, "lens_id": f"m{n}-{lens['lens_id']}"} for lens in lens_plan]
            consulted = rec.setdefault("consulted_lens_ids", [])  # setdefault: records created before the field
            if consulted_lens_id and consulted_lens_id not in consulted:
                consulted.append(consulted_lens_id)
            rec["last_event_at"] = self.now()
            self._write(rec, tid)
            if lens_plan is not None and rec.get("summary"):
                sync_call_to_memory(self.tenant_dir(tid), rec, now=self.now())
            return lens_plan

    async def end_call(self, call_id: str, interrupted: bool = False, tenant_id: str | None = None) -> dict:
        async with self.lock:
            tid = tenant_id or auth.current_tenant()
            rec = await self._end(self._read(call_id, tid), interrupted, tid)
            return {"id": rec["id"], "status": rec["status"]}

    async def list_calls(self, tenant_id: str | None = None) -> list[dict]:
        async with self.lock:
            tid = tenant_id or auth.current_tenant()
            await self.reload()
            records = self._records(tid)
            await self._sweep(records, tid)
            calls = []
            for rec in records:
                synth = self._synthesis(rec["id"], tid)
                title = ((synth or {}).get("page") or {}).get("title")
                status = _status(rec, synth, self.now())
                calls.append({"id": rec["id"], "started_at": rec["started_at"], "status": status, "title": title})
            return sorted(calls, key=lambda c: c["started_at"], reverse=True)

    async def get_call(self, call_id: str, tenant_id: str | None = None) -> dict:
        async with self.lock:
            tid = tenant_id or auth.current_tenant()
            rec, synth = await self._load(call_id, tid)
            rec["served_passage_ids"] = list(rec.pop("served_passages"))
            rec["status"] = _status(rec, synth, self.now())
            rec["synthesis"] = synth
            return rec

    async def retry(self, call_id: str, tenant_id: str | None = None) -> dict:
        async with self.lock:
            tid = tenant_id or auth.current_tenant()
            rec, synth = await self._load(call_id, tid)
            if _status(rec, synth, self.now()) != "failed":
                raise HTTPException(status_code=409, detail="not failed")
            await self._spawn(rec, tid)
            print(f"call {call_id} synthesis attempt={rec['attempts']}")
            return {"id": call_id, "status": "generating"}

    async def delete(self, call_id: str, tenant_id: str | None = None) -> None:
        async with self.lock:
            tid = tenant_id or auth.current_tenant()
            shutil.rmtree(self._dir(call_id, tid))
            tdir = self.tenant_dir(tid)
            if (tdir / "memory.json").exists():
                mem = read_tenant_memory(tdir)
                filtered = [e for e in mem["entries"] if e.get("call_id") != call_id]
                if len(filtered) != len(mem["entries"]):
                    mem["entries"] = filtered
                    mem["updated_at"] = self.now()
                    write_tenant_memory(tdir, mem)
            await self.commit()
            print(f"call {call_id} deleted")

    async def get_memory(self, tenant_id: str | None = None) -> dict:
        async with self.lock:
            tid = tenant_id or auth.current_tenant()
            await self.reload()
            return read_tenant_memory(self.tenant_dir(tid))

    async def update_memory(self, notes: list[str], tenant_id: str | None = None) -> dict:
        async with self.lock:
            tid = tenant_id or auth.current_tenant()
            await self.reload()
            tdir = self.tenant_dir(tid)
            mem = read_tenant_memory(tdir)
            mem["notes"] = [n.strip() for n in notes if n.strip()]
            mem["updated_at"] = self.now()
            write_tenant_memory(tdir, mem)
            await self.commit()
            return mem

    async def clear_memory(self, tenant_id: str | None = None) -> None:
        async with self.lock:
            tid = tenant_id or auth.current_tenant()
            path = self.tenant_dir(tid) / "memory.json"
            if path.exists():
                path.unlink()
                await self.commit()


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

    @r.get("/memory")
    async def get_memory() -> dict:
        return await store.get_memory()

    @r.put("/memory")
    async def put_memory(body: MemoryBody) -> dict:
        return await store.update_memory(body.notes)

    @r.delete("/memory", status_code=204)
    async def delete_memory() -> None:
        await store.clear_memory()

    return r
