"""Server-locked Live session config, embedded in every ephemeral token's constraints."""

from pathlib import Path

from backend.guide.tools import TOOLS

MODEL = "gemini-3.8-live-extended-thinking"
API_VERSION = "v1beta"
# Baseline parameters verified in docs/gemini-live-behaviors.md.
VOICE = "Kore"
THINKING_LEVEL = "medium"

SYSTEM_INSTRUCTION = (Path(__file__).parent / "system_instruction.md").read_text()
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


def live_config(resumption_handle: str | None = None, variant: str = DEFAULT_VARIANT) -> dict:
    arm = VARIANTS[variant]
    return {
        "response_modalities": ["AUDIO"],
        "system_instruction": SYSTEM_INSTRUCTION + (BRIEF if arm["brief"] else ""),
        "tools": TOOLS,
        "speech_config": {"voice_config": {"prebuilt_voice_config": {"voice_name": VOICE}}},
        "thinking_config": {"thinking_level": THINKING_LEVEL},
        "input_audio_transcription": {},
        "output_audio_transcription": {},
        "context_window_compression": {"sliding_window": {}},
        "session_resumption": {"handle": resumption_handle} if resumption_handle else {},
        "realtime_input_config": {"automatic_activity_detection": {"silence_duration_ms": arm["silence_ms"]}},
    }
