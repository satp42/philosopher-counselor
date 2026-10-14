from datetime import datetime, timezone

from backend.guide import config, tools
from backend.live_token import NEW_SESSION_WINDOW, TOKEN_TTL, mint_token


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
    assert constraints["config"]["system_instruction"] == config.SYSTEM_INSTRUCTION
    assert constraints["config"]["tools"] == tools.TOOLS
    assert constraints["config"]["session_resumption"] == {}


def test_resumption_handle_is_carried_in_constraints():
    client = FakeClient()
    mint_token(client, resumption_handle="handle-1")
    assert client.auth_tokens.config["live_connect_constraints"]["config"]["session_resumption"] == {
        "handle": "handle-1"
    }


def test_system_instruction_covers_the_non_negotiables():
    text = config.SYSTEM_INSTRUCTION
    for phrase in ("not a therapist", "signal_crisis", "challenges", "own reading", "lens_id"):
        assert phrase in text
