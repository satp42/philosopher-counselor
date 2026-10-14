import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import modal

from backend.corpus import SEP
from backend.modal_app import CORPUS_DEPS, DATA, PYTHON, _with_backend, app, volume

UA = "sep-counselor/0.1 (personal non-commercial indexing)"
CORPUS = Path(DATA) / "corpus"
RAW = CORPUS / "raw"
MAX_FAILURES = 10
BACKOFF = 10
BACKOFF_CAP = 600

image = _with_backend(modal.Image.debian_slim(python_version=PYTHON).uv_pip_install(*CORPUS_DEPS))


def _retry_after(value: str | None) -> float | None:
    if not value:
        return None
    if value.strip().isdigit():
        return float(value)
    try:
        return max(0.0, (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds())
    except (TypeError, ValueError):
        return None


def fetch(session, url: str, sleep=time.sleep) -> str | None:
    import requests

    for attempt in range(MAX_FAILURES):
        wait = None
        try:
            r = session.get(url, timeout=60)
        except requests.RequestException as e:
            why = type(e).__name__
        else:
            if r.status_code == 200:
                return r.text
            if r.status_code != 429 and r.status_code < 500:
                print(f"skip {url}: HTTP {r.status_code}")
                return None
            why, wait = f"HTTP {r.status_code}", _retry_after(r.headers.get("Retry-After"))
        if attempt + 1 < MAX_FAILURES:
            wait = min(BACKOFF * 2**attempt if wait is None else wait, BACKOFF_CAP)
            print(f"{why} on {url}, retrying in {wait:.0f}s")
            sleep(wait)
    raise RuntimeError(f"crawl aborted: {MAX_FAILURES} failures in a row fetching {url} ({why})")


def save_entry(session, slug: str, raw_dir: Path) -> None:
    html = fetch(session, f"{SEP}/entries/{slug}/")
    if html is None:
        return
    tmp = raw_dir / f"{slug}.html.tmp"
    tmp.write_text(html)
    tmp.rename(raw_dir / f"{slug}.html")


@app.function(image=image, volumes={DATA: volume}, timeout=86400)
def crawl(limit: int = 0) -> None:
    import urllib.robotparser

    import requests

    from backend.corpus.parse import parse_contents

    session = requests.Session()
    session.headers["User-Agent"] = UA
    robots_txt = fetch(session, f"{SEP}/robots.txt")
    if robots_txt is None:
        raise RuntimeError("could not fetch robots.txt; not crawling without it")
    robots = urllib.robotparser.RobotFileParser()
    robots.parse(robots_txt.splitlines())
    delay = max(5, robots.crawl_delay(UA) or 0)

    contents = fetch(session, f"{SEP}/contents.html")
    if contents is None:
        raise RuntimeError("could not fetch contents.html")
    slugs = parse_contents(contents)
    RAW.mkdir(parents=True, exist_ok=True)
    todo = [s for s in slugs if not (RAW / f"{s}.html").exists() and robots.can_fetch(UA, f"{SEP}/entries/{s}/")]
    todo = todo[:limit] if limit else todo
    print(f"{len(slugs)} slugs, {len(todo)} to fetch, {delay}s apart")

    try:
        for i, slug in enumerate(todo, 1):
            time.sleep(delay)
            save_entry(session, slug, RAW)
            if i % 50 == 0:
                volume.commit()
                print(f"{i}/{len(todo)}")
    finally:
        volume.commit()


@app.function(image=image, volumes={DATA: volume}, timeout=3600)
def build_entries() -> None:
    import json

    from backend.corpus.parse import parse_entry

    volume.reload()
    n = 0
    with open(CORPUS / "entries.jsonl", "w") as out:
        for path in sorted(RAW.glob("*.html")):
            try:
                entry = parse_entry(path.read_text(), path.stem)
            except Exception as e:
                print(f"skip {path.name}: {e!r}")
                continue
            out.write(json.dumps(entry, ensure_ascii=False) + "\n")
            n += 1
    volume.commit()
    print(f"wrote {n} entries")


@app.local_entrypoint()
def crawl_all(limit: int = 0) -> None:
    crawl.remote(limit)
    build_entries.remote()
