"""Server-locked guide config. Voice sessions embed it in every ephemeral token. Text sessions send it with each reply."""

import re
from pathlib import Path
from typing import Literal, get_args

from backend.guide.tools import TEXT_TOOLS, TOOLS

MODEL = "gemini-3.8-live-extended-thinking"
# The one non-Live model this repo already calls (synthesis). Pacing against the Live persona is untested.
TEXT_MODEL = "gemini-3.8-flash"
API_VERSION = "v1beta"
# Baseline parameters verified in docs/gemini-live-behaviors.md.
VOICE = "Kore"
THINKING_LEVEL = "medium"

Modality = Literal["voice", "text"]
MODALITIES: tuple[Modality, ...] = get_args(Modality)
_TAG = re.compile(r"^\{(\w+)\} ")
_RAW = (Path(__file__).parent / "system_instruction.md").read_text()
BRIEF = (
    "\n\n# Length\n\nIn the listen phase, keep each reply to one short reflection and at most one question, "
    "about fifteen words. The person does most of the talking."
)

# Bandit arms (backend/bandit.py): VAD silence window × listen-phase length target. One arm per call, fixed at create.
VARIANTS = {
    f"s{ms}{'-brief' if brief else ''}": {"silence_ms": ms, "brief": brief}
    for ms in (900, 1200, 1500)
    for brief in (False, True)
}
DEFAULT_VARIANT = "s900"


def _render(modality: Modality) -> str:
    """Keep untagged lines, and a tagged line only for its own medium, with the tag removed."""
    lines = []
    for line in _RAW.splitlines(keepends=True):
        match = _TAG.match(line)
        if not match:
            lines.append(line)
            continue
        tag = match.group(1)
        if tag not in MODALITIES:
            raise ValueError(f"unknown modality tag {{{tag}}}")
        if tag == modality:
            lines.append(line[match.end() :])
    return "".join(lines)


# Import fails on a tag outside MODALITIES, so a typo never ships a half-rendered persona.
for _modality in MODALITIES:
    _render(_modality)


def system_instruction(modality: Modality, brief: bool = False, memory: str | None = None) -> str:
    """The persona for one medium. The listen-length addendum belongs to voice arms only."""
    text = _render(modality)
    if modality == "voice" and brief:
        text += BRIEF
    if memory:
        text += (
            "\n\n# Memory\n\n"
            "Earlier context from this person's account (use lightly when relevant; let what they share now lead):\n"
            f"{memory}"
        )
    return text


def live_config(
    resumption_handle: str | None = None,
    variant: str = DEFAULT_VARIANT,
    memory: str | None = None,
) -> dict:
    arm = VARIANTS[variant]
    return {
        "response_modalities": ["AUDIO"],
        "system_instruction": system_instruction("voice", arm["brief"], memory=memory),
        "tools": TOOLS,
        "speech_config": {"voice_config": {"prebuilt_voice_config": {"voice_name": VOICE}}},
        "thinking_config": {"thinking_level": THINKING_LEVEL},
        "input_audio_transcription": {},
        "output_audio_transcription": {},
        "context_window_compression": {"sliding_window": {}},
        "session_resumption": {"handle": resumption_handle} if resumption_handle else {},
        "realtime_input_config": {"automatic_activity_detection": {"silence_duration_ms": arm["silence_ms"]}},
    }


def text_config(memory: str | None = None) -> dict:
    """Locked generateContent config for a typed reply: persona, tools, and thinking. No bandit arm."""
    return {
        "system_instruction": system_instruction("text", memory=memory),
        "tools": TEXT_TOOLS,
        "thinking_config": {"thinking_level": THINKING_LEVEL},
        "automatic_function_calling": {"disable": True},
    }
