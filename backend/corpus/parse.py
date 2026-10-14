import re

from bs4 import BeautifulSoup

from backend.corpus import SEP

HEADINGS = {"h2": 0, "h3": 1, "h4": 2}
BLOCKS = {"p", "blockquote", "li", "dt", "dd", "pre", "table"}
EXCLUDED = ("bibliography", "other internet resources", "related entries", "acknowledg", "academic tools")


def _text(el) -> str:
    return " ".join(el.get_text().split())


def parse_contents(html: str) -> list[str]:
    soup = BeautifulSoup(html, "lxml")
    slugs = (re.match(r"entries/([A-Za-z0-9_-]+)", a["href"]) for a in soup.find_all("a", href=True))
    return list(dict.fromkeys(m[1] for m in slugs if m))


def parse_entry(html: str, slug: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    for sup in soup.select('sup:has(a[href^="notes.html"])'):
        sup.decompose()

    title = soup.find("meta", attrs={"name": "citation_title"})
    pubinfo = soup.find(id="pubinfo")
    preamble = soup.find(id="preamble")
    main = soup.find(id="main-text")

    sections, path, current = [], [], {"path": [], "anchor": "", "paragraphs": []}
    for el in main.find_all([*HEADINGS, *BLOCKS]) if main else []:
        if el.name in HEADINGS:
            sections.append(current)
            heading = _text(el)
            a = el.find("a")  # older entries: <h2><a name="X"> or <h2><a id="X">
            anchor = el.get("id") or (a and (a.get("id") or a.get("name"))) or ""
            path = path[: HEADINGS[el.name]] + [heading]
            current = {"path": path, "anchor": anchor, "paragraphs": []}
            if heading.lower().lstrip("0123456789. ").startswith(EXCLUDED):
                current = None
        elif current is not None and not any(p.name in BLOCKS for p in el.parents):
            if text := _text(el):
                current["paragraphs"].append(text)
    sections.append(current)

    related = soup.select('#related-entries a[href^="../"]')
    return {
        "slug": slug,
        "title": title["content"].strip() if title else slug,
        "url": f"{SEP}/entries/{slug}/",
        "pubinfo": _text(pubinfo) if pubinfo else "",
        "preamble": "\n\n".join(_text(p) for p in preamble.find_all("p")) if preamble else "",
        "sections": [s for s in sections if s and s["paragraphs"]],
        "related": list(dict.fromkeys(a["href"][3:].split("/")[0] for a in related)),
    }
