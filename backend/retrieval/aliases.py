import re
import unicodedata

import jellyfish
import numpy as np
from rapidfuzz import fuzz
from rapidfuzz.process import cdist

THRESHOLD = 90
MIN_RAW = 70
MIN_GRAM = 5
PARTICLES = {"de", "von", "van", "der", "den", "du", "la", "le", "of", "al", "ibn", "bin", "da", "di", "del", "y", "the"}
_LIFE_DATES = re.compile(r"\([^)]*\d[^)]*\)")  # "(1813–1855)", "(6th c. B.C.E.)"
_FOLD = str.maketrans({"ø": "o", "æ": "ae", "œ": "oe", "ß": "ss", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ı": "i"})

# Spoken or common spellings the phonetic match can't bridge. Rows whose slug isn't in the corpus are dropped.
CURATED = {
    "lao tzu": "laozi",
    "lao tse": "laozi",
    "chuang tzu": "zhuangzi",
    "kongzi": "confucius",
    "kong fuzi": "confucius",
    "mengzi": "mencius",
    "neechee": "nietzsche",
    "nietzche": "nietzsche",
    "de beauvoir": "beauvoir",
    "kamoo": "camus",
    "marcus aurelius": "marcus-aurelius",
    "dekart": "descartes",
    "spinosa": "spinoza",
    "vitgenstein": "wittgenstein",
    "the buddha": "buddha",
}


def fold(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower().translate(_FOLD))
    return " ".join(re.sub(r"[^a-z ]+", " ", "".join(c for c in text if not unicodedata.combining(c))).split())


def is_person(entry: dict) -> bool:
    title = entry["title"]
    if "," in title:  # contents-page shape: "Kierkegaard, Søren"
        surname, given = title.split(",", 1)
        return len(surname.split()) == 1 and ":" not in given
    words = title.split()
    tokens = fold(title).split()
    return (
        len(words) <= 5
        and all(w[0].isupper() or w.lower() in PARTICLES for w in words)
        and all(part in tokens for part in entry["slug"].split("-"))
        and bool(_LIFE_DATES.search(entry["preamble"][:200]))
    )


def _row(alias: str, slug: str) -> dict:
    key = alias.replace(" ", "")
    return {"key": key, "code": jellyfish.metaphone(key), "slug": slug}


def build_table(entries: list[dict]) -> list[dict]:
    rows = {}
    for e in filter(is_person, entries):
        name = fold(e["title"])
        if "," in e["title"]:
            surname, given = (fold(x) for x in e["title"].split(",", 1))
            name = f"{given} {surname}"
        else:
            surname = next(t for t in reversed(name.split()) if t in e["slug"].split("-"))
        for alias in (surname, name):
            rows[alias] = _row(alias, e["slug"])
    slugs = {e["slug"] for e in entries}
    rows |= {alias: _row(alias, slug) for alias, slug in CURATED.items() if slug in slugs}
    return list(rows.values())


def match(query: str, table: list[dict], threshold: int = THRESHOLD) -> dict[str, float]:
    words = fold(query).split()
    grams = [g for n in (1, 2, 3) for i in range(len(words) - n + 1) if len(g := "".join(words[i : i + n])) >= MIN_GRAM]
    if not grams or not table:
        return {}
    raw = cdist(grams, [r["key"] for r in table], scorer=fuzz.ratio)
    phonetic = cdist([jellyfish.metaphone(g) for g in grams], [r["code"] for r in table], scorer=fuzz.ratio)
    score = np.where(raw >= MIN_RAW, np.maximum(raw, phonetic), raw).max(axis=0)
    out: dict[str, float] = {}
    for row, s in zip(table, score):
        if s >= threshold:
            out[row["slug"]] = max(out.get(row["slug"], 0.0), float(s))
    return out
