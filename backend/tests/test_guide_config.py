from datetime import datetime, timezone
from pathlib import Path
from typing import get_args

from backend.guide import config, tools
from backend.live_token import NEW_SESSION_WINDOW, TOKEN_TTL, mint_token

VOICE_PERSONA = (Path(__file__).parent / "fixtures" / "voice_system_instruction.txt").read_text()


class FakeTokens:
    def __init__(self):
        self.config = None

    def create(self, config):
        self.config = config
        return type("Token", (), {"name": "auth_tokens/abc123"})()


class FakeClient:
    def __init__(self):
        self.auth_tokens = FakeTokens()


def test_every_tool_is_non_blocking_without_scheduling():
    for decl in tools.TOOLS[0]["function_declarations"]:
        assert decl["behavior"] == "NON_BLOCKING", decl["name"]
        assert "scheduling" not in decl


def test_tool_names_are_the_contract():
    assert tools.TOOL_NAMES == ["update_situation", "map_lenses", "consult_sep", "set_phase", "signal_crisis"]
    assert list(get_args(tools.ToolName)) == tools.TOOL_NAMES
    assert "behavior" not in tools.TEXT_TOOLS[0]["function_declarations"][0]


def test_no_search_code_or_url_tools_declared():
    cfg = config.live_config()
    assert all(set(t) == {"function_declarations"} for t in cfg["tools"])


def test_token_locks_model_persona_and_tools():
    client = FakeClient()
    now = datetime(2026, 10, 13, tzinfo=timezone.utc)
    assert mint_token(client, now=now) == "auth_tokens/abc123"
    sent = client.auth_tokens.config
    assert sent["uses"] == 1
    assert sent["expire_time"] == now + TOKEN_TTL
    assert sent["new_session_expire_time"] == now + NEW_SESSION_WINDOW
    constraints = sent["live_connect_constraints"]
    assert constraints["model"] == "gemini-3.8-live-extended-thinking"
    assert constraints["config"]["system_instruction"] == config.system_instruction("voice")
    assert constraints["config"]["tools"] == tools.TOOLS
    assert constraints["config"]["session_resumption"] == {}


def test_resumption_handle_is_carried_in_constraints():
    client = FakeClient()
    mint_token(client, resumption_handle="handle-1")
    assert client.auth_tokens.config["live_connect_constraints"]["config"]["session_resumption"] == {
        "handle": "handle-1"
    }


def test_system_instruction_covers_the_non_negotiables():
    for modality in ("voice", "text"):
        text = config.system_instruction(modality)
        for phrase in ("not a therapist", "signal_crisis", "challenges", "own reading", "lens_id"):
            assert phrase in text
        assert "{voice}" not in text and "{text}" not in text


def test_voice_instruction_is_byte_identical_to_the_historical_persona():
    assert config.system_instruction("voice") == VOICE_PERSONA


def test_text_instruction_changes_only_the_medium():
    voice = config.system_instruction("voice").splitlines()
    text = config.system_instruction("text").splitlines()
    assert len(voice) == len(text)
    changed = [pair for pair in zip(voice, text, strict=True) if pair[0] != pair[1]]
    assert len(changed) == 5
    assert "spoken audio" in changed[1][0] and "text conversation" in changed[1][1]
    assert "BRIEF" not in config.system_instruction("text")
    assert "fifteen words" in config.system_instruction("voice", brief=True)
