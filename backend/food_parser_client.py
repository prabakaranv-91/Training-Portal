"""
MCP client for food_mcp_server.py (LiteLLM food parser).

Starts the server as a stdio child process on first use and keeps one session open on a
background event loop, so FastAPI's sync endpoints can call it with a plain function.
Returns None on any problem so callers can fall back to the built-in regex parser.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import sys
import threading
from concurrent.futures import Future
from pathlib import Path
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

import food_mcp_server
import app_db

logger = logging.getLogger("nutrition.mcp")

_SERVER = Path(__file__).resolve().parent / "food_mcp_server.py"
_lock = threading.Lock()
_loop: asyncio.AbstractEventLoop | None = None
_queue: asyncio.Queue | None = None
_cache: dict[str, list[dict[str, Any]]] = {}
_status: dict[str, dict[str, Any]] = {}


def _daily_limit() -> int:
    return int(food_mcp_server._config().get("daily_limit", 200))


def _usage_today() -> int:
    return int(app_db.get_setting("gemini_usage", {}, scope=app_db.user_scope()).get(dt.date.today().isoformat(), 0))


def _count_call() -> None:
    with _lock:
        today = dt.date.today().isoformat()
        scope = app_db.user_scope()
        with app_db.connection() as database:
            database.execute("BEGIN IMMEDIATE")
            row = database.execute("SELECT value FROM settings WHERE scope = ? AND name = 'gemini_usage'", (scope,)).fetchone()
            usage = json.loads(row["value"]) if row else {}
            usage[today] = int(usage.get(today, 0)) + 1
            database.execute("INSERT INTO settings(scope, name, value) VALUES (?, 'gemini_usage', ?) ON CONFLICT(scope, name) DO UPDATE SET value = excluded.value", (scope, json.dumps(usage)))


def is_enabled() -> bool:
    return bool(food_mcp_server._config().get("enabled", True) and food_mcp_server._api_key())


def status() -> dict[str, Any]:
    cfg = food_mcp_server._config()
    return {
        "enabled": bool(cfg.get("enabled", True)),
        "model": cfg.get("model") or "gemini-flash-lite-latest",
        "provider": cfg.get("provider") or "gemini",
        "keyConfigured": bool(food_mcp_server._api_key()),
        "running": _loop is not None,
        "callsToday": _usage_today(),
        "dailyLimit": _daily_limit(),
        **_status.get(app_db.user_scope(), {"lastError": None, "lastOk": None}),
    }


async def _serve(queue: asyncio.Queue) -> None:
    params = StdioServerParameters(command=sys.executable, args=[str(_SERVER)])
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            while True:
                tool, args, fut = await queue.get()
                try:
                    res = await asyncio.wait_for(session.call_tool(tool, args), 45)
                    if res.isError:
                        raise RuntimeError(" ".join(getattr(c, "text", "") for c in res.content) or "tool error")
                    fut.set_result(json.loads(getattr(res.content[0], "text", "null")))
                except Exception as exc:  # noqa: BLE001
                    fut.set_exception(exc)


def _run_loop() -> None:
    global _loop, _queue
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _queue = asyncio.Queue()
    _loop = loop
    try:
        loop.run_until_complete(_serve(_queue))
    except Exception as exc:  # noqa: BLE001
        logger.warning("Food MCP server stopped: %s", exc)
        _status.setdefault("global", {})["lastError"] = f"MCP server stopped: {exc}"
    finally:
        _loop, _queue = None, None
        loop.close()


def _ensure_started() -> None:
    with _lock:
        if _loop is None:
            threading.Thread(target=_run_loop, name="food-mcp", daemon=True).start()
    for _ in range(100):  # wait for the loop thread to come up
        if _loop is not None and _queue is not None:
            return
        threading.Event().wait(0.05)


def _call_tool(tool: str, args: dict[str, Any]) -> Any:
    args = {**args, "db_scope": app_db.user_scope()}
    if _usage_today() >= _daily_limit():
        raise RuntimeError(f"Daily LLM budget of {_daily_limit()} calls used; using built-in logic until tomorrow.")
    _ensure_started()
    if _loop is None or _queue is None:
        raise RuntimeError("MCP client loop did not start")
    _count_call()
    fut: Future = Future()
    loop, queue = _loop, _queue

    def _put() -> None:
        afut = loop.create_future()
        afut.add_done_callback(
            lambda f: fut.set_exception(f.exception()) if f.exception() else fut.set_result(f.result())
        )
        queue.put_nowait((tool, args, afut))

    loop.call_soon_threadsafe(_put)
    return fut.result(timeout=60)


def parse(text: str) -> list[dict[str, Any]] | None:
    """Foods in `text` via the MCP server, or None to fall back to the regex parser."""
    if not is_enabled():
        return None
    key = f"{app_db.user_scope()}\u0000{text.strip().lower()}"
    if key in _cache:
        return _cache[key]
    try:
        items = _call_tool("parse_food_text", {"text": text})
    except Exception as exc:  # noqa: BLE001
        logger.warning("LLM food parsing failed, using built-in parser: %s", exc)
        _status.setdefault(app_db.user_scope(), {})["lastError"] = str(exc)
        return None
    _status.setdefault(app_db.user_scope(), {})["lastOk"] = True
    _status.setdefault(app_db.user_scope(), {})["lastError"] = None
    _cache[key] = items
    return items


def review(day: dict[str, Any]) -> dict[str, Any] | None:
    """LLM review of the whole day (foods to avoid for the program), or None if unavailable."""
    if not is_enabled():
        return None
    try:
        return _call_tool("review_day", {"day_json": json.dumps(day)})
    except Exception as exc:  # noqa: BLE001
        logger.warning("LLM day review failed: %s", exc)
        _status.setdefault(app_db.user_scope(), {})["lastError"] = str(exc)
        return None
