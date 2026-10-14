from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path

import pytest
import requests

from backend.corpus import crawl
from backend.corpus.crawl import fetch, save_entry
from backend.corpus.parse import parse_contents, parse_entry

FIXTURES = Path(__file__).parent / "fixtures" / "sep"


def load(name):
    return (FIXTURES / f"{name}.html").read_text()


def all_text(entry):
    return " ".join([entry["preamble"], *(p for s in entry["sections"] for p in s["paragraphs"])])


def test_kierkegaard_entry_is_fully_structured():
    e = parse_entry(load("kierkegaard"), "kierkegaard")
    assert e["title"] == "Søren Kierkegaard"
    assert e["url"] == "https://plato.stanford.edu/entries/kierkegaard/"
    assert e["pubinfo"].startswith("First published")
    assert e["preamble"]
    assert len(e["sections"]) >= 5
    assert all(s["anchor"] and s["paragraphs"] for s in e["sections"])
    assert {"existentialism", "kant", "hegel"} <= set(e["related"]) and len(e["related"]) >= 5
    assert "[1]" not in all_text(e)


def test_heading_path_tracks_nesting():
    sections = {s["anchor"]: s for s in parse_entry(load("kierkegaard"), "kierkegaard")["sections"]}
    assert sections["Fait"]["path"] == [
        "3. The “Spheres of Existence” or “Stages on Life’s Way”",
        "3.3 The Religious and the Life of Faith",
        "3.3.1 Faith",
    ]
    assert sections["TrajKierScho"]["path"] == ["4. Trajectories in Kierkegaard Scholarship"]


def test_kant_old_style_a_name_headings_still_get_anchors():
    e = parse_entry(load("kant"), "kant")
    assert e["title"] == "Immanuel Kant"
    assert len(e["sections"]) >= 5
    assert all(s["anchor"] for s in e["sections"])
    assert e["sections"][0]["anchor"] == "LifWor"
    assert "[1]" not in all_text(e)


def test_a_id_heading_style_gets_anchor():
    html = '<div id="main-text"><h2><a id="LifWor">1. Life</a></h2><p>Born.</p></div>'
    assert parse_entry(html, "abelard")["sections"] == [{"path": ["1. Life"], "anchor": "LifWor", "paragraphs": ["Born."]}]


def test_reference_sections_are_excluded():
    paths = [" ".join(s["path"]).lower() for name in ("kierkegaard", "kant") for s in parse_entry(load(name), name)["sections"]]
    for word in ("bibliography", "other internet resources", "related entries", "acknowledg", "academic tools"):
        assert not any(word in p for p in paths)


def test_missing_related_entries_is_empty_not_error():
    html = load("kierkegaard")
    start = html.index('<div id="related-entries">')
    html = html[:start] + html[html.index("</div>", start) + 6 :]
    assert parse_entry(html, "kierkegaard")["related"] == []


def test_contents_yields_unique_bare_slugs():
    slugs = parse_contents(load("contents"))
    assert len(slugs) == len(set(slugs)) > 1500
    assert {"kierkegaard", "kant", "abduction", "emotion-Christian-tradition"} <= set(slugs)
    assert not any("#" in s or "/" in s for s in slugs)


class FakeResponse:
    def __init__(self, status_code, text="", headers=None):
        self.status_code, self.text, self.headers = status_code, text, headers or {}


class FakeSession:
    def __init__(self, *results):
        self.results, self.calls = list(results), 0

    def get(self, url, timeout):
        result = self.results[min(self.calls, len(self.results) - 1)]
        self.calls += 1
        if isinstance(result, Exception):
            raise result
        return result


@pytest.mark.parametrize("result", [FakeResponse(404), FakeResponse(403)])
def test_missing_pages_are_skipped_without_retry_and_refetched_next_run(result, tmp_path, capsys):
    session = FakeSession(result)
    assert fetch(session, "https://x/", sleep=pytest.fail) is None
    assert session.calls == 1 and "skip" in capsys.readouterr().out
    save_entry(FakeSession(result), "kant", tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_rate_limits_and_outages_back_off_then_succeed():
    waits = []
    retry_at = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=120), usegmt=True)
    session = FakeSession(
        FakeResponse(429, headers={"Retry-After": "7"}),
        FakeResponse(503, headers={"Retry-After": retry_at}),
        FakeResponse(429, headers={"Retry-After": "99999"}),
        requests.ConnectionError("down"),
        FakeResponse(500),
        FakeResponse(200, "ok"),
    )
    assert fetch(session, "https://x/", sleep=waits.append) == "ok"
    assert waits[0] == 7 and 100 < waits[1] <= 120
    assert waits[2:] == [crawl.BACKOFF_CAP, crawl.BACKOFF * 8, crawl.BACKOFF * 16]


def test_consecutive_failures_abort_the_crawl():
    waits = []
    session = FakeSession(FakeResponse(503))
    with pytest.raises(RuntimeError, match="crawl aborted"):
        fetch(session, "https://x/", sleep=waits.append)
    assert session.calls == crawl.MAX_FAILURES and len(waits) == crawl.MAX_FAILURES - 1
    assert max(waits) == crawl.BACKOFF_CAP


def test_crawl_saves_successful_entry(tmp_path):
    save_entry(FakeSession(FakeResponse(200, "<html>ok</html>")), "kant", tmp_path)
    assert (tmp_path / "kant.html").read_text() == "<html>ok</html>"
    assert [p.name for p in tmp_path.iterdir()] == ["kant.html"]


def test_sup_with_several_note_links_is_stripped_once():
    html = (
        '<html><head><meta name="citation_title" content="Tense"></head><body>'
        '<div id="main-text"><h2 id="One">1. One</h2>'
        '<p>Claim.<sup>[<a href="notes.html#note-1">1</a>, <a href="notes.html#note-2">2</a>]</sup> More.</p>'
        "</div></body></html>"
    )
    entry = parse_entry(html, "tense-aspect")
    text = " ".join(entry["sections"][0]["paragraphs"])
    assert "Claim." in text and "[1" not in text
