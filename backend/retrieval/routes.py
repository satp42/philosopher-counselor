import time

from fastapi import HTTPException
from pydantic import BaseModel, Field

from backend import auth
from backend.guide.tools import Stance

PLAN_KEYS = ("lens_id", "tradition", "stance", "grounded")


class RetrieveBody(BaseModel):
    call_id: str
    query: str = Field(min_length=1, max_length=1000)
    lens_id: str | None = Field(default=None, max_length=32)
    stance: Stance | None = None


class Lens(BaseModel):
    tradition: str = Field(min_length=1, max_length=120)
    query: str = Field(min_length=1, max_length=1000)
    stance: Stance


class LensMapBody(BaseModel):
    call_id: str
    lenses: list[Lens] = Field(min_length=2, max_length=8)


def router(store, retriever):
    api = auth.protected_router()

    async def fetch(name, call_id, fn, *args) -> dict:
        call = await store.require_active(call_id)
        # The browser dispatcher already refuses philosophy during crisis. This closes a second client.
        if call.crisis:
            raise HTTPException(status_code=403, detail="care-only")
        try:
            return await fn(*args)
        except Exception as e:
            print(f"{name} failed call={call_id} error={type(e).__name__}")
            raise HTTPException(status_code=502, detail="retrieval unavailable") from None

    def log(name, call_id, passages, t) -> None:
        print(f"{name} call={call_id} passages={len(passages)} ms={(time.perf_counter() - t) * 1000:.0f}")

    @api.post("/warm", status_code=202)
    async def warm() -> dict:
        await retriever.warm()
        return {"warming": True}

    @api.get("/warm/status")
    async def warm_status() -> dict:
        return {"ready": await retriever.ready()}

    @api.post("/retrieve")
    async def retrieve(body: RetrieveBody) -> dict:
        t = time.perf_counter()
        result = await fetch("retrieve", body.call_id, retriever.search, body.query)
        await store.record_served(body.call_id, result["passages"], consulted_lens_id=body.lens_id)
        log("retrieve", body.call_id, result["passages"], t)
        return {"lens_id": body.lens_id, "stance": body.stance, **result}

    @api.post("/lens-map")
    async def lens_map(body: LensMapBody) -> dict:
        t = time.perf_counter()
        result = await fetch("lens-map", body.call_id, retriever.lens_map, [lens.model_dump() for lens in body.lenses])
        passages = [p for lens in result["lenses"] for p in lens["passages"]]
        plan = [
            {**{k: lens[k] for k in PLAN_KEYS}, "passage_ids": [p["passage_id"] for p in lens["passages"]]}
            for lens in result["lenses"]
        ]
        plan = await store.record_served(body.call_id, passages, lens_plan=plan)
        for lens, recorded in zip(result["lenses"], plan):
            lens["lens_id"] = recorded["lens_id"]
        log("lens-map", body.call_id, passages, t)
        return result

    return api
