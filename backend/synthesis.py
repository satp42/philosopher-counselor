import json
import os
import time
from collections.abc import Callable
from pathlib import Path

from pydantic import BaseModel

from backend.calls import modality_of, sync_call_to_memory
from backend.guide.config import MODALITIES
from backend.guide.tools import Stance
from backend.retrieval.chunk import excerpt, is_sep_url

MODEL = "gemini-3.8-flash"
FAILED = "The page couldn't be written."

Generate = Callable[[str, dict], dict]


class LensOut(BaseModel):
    lens_id: str
    tradition: str
    stance: Stance
    take: str
    citations: list[str]


class PageOut(BaseModel):
    title: str
    situation: str
    lenses: list[LensOut]
    synthesis: str
    open_questions: list[str]


class NotesOut(BaseModel):
    title: str
    situation: str
    open_questions: list[str]


HEARD = {
    "voice": "The transcript comes from speech recognition, so names may be misheard",
    "text": "The conversation was typed, so names may be misspelled",
}
CONVERSATION = {"voice": "a voice conversation", "text": "a written conversation"}
assert set(HEARD) == set(CONVERSATION) == set(MODALITIES)

STYLE = """Write plainly and warmly, in the second person ("you"), like notes from a thoughtful friend. No jargon, \
no markdown, no headings. Never invent quotes or put words in a thinker's mouth; paraphrase. {heard}: spell thinkers \
and traditions correctly, using the passage metadata (entry titles) to correct them. The title is 3 to 7 words about \
their situation."""

PAGE_TASK = """You are writing the page a person will reread after {conversation} with a philosophical guide \
who looked at their situation through several philosophical lenses, grounded in the Stanford Encyclopedia of \
Philosophy.
- situation: 2 to 4 sentences on what they are facing and how they lean, as they framed it.
- lenses: one per lens listed under LENSES that the transcript actually discusses, keeping its lens_id. tradition \
is the corrected name; stance is "aligned" if it resonates with how they lean, "challenges" if it pushes back. take \
is 3 to 5 sentences on what this tradition notices about their situation specifically, not a lecture on the \
tradition. citations are passage_ids from PASSAGES that support the take; use only ids listed there, and leave it \
empty if none fit.
- synthesis: one paragraph drawing the lenses together. Do not decide for them.
- open_questions: 2 to 4 questions worth sitting with."""

PARTIAL = """The call ended before the guide finished every lens. Include only lenses the transcript actually \
discusses, and let the synthesis cover only those."""

NOTES_TASK = """You are writing short situation notes a person will reread after {conversation} with a \
guide. The conversation ended before any philosophical perspectives were explored, so do not bring in philosophy, \
thinkers or traditions.
- situation: what they shared and how they lean, as they framed it, in a short paragraph.
- open_questions: 2 to 3 questions they might keep thinking about."""

CRISIS = """During this call the person showed signs of crisis, and the guide stayed with them in care. Write \
gentle notes that reflect what they shared without judgment. No philosophy, no thinkers, no advice, no diagnosis. \
open_questions may be empty; any you include are gentle and non-probing."""


def _transcript(record: dict) -> str:
    who = {"user": "Person", "guide": "Guide"}
    lines = [f"{who.get(t['role'], t['role'])}: {t['text']}" for t in record.get("turns", [])]
    summary = record.get("summary") or ""
    leaning = record.get("leaning") or ""
    return f"RUNNING SUMMARY: {summary}\nLEANING: {leaning}\n\nTRANSCRIPT:\n" + "\n".join(lines)


def _citation(p: dict) -> dict | None:
    if not is_sep_url(str(p.get("url", ""))):
        return None
    return {
        "passage_id": p["passage_id"],
        "entry_title": p.get("entry_title", ""),
        "section_path": p.get("section_path", ""),
        "url": p["url"],
        "excerpt": p.get("excerpt") or excerpt(p["text"]),
    }


def _wording(record: dict) -> dict[str, str]:
    medium = modality_of(record)
    return {"heard": HEARD[medium], "conversation": CONVERSATION[medium]}


def _notes(variant: str, record: dict, generate: Generate) -> dict:
    wording = _wording(record)
    prompt = "\n\n".join(
        [NOTES_TASK.format(**wording), *([CRISIS] if variant == "crisis" else []), STYLE.format(**wording), _transcript(record)]
    )
    out = NotesOut.model_validate(generate(prompt, NotesOut.model_json_schema()))
    return {"variant": variant, **out.model_dump(), "lenses": [], "synthesis": None, "unexplored": []}


def build_page(record: dict, generate: Generate) -> dict:
    if record["flags"].get("crisis"):
        return _notes("crisis", record, generate)
    acked = record.get("acked_passage_ids", [])
    consulted = set(record.get("consulted_lens_ids", []))
    # The client acks a passage only once it has gone to the model, so an acked or consulted lens is one it saw.
    delivered = [
        l for l in record.get("lens_plan") or [] if l["lens_id"] in consulted or set(acked) & set(l.get("passage_ids", []))
    ]
    if not delivered:
        return _notes("situation_notes", record, generate)

    served = record.get("served_passages", {})
    allowed = {pid: served[pid] for pid in acked if pid in served}
    full = any(p.get("phase") == "synthesize" for p in record.get("phases", []))
    # Mid-explore, the explored lenses are the consulted ones (the persona consults as each lens begins).
    explored = [l for l in delivered if l["lens_id"] in consulted]
    offered = delivered if full or not explored else explored
    offered_ids = {l["lens_id"] for l in offered}

    lenses_text = "\n".join(f"- lens_id={l['lens_id']} tradition={l['tradition']} stance={l['stance']}" for l in offered)
    passages_text = "\n\n".join(
        f"[{pid}] {p.get('entry_title', '')} > {p.get('section_path', '')}\n{p.get('text') or p.get('excerpt', '')}"
        for pid, p in allowed.items()
    )
    wording = _wording(record)
    prompt = "\n\n".join(
        [
            PAGE_TASK.format(**wording),
            *([] if full else [PARTIAL]),
            STYLE.format(**wording),
            f"LENSES:\n{lenses_text}",
            f"PASSAGES:\n{passages_text}",
            _transcript(record),
        ]
    )
    out = PageOut.model_validate(generate(prompt, PageOut.model_json_schema()))

    lenses, written = [], set()
    for lens in out.lenses:
        if lens.lens_id not in offered_ids or lens.lens_id in written:
            continue
        written.add(lens.lens_id)
        cites = [c for pid in dict.fromkeys(lens.citations) if pid in allowed and (c := _citation(allowed[pid]))]
        lenses.append(
            {
                "lens_id": lens.lens_id,
                "tradition": lens.tradition,
                "stance": lens.stance,
                "take": lens.take,
                "citations": cites,
                "own_reading": not cites,
            }
        )
    return {
        "variant": "full" if full else "partial",
        "title": out.title,
        "situation": out.situation,
        "lenses": lenses,
        "synthesis": out.synthesis,
        "open_questions": out.open_questions,
        "unexplored": [{"tradition": l["tradition"], "stance": l["stance"]} for l in delivered if l["lens_id"] not in written],
    }


def run(call_dir: Path, generate: Generate, commit: Callable[[], None], reload: Callable[[], None]) -> str:
    reload()
    record = json.loads((call_dir / "record.json").read_text())
    attempt = record.get("attempts")

    def write(**data) -> None:
        reload()
        if (call_dir / "record.json").exists():  # deleted mid-generation: leave nothing behind
            tmp = call_dir / "synthesis.tmp"
            tmp.write_text(json.dumps({**data, "attempt": attempt}))
            os.replace(tmp, call_dir / "synthesis.json")
            if data.get("status") == "ready" and data.get("page"):
                sync_call_to_memory(call_dir.parent, record, page=data["page"])
            commit()

    write(status="generating")
    t = time.perf_counter()
    try:
        page = build_page(record, generate)
    except Exception as e:
        print(f"synthesis failed call={call_dir.name} error={type(e).__name__} ms={(time.perf_counter() - t) * 1000:.0f}")
        write(status="failed", error=FAILED)
        return "failed"
    write(status="ready", page=page)
    print(f"synthesis ready call={call_dir.name} variant={page['variant']} ms={(time.perf_counter() - t) * 1000:.0f}")
    return "ready"


def gemini_generate(client) -> Generate:
    def generate(prompt: str, schema: dict) -> dict:
        response = client.models.generate_content(
            model=MODEL,
            contents=prompt,
            config={"response_mime_type": "application/json", "response_json_schema": schema},
        )
        return json.loads(response.text)

    return generate
