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
- Translate regional words to the common English/Indian name: "mor"/"moru"/"chaas"->"buttermilk", "thayir"/"dahi"->"curd",
  "muttai"/"anda"->"egg", "sadam"/"chawal"->"rice", "paruppu"->"dal", "kozhi"->"chicken". Number words like "oru"/"ek" mean 1.
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


def _generate(prompt: str, schema: dict[str, Any]) -> Any:
    """Run a JSON-schema prompt on the configured model, falling back through the model list."""
    key = _api_key()
    if not key:
        raise RuntimeError("Gemini API key not configured (GEMINI_API_KEY or nutrition_secrets.json).")
    cfg = _config()
    models = [cfg.get("model") or "gemini-flash-lite-latest", *cfg.get("fallback_models", [])]
    last = ""
    for model in models:
        try:
            return _call(model, key, prompt, schema)
        except _Retryable as exc:  # overloaded / quota / retired model -> try the next one
            last = str(exc)
    raise RuntimeError(last or "No Gemini model available")


class _Retryable(RuntimeError):
    pass


def _call(model: str, key: str, prompt: str, schema: dict[str, Any]) -> Any:
    gen: dict[str, Any] = {
        "temperature": 0,
        "responseMimeType": "application/json",
        "responseSchema": schema,
    }
    if "2.5" in model:
        gen["thinkingConfig"] = {"thinkingBudget": 0}  # faster; this task needs no reasoning
    r = requests.post(
        GEMINI_URL.format(model=model),
        headers={"x-goog-api-key": key, "Content-Type": "application/json"},
        json={"contents": [{"role": "user", "parts": [{"text": prompt}]}], "generationConfig": gen},
        timeout=30,
    )
    if r.status_code in (404, 429, 500, 503):
        raise _Retryable(f"{model}: HTTP {r.status_code}: {r.text[:200]}")
    if r.status_code != 200:
        raise RuntimeError(f"Gemini HTTP {r.status_code}: {r.text[:300]}")
    parts = (((r.json().get("candidates") or [{}])[0].get("content") or {}).get("parts") or [{}])
    return json.loads(parts[0].get("text") or "null")


def gemini_parse(text: str) -> list[dict[str, Any]]:
    items = _generate(PROMPT.format(units=", ".join(UNITS), text=text), SCHEMA)
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


REVIEW_PROMPT = """You are a sports nutrition coach for an Indian amateur runner. Review their whole day of eating
against their goal and suggest what to avoid. Be specific to the foods they actually ate.

Goal program: {program}
Calorie target today: {target} kcal (burned {burn} kcal incl. {workout} kcal of workouts)
Eaten so far: {intake}
Targets: {targets}
Foods eaten today (name, amount, kcal, protein g, fat g, sugar g, sodium mg):
{foods}
Day in progress: {in_progress}

Rules:
- verdict: "on_track", "over" or "under" for the calorie target.
- summary: ONE short sentence (max 14 words), plain language.
- avoid: up to 3 foods FROM THE LIST that most hurt the goal (e.g. sugary, fried, high-fat, low-protein calories).
  For each: item (exact name from the list), reason (max 6 words), instead (a concrete Indian swap, max 6 words).
  If nothing needs avoiding, return an empty list.
- keep: up to 2 foods from the list that help the goal (e.g. high protein, fibre).
- add: 2-3 everyday Indian foods to eat NEXT (rest of today, or tomorrow) that close the biggest gaps for the goal
  (e.g. protein, fibre, or calories if under). Realistic, commonly available items with a portion:
  food (e.g. "Sprouts sundal", "Paneer bhurji", "Curd with fruit"), portion (e.g. "1 cup", "2 pieces"), why (max 6 words).
- next: one short tip for the rest of today or tomorrow (max 14 words).
"""

REVIEW_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "verdict": {"type": "STRING", "enum": ["on_track", "over", "under"]},
        "summary": {"type": "STRING"},
        "avoid": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {"item": {"type": "STRING"}, "reason": {"type": "STRING"}, "instead": {"type": "STRING"}},
                "required": ["item", "reason", "instead"],
            },
        },
        "keep": {"type": "ARRAY", "items": {"type": "STRING"}},
        "add": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {"food": {"type": "STRING"}, "portion": {"type": "STRING"}, "why": {"type": "STRING"}},
                "required": ["food", "portion", "why"],
            },
        },
        "next": {"type": "STRING"},
    },
    "required": ["verdict", "summary", "avoid", "keep", "add", "next"],
}


def gemini_review(day: dict[str, Any]) -> dict[str, Any]:
    foods = "\n".join(
        f"- {f['name']}: {f['qty']} {f['unit']}, {round(f['kcal'])} kcal, P {f['protein']}, F {f['fat']}, "
        f"sugar {f['sugar']}, sodium {round(f['sodium'])}"
        for f in day["foods"]
    )
    t = day["targets"]
    prompt = REVIEW_PROMPT.format(
        program=day["program"], target=t["kcal"], burn=day["burn"], workout=day.get("workoutKcal", 0),
        intake=", ".join(f"{k} {round(v)}" for k, v in day["intake"].items()),
        targets=", ".join(f"{k} {v}" for k, v in t.items()), foods=foods or "(none)",
        in_progress="yes" if day.get("inProgress") else "no",
    )
    res = _generate(prompt, REVIEW_SCHEMA) or {}
    return {
        "verdict": res.get("verdict") or "on_track",
        "summary": str(res.get("summary") or "")[:160],
        "avoid": [{k: str(a.get(k) or "")[:60] for k in ("item", "reason", "instead")} for a in (res.get("avoid") or [])][:3],
        "keep": [str(k)[:40] for k in (res.get("keep") or [])][:2],
        "add": [{k: str(a.get(k) or "")[:50] for k in ("food", "portion", "why")} for a in (res.get("add") or [])][:3],
        "next": str(res.get("next") or "")[:160],
    }


mcp = FastMCP("training-lab-food-parser")


@mcp.tool()
def parse_food_text(text: str) -> str:
    """Identify foods eaten in a free-text message (typos, Indian dishes, slang).

    Returns a JSON list of {input, name, qty, unit, total_grams, per100g}.
    """
    return json.dumps(gemini_parse(text))


@mcp.tool()
def review_day(day_json: str) -> str:
    """Review a full day of eating against the user's program and say which foods to avoid.

    day_json: {program, targets, intake, burn, workoutKcal, inProgress, foods:[{name,qty,unit,kcal,protein,fat,sugar,sodium}]}
    Returns JSON {verdict, summary, avoid:[{item,reason,instead}], keep:[...], add:[{food,portion,why}], next}.
    """
    return json.dumps(gemini_review(json.loads(day_json)))


if __name__ == "__main__":
    mcp.run()
