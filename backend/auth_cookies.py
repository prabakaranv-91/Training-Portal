import json
import logging
import os
import secrets
import threading
import time
import zlib
from contextvars import ContextVar
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from fastapi import Request, Response


logger = logging.getLogger("auth.cookies")
SESSION_LIFETIME = 7 * 24 * 60 * 60
COOKIE_NAMES = {"strava": "strava_session"}
CHUNK_SIZE = 2800
MAX_CHUNKS = 3
MAX_PAYLOAD = 32768
_cipher: Fernet | None = None
_cipher_lock = threading.Lock()
_state: ContextVar[dict[str, Any] | None] = ContextVar("browser_auth", default=None)


def cipher() -> Fernet:
    global _cipher
    with _cipher_lock:
        if _cipher is None:
            key = os.environ.get("AUTH_COOKIE_KEY")
            if not key:
                logger.warning("AUTH_COOKIE_KEY is unset; browser logins will expire on backend restart.")
            _cipher = Fernet(key.encode("ascii") if key else Fernet.generate_key())
        return _cipher


def encode(provider: str, record: dict[str, Any]) -> str:
    plaintext = json.dumps({**record, "provider": provider}, separators=(",", ":")).encode("utf-8")
    if len(plaintext) > MAX_PAYLOAD:
        raise ValueError("Login payload exceeds the browser-cookie size limit.")
    encrypted = cipher().encrypt(zlib.compress(plaintext, 9)).decode("ascii")
    if len(encrypted) > CHUNK_SIZE * MAX_CHUNKS:
        raise ValueError("Login payload exceeds the browser-cookie size limit.")
    return encrypted


def decode(provider: str, cookies: dict[str, str]) -> dict[str, Any] | None:
    name = COOKIE_NAMES[provider]
    try:
        version, count_text, first = cookies.get(name, "").split(".", 2)
        count = int(count_text)
        if version != "v1" or not 1 <= count <= MAX_CHUNKS:
            return None
        chunks = [first] + [cookies[f"{name}_{index}"] for index in range(1, count)]
        if any(len(chunk) > CHUNK_SIZE for chunk in chunks):
            return None
        compressed = cipher().decrypt("".join(chunks).encode("ascii"), ttl=SESSION_LIFETIME)
        inflater = zlib.decompressobj()
        plaintext = inflater.decompress(compressed, MAX_PAYLOAD + 1)
        if len(plaintext) > MAX_PAYLOAD or not inflater.eof or inflater.unused_data:
            return None
        record = json.loads(plaintext)
        if record.get("provider") != provider or not isinstance(record.get("sid"), str):
            return None
        if not isinstance(record.get("expiresAt"), int) or record["expiresAt"] <= time.time():
            return None
        return record
    except (ValueError, KeyError, InvalidToken, zlib.error, UnicodeError, AttributeError, TypeError):
        return None


def bind(request: Request):
    records = {provider: decode(provider, request.cookies) for provider in COOKIE_NAMES}
    return _state.set({"records": records, "changed": set(), "request": request})


def reset(token) -> None:
    _state.reset(token)


def record(provider: str) -> dict[str, Any] | None:
    state = _state.get()
    return state["records"][provider] if state else None


def update(provider: str, account: dict[str, Any] | None, *, sid: str | None = None,
           expires_at: int | None = None, pending: bool = False) -> None:
    state = _state.get()
    if state is None:
        raise RuntimeError("Authentication requires a browser request.")
    previous = state["records"][provider]
    value = None if account is None and not pending else {
        "provider": provider,
        "sid": sid or (previous or {}).get("sid") or secrets.token_urlsafe(32),
        "expiresAt": expires_at or (previous or {}).get("expiresAt") or int(time.time()) + SESSION_LIFETIME,
        "account": account,
        "pending": pending,
    }
    if value != previous or (account is None and not pending):
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
    encoded = {provider: encode(provider, state["records"][provider])
               for provider in state["changed"] if state["records"][provider] is not None}
    total_size = sum(len(encoded.get(provider, "")) or len(encode(provider, value))
                     for provider, value in state["records"].items() if value is not None)
    if total_size > 12000:
        raise ValueError("Combined authentication cookies exceed the supported request-header size.")
    for provider in state["changed"]:
        name = COOKIE_NAMES[provider]
        value = state["records"][provider]
        if value is None:
            for index in range(MAX_CHUNKS):
                response.delete_cookie(name if index == 0 else f"{name}_{index}", secure=secure,
                                       httponly=True, samesite="lax")
            continue
        token = encoded[provider]
        chunks = [token[index:index + CHUNK_SIZE] for index in range(0, len(token), CHUNK_SIZE)]
        lifetime = max(0, value["expiresAt"] - int(time.time()))
        response.set_cookie(name, f"v1.{len(chunks)}.{chunks[0]}", max_age=lifetime,
                            secure=secure, httponly=True, samesite="lax")
        for index in range(1, MAX_CHUNKS):
            if index < len(chunks):
                response.set_cookie(f"{name}_{index}", chunks[index], max_age=lifetime,
                                    secure=secure, httponly=True, samesite="lax")
            else:
                response.delete_cookie(f"{name}_{index}", secure=secure, httponly=True, samesite="lax")