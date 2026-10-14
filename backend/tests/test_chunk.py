from pathlib import Path

import pytest

from backend.corpus.parse import parse_entry
from backend.retrieval.chunk import MAX_TOKENS, anchor_url, chunk_entry, is_sep_url

URL = "https://plato.stanford.edu/entries/kierkegaard/"


def words(text):
    return len(text.split())


def entry(sections, preamble="", url=URL):
    return {"slug": "kierkegaard", "title": "Søren Kierkegaard", "url": url, "preamble": preamble, "sections": sections, "related": []}


def section(paragraphs, path=("1. Life and Work",), anchor="LifWor"):
    return {"path": list(path), "anchor": anchor, "paragraphs": paragraphs}


def test_short_section_is_one_passage_with_context_prefix():
    [p] = chunk_entry(entry([section(["One two three.", "Four five.", "Six."])]), words)
    assert p["prefix"] == "Søren Kierkegaard > 1. Life and Work"
    assert p["text"] == "One two three.\n\nFour five.\n\nSix."
    assert p["anchor_url"] == URL + "#LifWor"
    assert p["section_path"] == ["1. Life and Work"]
    assert (p["id"], p["slug"], p["entry_title"]) == ("kierkegaard:0", "kierkegaard", "Søren Kierkegaard")


def test_preamble_is_a_passage_and_its_first_sentence_joins_every_prefix():
    e = entry([section(["Body."])], preamble="Søren Aabye Kierkegaard (1813–1855) was prolific. Second sentence.")
    pre, body = chunk_entry(e, words)
    assert pre["section_path"] == [] and pre["anchor_url"] == URL
    assert pre["text"].startswith("Søren Aabye")
    assert body["prefix"] == "Søren Kierkegaard > 1. Life and Work\nSøren Aabye Kierkegaard (1813–1855) was prolific."


def test_long_paragraph_splits_at_sentence_boundaries_under_the_cap():
    sentences = [" ".join(f"w{i}x{j}" for j in range(9)) + "." for i in range(100)]
    paragraph = " ".join(sentences)
    passages = chunk_entry(entry([section([paragraph])]), words)
    assert len(passages) >= 3
    assert all(words(p["text"]) <= MAX_TOKENS and p["text"].endswith(".") for p in passages)
    assert " ".join(p["text"] for p in passages) == paragraph


def test_overlong_sentence_is_still_capped():
    paragraph = " ".join(f"w{i}" for i in range(1000))
    passages = chunk_entry(entry([section([paragraph])]), words)
    assert all(words(p["text"]) <= MAX_TOKENS for p in passages)
    assert " ".join(p["text"] for p in passages) == paragraph


def test_passages_never_mix_sections():
    e = entry([section(["Alpha."], ("1. A",), "A"), section(["Beta."], ("2. B",), "B")])
    a, b = chunk_entry(e, words)
    assert (a["text"], a["section_path"], a["anchor_url"]) == ("Alpha.", ["1. A"], URL + "#A")
    assert (b["text"], b["section_path"], b["anchor_url"]) == ("Beta.", ["2. B"], URL + "#B")


@pytest.mark.parametrize(
    "url,anchor",
    [
        ("https://evil.example/entries/kierkegaard/", "A"),
        ("http://plato.stanford.edu/entries/kierkegaard/", "A"),
        ("https://plato.stanford.edu/entries/../admin/", "A"),
        (URL, 'A" onclick="x'),
        (URL, "A#B"),
    ],
)
def test_malformed_or_off_site_urls_are_rejected(url, anchor):
    assert not is_sep_url(f"{url}#{anchor}")
    with pytest.raises(ValueError):
        anchor_url(url, anchor)
    with pytest.raises(ValueError):
        chunk_entry(entry([section(["x."], anchor=anchor)], url=url), words)


def test_real_entry_chunks_within_cap_with_valid_links():
    html = (Path(__file__).parent / "fixtures" / "sep" / "kierkegaard.html").read_text()
    passages = chunk_entry(parse_entry(html, "kierkegaard"), words)
    assert len(passages) > 10
    assert all(words(p["text"]) <= MAX_TOKENS for p in passages)
    assert all(p["anchor_url"].startswith(URL) and is_sep_url(p["anchor_url"]) for p in passages)
    assert len({p["id"] for p in passages}) == len(passages)


def test_capitalized_entry_slugs_are_valid_sep_urls():
    url = "https://plato.stanford.edu/entries/emotion-Christian-tradition/"
    assert anchor_url(url, "Intr") == url + "#Intr"
    assert is_sep_url(url + "#Intr")
