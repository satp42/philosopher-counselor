"""Names must match frontend/src/live/tools.ts."""

from typing import Literal, get_args

NON_BLOCKING = "NON_BLOCKING"

Stance = Literal["aligned", "challenges"]
_STANCE = {"type": "STRING", "enum": list(get_args(Stance))}

FUNCTION_DECLARATIONS = [
    {
        "name": "update_situation",
        "description": (
            "Record your running understanding of the person's situation: a concrete 2-5 sentence summary "
            "(what happened, what's at stake, who is involved) and what they currently lean toward. Call when "
            "the situation becomes clear and whenever important details change."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {"summary": {"type": "STRING"}, "leaning": {"type": "STRING"}},
            "required": ["summary", "leaning"],
        },
    },
    {
        "name": "map_lenses",
        "description": (
            "Find Stanford Encyclopedia of Philosophy grounding for 5-6 candidate traditions that fit the "
            "situation. At least one must have stance 'challenges' (pushes against the person's leaning). "
            "Returns 3-5 grounded lenses with passages, each from a distinct entry."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "lenses": {
                    "type": "ARRAY",
                    "items": {
                        "type": "OBJECT",
                        "properties": {
                            "tradition": {"type": "STRING", "description": "e.g. 'Stoicism', 'Kierkegaard'"},
                            "query": {"type": "STRING", "description": "How this tradition bears on the situation"},
                            "stance": _STANCE,
                        },
                        "required": ["tradition", "query", "stance"],
                    },
                }
            },
            "required": ["lenses"],
        },
    },
    {
        "name": "consult_sep",
        "description": (
            "Quick lookup of Stanford Encyclopedia of Philosophy passages. Use for follow-up questions within "
            "a lens (pass its lens_id) and to add or replace a lens. Not needed to begin a lens: map_lenses "
            "already gave you its passages."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {"query": {"type": "STRING"}, "lens_id": {"type": "STRING"}, "stance": _STANCE},
            "required": ["query"],
        },
    },
    {
        "name": "set_phase",
        "description": "Announce a move to another phase of the conversation.",
        "parameters": {
            "type": "OBJECT",
            "properties": {"phase": {"type": "STRING", "enum": ["listen", "explore", "synthesize", "end"]}},
            "required": ["phase"],
        },
    },
    {
        "name": "signal_crisis",
        "description": "The person may be in crisis (suicide, self-harm, danger). Shows crisis resources on screen.",
    },
]

TOOL_NAMES = [d["name"] for d in FUNCTION_DECLARATIONS]
TOOLS = [{"function_declarations": [{**d, "behavior": NON_BLOCKING} for d in FUNCTION_DECLARATIONS]}]
