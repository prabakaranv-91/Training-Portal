"""Store nutrition exclusively in the configured Google Sheet via Apps Script."""

from __future__ import annotations

import logging
import re
import time
from typing import Any

import requests
from backend.utils import app_db

logger = logging.getLogger("nutrition.sheets")


_status: dict[str, dict[str, Any]] = {}


class SheetsStorageError(RuntimeError):
    pass


def _config(scope: str | None = None) -> dict[str, Any]:
    return app_db.user_setting("nutrition_config", {}, scope=scope).get("google_sheets") or {}


def _token(scope: str | None = None) -> str | None:
    return app_db.user_setting("nutrition_secrets", {}, scope=scope).get("sheets_token")


def is_configured() -> bool:
    cfg = _config()
    return bool(cfg.get("enabled") and cfg.get("web_app_url") and _token())


def status() -> dict[str, Any]:
    cfg = _config()
    scope = app_db.user_scope()
    return {
        "enabled": bool(cfg.get("enabled")),
        "urlConfigured": bool(cfg.get("web_app_url")),
        "tokenConfigured": bool(_token()),
        "queued": 0,
        "pending": 0,
        **_status.get(scope, {"lastOk": None, "lastError": None}),
    }


def _post(payload: dict[str, Any]) -> dict[str, Any]:
    # Apps Script answers POST with a 302 to the result; requests follows it as GET.
    # That result page sporadically 404s, so retry (upserts are idempotent).
    last: Exception | None = None
    scope = payload.get("_scope") or app_db.user_scope()
    cfg = _config(scope)
    token = _token(scope)
    if (not cfg.get("enabled") and payload.get("action") != "info") or not cfg.get("web_app_url") or not token:
        raise SheetsStorageError("Configure and verify Google Sheets before using nutrition.")
    content = {key: value for key, value in payload.items() if key != "_scope"}
    for attempt in range(3):
        try:
            r = requests.post(
                cfg["web_app_url"],
                json={"token": token, **content},
                timeout=30,
            )
            r.raise_for_status()
            body = r.json()
        except Exception as exc:  # noqa: BLE001
            last = exc
            continue
        if not body.get("ok"):
            if body.get("error") == "unknown action":
                raise SheetsStorageError("Update your Google Sheets Apps Script deployment to version 8 in Settings. Nutrition requires the sheet read API.")
            raise SheetsStorageError("Google Sheets rejected the request. Check the configured deployment and sheet token.")
        return body
    raise SheetsStorageError("Google Sheets is unavailable. No nutrition data was read from or saved to local storage.") from last


def script_info() -> dict[str, Any]:
    """Ask the deployed Apps Script for its version and tab names."""
    try:
        return _post({"action": "info"})
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        if "unknown action" in msg:
            msg = "Deployed Apps Script is an old version (no per-user support) — redeploy a new version."
        return {"ok": False, "error": msg}


def _write(payload: dict[str, Any]) -> None:
    state = _status.setdefault(app_db.user_scope(), {"lastOk": None, "lastError": None})
    try:
        _post(payload)
    except SheetsStorageError as exc:
        state["lastError"] = str(exc)
        raise
    state["lastOk"] = time.strftime("%Y-%m-%d %H:%M:%S")
    state["lastError"] = None


def fetch_log(user: str) -> dict[str, Any]:
    body = _post({"action": "getNutrition", "user": _sheet_user(user)})
    data = body.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("entries"), list) or not isinstance(data.get("days"), dict):
        raise SheetsStorageError("Google Sheets returned invalid nutrition data. Update the Apps Script deployment to version 8.")
    return data


def _sheet_user(user: str) -> str:
    # Sheet tab names can't contain []*?/\: and are limited to 100 chars.
    return re.sub(r"[\[\]*?/\\:]", " ", user).strip()[:60] or "default"


def push_entry(user: str, entry: dict[str, Any]) -> None:
    _write({"action": "upsertEntry", "user": _sheet_user(user), "entry": entry})


def push_day(user: str, date: str, day: dict[str, Any]) -> None:
    _write({"action": "upsertDay", "user": _sheet_user(user), "date": date, "day": day})


def push_review(user: str, date: str, sig: str, review: dict[str, Any]) -> None:
    _write({"action": "upsertReview", "user": _sheet_user(user), "date": date, "sig": sig, "review": review})


def fetch_review(user: str, date: str) -> dict[str, Any] | None:
    """Saved AI review {sig, review} for a day from the sheet, or None (not found / unreachable)."""
    body = _post({"action": "getReview", "user": _sheet_user(user), "date": date})
    return body.get("found") and {"sig": body.get("sig"), "review": body.get("review")} or None


def push_program(user: str, program: dict[str, Any]) -> None:
    _write({"action": "upsertProgram", "user": _sheet_user(user), "program": program})


def push_weight(user: str, weight: dict[str, Any]) -> None:
    _write({"action": "upsertWeight", "user": _sheet_user(user), "weight": weight})
