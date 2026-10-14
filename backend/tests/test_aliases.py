import pytest

from backend.retrieval.aliases import THRESHOLD, build_table, fold, is_person, match


def person(slug, title, dates="(1813–1855)"):
    return {"slug": slug, "title": title, "preamble": f"{title} {dates} was a philosopher.", "sections": [], "related": []}


def topic(slug, title):
    return {"slug": slug, "title": title, "preamble": f"{title} is a topic.", "sections": [], "related": []}


ENTRIES = [
    person("kierkegaard", "Søren Kierkegaard"),
    person("heidegger", "Martin Heidegger", "(1889–1976)"),
    person("epictetus", "Epictetus", "(c. 50–c. 135 C.E.)"),
    person("leibniz", "Gottfried Wilhelm Leibniz", "(1646–1716)"),
    person("kant", "Immanuel Kant", "(1724–1804)"),
    person("beauvoir", "Simone de Beauvoir", "(1908–1986)"),
    person("laozi", "Laozi", "(6th c. B.C.E.)"),
    topic("existentialism", "Existentialism"),
    topic("kant-hume-morality", "Kant and Hume on Morality"),
]
TABLE = build_table(ENTRIES)


@pytest.mark.parametrize("heard,slug", [("kirk a guard", "kierkegaard"), ("hi degger", "heidegger"), ("epic tetus", "epictetus")])
def test_misheard_names_resolve(heard, slug):
    assert match(f"what would {heard} say about dread", TABLE).get(slug, 0) >= THRESHOLD


def test_lie_bits_does_not_match():
    assert match("lie bits", TABLE) == {}


def test_full_names_and_curated_variants_match():
    assert match("simone de beauvoir on freedom", TABLE).get("beauvoir", 0) >= THRESHOLD
    assert match("the lao tzu idea of wu wei", TABLE).get("laozi", 0) >= THRESHOLD


def test_curated_variant_dropped_when_entry_missing():
    assert not any(r["slug"] == "zhuangzi" for r in TABLE)


def test_person_detection():
    assert all(is_person(e) for e in ENTRIES[:7])
    assert not is_person(ENTRIES[7]) and not is_person(ENTRIES[8])
    assert is_person({"slug": "kierkegaard", "title": "Kierkegaard, Søren", "preamble": ""})
    assert not is_person({"slug": "kant-hume-causality", "title": "Kant, Immanuel: and Hume on causality", "preamble": ""})


def test_ordinary_words_do_not_match():
    assert match("I feel anxious about going home and whether I can count on my friends", TABLE) == {}


def test_fold():
    assert fold("Søren  Kierkegaard!") == "soren kierkegaard"
