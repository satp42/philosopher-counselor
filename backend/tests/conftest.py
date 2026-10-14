import asyncio

import pytest

from backend import auth
from backend.calls import CallStore
from backend.corpus import SEP
from backend.retrieval.chunk import excerpt

ORIGIN = {"origin": "https://testserver"}
PASSPHRASE = "correct horse battery staple 42"


@pytest.fixture
def app_env(monkeypatch):
    monkeypatch.setenv("APP_PASSPHRASE", PASSPHRASE)
    monkeypatch.setenv("APP_SIGNING_KEY", "k" * 64)
    auth.reset_rate_limits()


async def _yield():
    await asyncio.sleep(0)  # yield, so concurrent callers really interleave


def make_store(tmp_path, **kw) -> CallStore:
    spawned = []

    async def spawn(call_id):
        spawned.append(call_id)

    store = CallStore(tmp_path / "calls", **{"commit": _yield, "reload": _yield, "spawn_synthesis": spawn, **kw})
    store.spawned = spawned
    return store


def login(client, passphrase=PASSPHRASE, headers=ORIGIN):
    return client.post("/api/login", json={"passphrase": passphrase}, headers=headers)


def login_and_call(client) -> str:
    login(client)
    r = client.post("/api/calls", headers=ORIGIN)
    assert r.status_code == 201
    return r.json()["id"]


def passage(pid, url=None, words=20, **kw):
    slug = pid.split(":")[0]
    text = " ".join(f"{pid}w{i}" for i in range(words))
    return {
        "passage_id": pid,
        "slug": slug,
        "entry_title": f"Entry {pid}",
        "section_path": "1. Introduction",
        "url": url or f"{SEP}/entries/{slug}/#1",
        "text": text,
        "excerpt": excerpt(text),
        "score": 0.9,
        **kw,
    }
