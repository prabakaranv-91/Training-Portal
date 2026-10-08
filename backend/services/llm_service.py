import json
from typing import Any

import litellm
from jsonschema import validate

from backend.utils import app_db


def config() -> dict[str, Any]:
    nutrition = app_db.user_setting("nutrition_config", {})
    selected = nutrition.get("llm")
    if selected:
        return selected
    legacy = nutrition.get("gemini") or {}
    if legacy:
        return {"provider": "gemini", "model": legacy.get("model"), "enabled": legacy.get("enabled", True), "daily_limit": legacy.get("daily_limit", 200)}
    return {"provider": "", "model": "", "enabled": False}


def api_key() -> str | None:
    secrets = app_db.user_setting("nutrition_secrets", {})
    return secrets.get("llm_api_key") or (secrets.get("gemini_api_key") if config().get("provider") == "gemini" else None)


def schema_json(schema: Any) -> Any:
    if isinstance(schema, list):
        return [schema_json(value) for value in schema]
    if isinstance(schema, dict):
        return {key: value.lower() if key == "type" and isinstance(value, str) else schema_json(value) for key, value in schema.items()}
    return schema


def generate(prompt: str, schema: dict[str, Any]) -> Any:
    selected = config()
    provider = selected.get("provider") or ""
    model = selected.get("model") or ""
    if not provider or not model:
        raise RuntimeError("Choose an AI provider and model in Settings.")
    key = api_key()
    if not key:
        raise RuntimeError("Save your LLM provider API key in Settings.")
    routed = model if model.startswith(provider + "/") else f"{provider}/{model}"
    wrapped = {"type": "object", "properties": {"result": schema_json(schema)}, "required": ["result"], "additionalProperties": False}
    parameters: dict[str, Any] = {"model": routed, "api_key": key, "messages": [{"role": "system", "content": "Return only valid JSON matching this schema: " + json.dumps(wrapped)}, {"role": "user", "content": prompt}], "timeout": 30, "num_retries": 1}
    try:
        supported = litellm.get_supported_openai_params(model=routed) or []
        if "response_format" in supported:
            parameters["response_format"] = {"type": "json_object"}
        response = litellm.completion(**parameters)
        content = response.choices[0].message.content or ""
        if content.strip().startswith("```"):
            lines = content.strip().splitlines()
            content = "\n".join(lines[1:-1])
        result = json.loads(content)
        validate(result, wrapped)
        return result["result"]
    except Exception:
        raise RuntimeError("The selected LLM could not return a valid result. Check the provider, model, API key and provider quota.") from None