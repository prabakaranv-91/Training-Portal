import logging
import secrets
import time
from contextvars import ContextVar
from typing import Any

from fastapi import Request, Response
import app_db


logger = logging.getLogger("auth.cookies")
SESSION_LIFETIME = 7 * 24 * 60 * 60
COOKIE_NAMES = {"strava": "strava_session", "setup": "setup_session"}
CHUNK_SIZE = 2800
MAX_CHUNKS = 3
MAX_PAYLOAD = 32768
_state: ContextVar[dict[str, Any] | None] = ContextVar("browser_auth", default=None)


def encode(provider: str, record: dict[str, Any]) -> str:
    sid = record.get("sid")
    if not isinstance(sid, str) or not 1 <= len(sid) <= 128:
        raise ValueError("Invalid session identifier.")
    return f"v2.{sid}"


def decode(provider: str, cookies: dict[str, str]) -> dict[str, Any] | None:
    token = cookies.get(COOKIE_NAMES[provider], "")
    if not token.startswith("v2.") or not 1 <= len(token[3:]) <= 128:
        return None
    return app_db.fetch_setup_session(token[3:]) if provider == "setup" else app_db.fetch_session(provider, token[3:])


def bind(request: Request):
    records = {provider: decode(provider, request.cookies) for provider in COOKIE_NAMES}
    garmin_sid = request.cookies.get("garmin_session")
    garmin = app_db.fetch_session("garmin", garmin_sid) if garmin_sid else None
    saved = garmin or records.get("strava")
    scope = saved["ownerScope"] if saved else None
    return (_state.set({"records": records, "changed": set(), "request": request}), app_db.current_user.set(scope))


def reset(token) -> None:
    _state.reset(token[0])
    app_db.current_user.reset(token[1])


def record(provider: str) -> dict[str, Any] | None:
    state = _state.get()
    return state["records"][provider] if state else None


def update(provider: str, account: dict[str, Any] | None, *, sid: str | None = None,
           expires_at: int | None = None, pending: bool = False) -> None:
    state = _state.get()
    if state is None:
        raise RuntimeError("Authentication requires a browser request.")
    previous = state["records"][provider]
    if provider == "setup":
        if account is None:
            if previous:
                app_db.delete_setup_session(previous["sid"])
            setup_value = None
        else:
            setup_value = app_db.create_setup_session(sid or secrets.token_urlsafe(32), expires_at or int(time.time()) + 86400)
        state["records"][provider] = setup_value
        state["changed"].add(provider)
        return
    value: dict[str, Any] | None = None if account is None and not pending else {
        "provider": provider,
        "sid": sid or (previous or {}).get("sid") or secrets.token_urlsafe(32),
        "expiresAt": expires_at or (previous or {}).get("expiresAt") or int(time.time()) + SESSION_LIFETIME,
        "account": account,
        "pending": pending,
    }
    if value != previous or (account is None and not pending):
        if value is None:
            if previous:
                app_db.delete_session(provider, previous["sid"])
        else:
            if previous and previous["sid"] != value["sid"]:
                app_db.delete_session(provider, previous["sid"])
            user_id = str(((account or {}).get("athlete") or {}).get("id") or app_db.session_key(value["sid"]))
            app_db.save_session(provider, value["sid"], user_id, account or {}, value["expiresAt"])
            value["userId"] = user_id
        state["records"][provider] = value
        state["changed"].add(provider)


def secure_cookie(request: Request) -> bool:
    return request.url.scheme == "https" or request.url.hostname not in ("localhost", "127.0.0.1", "::1")


def finish(response: Response) -> None:
    state = _state.get()
    if state is None:
        return
    request = state["request"]
    secure = secure_cookie(request)
    for provider in state["changed"]:
        name = COOKIE_NAMES[provider]
        value = state["records"][provider]
        if value is None:
            for index in range(MAX_CHUNKS):
                response.delete_cookie(name if index == 0 else f"{name}_{index}", secure=secure,
                                       httponly=True, samesite="lax")
            continue
        lifetime = max(0, value["expiresAt"] - int(time.time()))
        response.set_cookie(name, encode(provider, value), max_age=lifetime,
                            secure=secure, httponly=True, samesite="lax")
        for index in range(1, MAX_CHUNKS):
            response.delete_cookie(f"{name}_{index}", secure=secure, httponly=True, samesite="lax")