import json
from pathlib import Path

from backend.corpus.parse import parse_contents

BACKEND = Path(__file__).parent.parent


def test_eval_labels_are_real_sep_entries():
    slugs = set(parse_contents((BACKEND / "tests/fixtures/sep/contents.html").read_text()))
    rows = [json.loads(line) for line in (BACKEND / "eval/situations.jsonl").read_text().splitlines()]
    assert len({r["id"] for r in rows}) == len(rows)
    for r in rows:
        assert set(r["relevant"]) <= slugs, (r["id"], set(r["relevant"]) - slugs)
        if r["kind"] == "situation":
            assert 2 <= len(r["relevant"]) <= 5 and r["raw"] and r["query"]
            assert any(lens["stance"] == "challenges" for lens in r["lenses"]), r["id"]
        elif r["kind"] == "name":
            assert r["relevant"]
