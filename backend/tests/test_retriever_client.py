import asyncio
from types import SimpleNamespace

import modal
import pytest

from backend.retrieval.retriever import RetrieverClient


def client_warming(outcome):
    async def get(timeout=None):
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    client = RetrieverClient.__new__(RetrieverClient)
    client.warming = SimpleNamespace(get=SimpleNamespace(aio=get))
    return client


def test_not_ready_before_warm_is_spawned():
    client = RetrieverClient.__new__(RetrieverClient)
    client.warming = None
    assert asyncio.run(client.ready()) is False


@pytest.mark.parametrize("pending", [TimeoutError(), modal.exception.TimeoutError()])
def test_unfinished_warm_keeps_waiting(pending):
    client = client_warming(pending)
    assert asyncio.run(client.ready()) is False
    assert client.warming is not None


def test_finished_warm_reports_ready():
    assert asyncio.run(client_warming({"version": "v3"}).ready()) is True


def test_failed_warm_is_forgotten_so_it_can_be_respawned():
    client = client_warming(RuntimeError("boom"))
    assert asyncio.run(client.ready()) is False
    assert client.warming is None
