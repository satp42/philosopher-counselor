"""Repo invariants for /correct — each test names a mistake class agents repeated."""

import re
from pathlib import Path

from backend.guide import tools

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
TOOLS_TS = ROOT / "frontend" / "src" / "live" / "tools.ts"

# Matches detail=f"...{e}..." or detail=str(e) on HTTPException / raise lines.
_LEAK_DETAIL = re.compile(
    r"""detail\s*=\s*(?:str\s*\(|f["'][^"']*\{[^}]*\b(?:e|exc|err|error)\b)""",
    re.IGNORECASE,
)


def _backend_py_files() -> list[Path]:
    skip = {"tests", "__pycache__"}
    paths: list[Path] = []
    for path in BACKEND.rglob("*.py"):
        if any(part in skip for part in path.parts):
            continue
        paths.append(path)
    return paths


def test_stale_after_covers_every_modality():
    from backend.calls import STALE_AFTER
    from backend.guide.config import MODALITIES

    assert set(STALE_AFTER) == set(MODALITIES)


def test_http_exception_details_do_not_echo_exceptions():
    """502/401 bodies must stay generic; past leaks put API keys and user text in responses."""
    offenders: list[str] = []
    for path in _backend_py_files():
        text = path.read_text()
        for match in _LEAK_DETAIL.finditer(text):
            offenders.append(f"{path.relative_to(ROOT)}:{text[: match.start()].count(chr(10)) + 1}: {match.group()}")
    assert not offenders, "use a fixed detail string and log the exception separately:\n" + "\n".join(offenders)


def test_frontend_tool_handlers_match_python_tool_names():
    """Tool names are duplicated in tools.py and tools.ts — drift breaks Live tool dispatch."""
    ts = TOOLS_TS.read_text()
    block = re.search(r"const handlers:[^{]+\{([\s\S]*?)\n  \};\n\n  return \{", ts)
    assert block, "could not parse handler map in tools.ts"
    ts_names = set(re.findall(r"^\s{4}(?:async\s+)?(\w+)\(", block.group(1), re.MULTILINE))
    assert ts_names == set(tools.TOOL_NAMES), f"python={tools.TOOL_NAMES} typescript={sorted(ts_names)}"


def test_non_blocking_is_live_only():
    for decl in tools.TEXT_TOOLS[0]["function_declarations"]:
        assert "behavior" not in decl, decl["name"]
