"""
MCP server: understands free-text meal descriptions with Google Gemini (free tier).

Tool `parse_food_text(text)` returns the foods eaten as structured items:
  [{"input", "name", "qty", "unit", "total_grams", "per100g": {...}}]

Run standalone (stdio):   python food_mcp_server.py
The Training Lab backend starts it automatically as a child process.

Config: backend/nutrition_config.json -> "gemini": {"enabled", "model"}
Key:    env GEMINI_API_KEY or backend/nutrition_secrets.json -> "gemini_api_key" (gitignored).
Get a free key at https://aistudio.google.com/apikey
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import requests
from mcp.server.fastmcp import FastMCP

_HERE = Path(__file__).resolve().parent
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
UNITS = ["piece", "cup", "bowl", "plate", "scoop", "slice", "tbsp", "tsp", "glass",
         "serving", "handful", "g", "kg", "ml", "l"]

PROMPT = """You extract the foods and drinks a person ate from a short free-text message.
Messages are often Indian English with typos, slang and Tamil/Hindi food words.

Rules:
- Return one item per distinct food; keep composite dishes together ("paneer sandwich", "chicken biryani", "masala dosa").
- Fix spelling to the common name: "ildli"->"idli", "panner sanwitch"->"paneer sandwich", "briyani"->"biryani", "chapathi"->"chapati".
- "iso whey" / "whey isolate" -> name "whey isolate"; plain whey/protein shake -> "whey protein".
- "cut" means a cup ("1 cut sambar" -> qty 1, unit "cup", name "sambar").
- Milk or sugar that is only part of a drink ("coffee with milk") is NOT a separate item.
- qty defaults to 1; convert words to numbers ("two" -> 2, "half" -> 0.5, "2-3" -> 3).
- unit must be one of: {units}. Use "piece" for countable foods (idli, egg, chapati, banana).
- total_grams: realistic weight in grams of the whole quantity eaten (e.g. 2 idli = 80).
- per100g: realistic nutrition per 100 g of that food as typically prepared in India
  (kcal, protein, carbs, fat, fiber, sugar in grams; sodium in mg).
- Ignore anything that is not food or drink. Return an empty list if there is no food.

Message: \"\"\"{text}\"\"\""""

_NUM = {"type": "NUMBER"}
SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "input": {"type": "STRING", "description": "the words from the message for this item"},
            "name": {"type": "STRING"},
            "qty": _NUM,
            "unit": {"type": "STRING", "enum": UNITS},
            "total_grams": _NUM,
            "per100g": {
                "type": "OBJECT",
                "properties": {k: _NUM for k in ("kcal", "protein", "carbs", "fat", "fiber", "sugar", "sodium")},
                "required": ["kcal", "protein", "carbs", "fat", "fiber", "sugar", "sodium"],
            },
        },
        "required": ["input", "name", "qty", "unit", "total_grams", "per100g"],
    },
}


def _config() -> dict[str, Any]:
    try:
        return json.loads((_HERE / "nutrition_config.json").read_text(encoding="utf-8")).get("gemini") or {}
    except Exception:  # noqa: BLE001
        return {}


def _api_key() -> str | None:
    key = os.environ.get("GEMINI_API_KEY")
    if key:
        return key
    try:
        return json.loads((_HERE / "nutrition_secrets.json").read_text(encoding="utf-8")).get("gemini_api_key")
    except Exception:  # noqa: BLE001
        return None


def gemini_parse(text: str) -> list[dict[str, Any]]:
    key = _api_key()
    if not key:
        raise RuntimeError("Gemini API key not configured (GEMINI_API_KEY or nutrition_secrets.json).")
    model = _config().get("model") or "gemini-2.5-flash"
    gen: dict[str, Any] = {
        "temperature": 0,
        "responseMimeType": "application/json",
        "responseSchema": SCHEMA,
    }
    if "2.5" in model:
        gen["thinkingConfig"] = {"thinkingBudget": 0}  # faster; this task needs no reasoning
    r = requests.post(
        GEMINI_URL.format(model=model),
        headers={"x-goog-api-key": key, "Content-Type": "application/json"},
        json={
            "contents": [{"role": "user", "parts": [{"text": PROMPT.format(units=", ".join(UNITS), text=text)}]}],
            "generationConfig": gen,
        },
        timeout=30,
    )
    if r.status_code != 200:
        raise RuntimeError(f"Gemini HTTP {r.status_code}: {r.text[:300]}")
    parts = (((r.json().get("candidates") or [{}])[0].get("content") or {}).get("parts") or [{}])
    items = json.loads(parts[0].get("text") or "[]")
    out = []
    for it in items if isinstance(items, list) else []:
        name = str(it.get("name") or "").strip()
        if not name:
            continue
        out.append({
            "input": str(it.get("input") or name),
            "name": name.lower(),
            "qty": float(it.get("qty") or 1),
            "unit": it.get("unit") if it.get("unit") in UNITS else "serving",
            "total_grams": float(it["total_grams"]) if it.get("total_grams") else None,
            "per100g": {k: float((it.get("per100g") or {}).get(k) or 0)
                        for k in ("kcal", "protein", "carbs", "fat", "fiber", "sugar", "sodium")},
        })
    return out


mcp = FastMCP("training-lab-food-parser")


@mcp.tool()
def parse_food_text(text: str) -> str:
    """Identify foods eaten in a free-text message (typos, Indian dishes, slang).

    Returns a JSON list of {input, name, qty, unit, total_grams, per100g}.
    """
    return json.dumps(gemini_parse(text))


if __name__ == "__main__":
    mcp.run()
