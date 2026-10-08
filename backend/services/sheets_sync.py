"""
Mirror nutrition entries/day summaries to a Google Sheet via an Apps Script Web App.

- URL, shared secret and retry state are stored in the application SQLite database.
- Pushes retain the originating user's settings scope on the background thread.
"""

from __future__ import annotations

import json
import logging
import queue
import re
import threading
import time
from typing import Any

import requests
from backend.utils import app_db

logger = logging.getLogger("nutrition.sheets")


_queue: queue.Queue[dict[str, Any]] = queue.Queue()
_pending_lock = threading.Lock()
_worker: threading.Thread | None = None
_status: dict[str, dict[str, Any]] = {}


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
    with _queue.mutex:
        queued = sum(item.get("_scope") == scope for item in _queue.queue)
    return {
        "enabled": bool(cfg.get("enabled")),
        "urlConfigured": bool(cfg.get("web_app_url")),
        "tokenConfigured": bool(_token()),
        "queued": queued,
        "pending": sum(item.get("_scope") == scope for item in _load_pending()),
        **_status.get(scope, {"lastOk": None, "lastError": None}),
    }


def _load_pending() -> list[dict[str, Any]]:
    with _pending_lock:
        return app_db.get_setting("sheets_pending", [])


def _save_pending(items: list[dict[str, Any]]) -> None:
    with _pending_lock:
        app_db.set_setting("sheets_pending", items)


def _post(payload: dict[str, Any]) -> dict[str, Any]:
    # Apps Script answers POST with a 302 to the result; requests follows it as GET.
    # That result page sporadically 404s, so retry (upserts are idempotent).
    last: Exception | None = None
    scope = payload.get("_scope") or app_db.user_scope()
    content = {key: value for key, value in payload.items() if key != "_scope"}
    for attempt in range(3):
        try:
            r = requests.post(
                _config(scope)["web_app_url"],
                json={"token": _token(scope), **content},
                timeout=30,
            )
            r.raise_for_status()
            body = r.json()
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1 + attempt)
            continue
        if not body.get("ok"):
            raise RuntimeError(body.get("error") or "Apps Script returned ok=false")
        return body
    raise RuntimeError(f"Apps Script unreachable: {last}")


def script_info() -> dict[str, Any]:
    """Ask the deployed Apps Script for its version and tab names."""
    try:
        return _post({"action": "info"})
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        if "unknown action" in msg:
            msg = "Deployed Apps Script is an old version (no per-user support) — redeploy a new version."
        return {"ok": False, "error": msg}


def _run() -> None:
    while True:
        payload = _queue.get()
        # Retry anything that failed earlier before the new item.
        backlog = _load_pending()
        if backlog:
            _save_pending([])
        for item in backlog + [payload]:
            state = _status.setdefault(item.get("_scope") or "legacy_private", {"lastOk": None, "lastError": None})
            try:
                _post(item)
                state["lastOk"] = time.strftime("%Y-%m-%d %H:%M:%S")
                state["lastError"] = None
            except Exception as exc:  # noqa: BLE001
                logger.warning("Google Sheets sync failed: %s", exc)
                state["lastError"] = str(exc)
                _save_pending(_load_pending() + [item])


def _enqueue(payload: dict[str, Any]) -> None:
    global _worker
    if not is_configured():
        return
    if _worker is None or not _worker.is_alive():
        _worker = threading.Thread(target=_run, name="sheets-sync", daemon=True)
        _worker.start()
    _queue.put({**payload, "_scope": app_db.user_scope()})


def _sheet_user(user: str) -> str:
    # Sheet tab names can't contain []*?/\: and are limited to 100 chars.
    return re.sub(r"[\[\]*?/\\:]", " ", user).strip()[:60] or "default"


def push_entry(user: str, entry: dict[str, Any]) -> None:
    _enqueue({"action": "upsertEntry", "user": _sheet_user(user), "entry": entry})


def push_day(user: str, date: str, day: dict[str, Any]) -> None:
    _enqueue({"action": "upsertDay", "user": _sheet_user(user), "date": date, "day": day})


def push_review(user: str, date: str, sig: str, review: dict[str, Any]) -> None:
    _enqueue({"action": "upsertReview", "user": _sheet_user(user), "date": date, "sig": sig, "review": review})


def fetch_review(user: str, date: str) -> dict[str, Any] | None:
    """Saved AI review {sig, review} for a day from the sheet, or None (not found / unreachable)."""
    if not is_configured():
        return None
    try:
        body = _post({"action": "getReview", "user": _sheet_user(user), "date": date})
    except Exception as exc:  # noqa: BLE001 - older script versions answer "unknown action"
        logger.info("Sheet review lookup failed: %s", exc)
        return None
    return body.get("found") and {"sig": body.get("sig"), "review": body.get("review")} or None


def push_program(user: str, program: dict[str, Any]) -> None:
    _enqueue({"action": "upsertProgram", "user": _sheet_user(user), "program": program})


def push_weight(user: str, weight: dict[str, Any]) -> None:
    _enqueue({"action": "upsertWeight", "user": _sheet_user(user), "weight": weight})
