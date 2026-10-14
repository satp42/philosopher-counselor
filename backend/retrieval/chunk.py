import re
from typing import Callable

from backend.corpus import SEP

MAX_TOKENS = 380
EXCERPT_WORDS = 60
_SENTENCE = re.compile(r"(?<=[.!?])\s+")
_ENTRY_URL = re.compile(re.escape(SEP) + r"/entries/[A-Za-z0-9_-]+/")
_ANCHOR = re.compile(r"[A-Za-z0-9_.:-]*")

Count = Callable[[str], int]


def is_sep_url(url: str) -> bool:
    entry, _, anchor = url.partition("#")
    return bool(_ENTRY_URL.fullmatch(entry) and _ANCHOR.fullmatch(anchor))


def anchor_url(entry_url: str, anchor: str) -> str:
    if not _ENTRY_URL.fullmatch(entry_url) or not _ANCHOR.fullmatch(anchor):
        raise ValueError("entry or anchor url is not a plato.stanford.edu/entries/ link")
    return f"{entry_url}#{anchor}" if anchor else entry_url


def doc_text(p: dict) -> str:
    return f"{p['prefix']}\n\n{p['text']}"


def excerpt(text: str, words: int = EXCERPT_WORDS) -> str:
    w = text.split()
    return " ".join(w[:words]) + ("…" if len(w) > words else "")


def _group(pieces: list[tuple[str, int]], max_tokens: int, joiner: str) -> list[tuple[str, int]]:
    groups, cur, n = [], [], 0
    for text, k in pieces:
        if cur and n + k > max_tokens:
            groups.append((joiner.join(cur), n))
            cur, n = [], 0
        cur.append(text)
        n += k
    if cur:
        groups.append((joiner.join(cur), n))
    return groups


def _split(text: str, count: Count, max_tokens: int) -> list[tuple[str, int]]:
    n = count(text)
    if n <= max_tokens:
        return [(text, n)]
    sentences = _SENTENCE.split(text)
    if len(sentences) > 1:
        return _group([p for s in sentences for p in _split(s, count, max_tokens)], max_tokens, " ")
    # ponytail: one overlong sentence is cut into even word windows; token counts are not exactly linear in words.
    words = text.split()
    size = -(-len(words) // -(-n // max_tokens))
    return [(w, count(w)) for w in (" ".join(words[i : i + size]) for i in range(0, len(words), size))]


def chunk_entry(entry: dict, count_tokens: Count, max_tokens: int = MAX_TOKENS) -> list[dict]:
    lead = _SENTENCE.split(entry["preamble"].strip(), maxsplit=1)[0]
    sections = [{"path": [], "anchor": "", "paragraphs": entry["preamble"].split("\n\n")}, *entry["sections"]]
    passages = []
    for s in sections:
        url = anchor_url(entry["url"], s["anchor"])
        pieces = [p for para in s["paragraphs"] if para.strip() for p in _split(para, count_tokens, max_tokens)]
        for text, _ in _group(pieces, max_tokens, "\n\n"):
            passages.append(
                {
                    "id": f"{entry['slug']}:{len(passages)}",
                    "slug": entry["slug"],
                    "entry_title": entry["title"],
                    "section_path": s["path"],
                    "anchor_url": url,
                    "prefix": " > ".join([entry["title"], *s["path"]]) + (f"\n{lead}" if lead else ""),
                    "text": text,
                }
            )
    return passages
