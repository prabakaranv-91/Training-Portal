import hashlib
import json
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any


STORE_PATH = Path(os.environ.get("GARMIN_AUTH_FILE") or Path.home() / ".training_lab" / "garmin_auth.json")
_LOCK = threading.RLock()


def _read() -> dict[str, Any]:
    if not STORE_PATH.exists():
        return {"version": 1, "users": {}, "sessions": {}}
    data = json.loads(STORE_PATH.read_text(encoding="utf-8"))
    if data.get("version") != 1 or not isinstance(data.get("users"), dict) or not isinstance(data.get("sessions"), dict):
        raise ValueError("Invalid local Garmin authentication configuration.")
    return data


def _write(data: dict[str, Any]) -> None:
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=STORE_PATH.parent,
                                         prefix="garmin_auth_", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            os.chmod(temporary, 0o600)
            json.dump(data, handle, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(STORE_PATH)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def _key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def save_garmin_auth(session_id: str, account: dict[str, Any], expires_at: int) -> None:
    email = str(account.get("email") or "").strip().casefold()
    if not email or not account.get("tokens") or expires_at <= time.time():
        raise ValueError("A valid account email, tokens and session expiry are required.")
    user_id = _key(email)
    saved = {"email": email, "user": account.get("user"), "tokens": account["tokens"]}
    with _LOCK:
        data = _read()
        data["users"][user_id] = saved
        data["sessions"] = {key: value for key, value in data["sessions"].items()
                            if value.get("expiresAt", 0) > time.time()}
        data["sessions"][_key(session_id)] = {"userId": user_id, "expiresAt": expires_at}
        _write(data)


def fetch_garmin_auth(session_id: str) -> dict[str, Any] | None:
    with _LOCK:
        data = _read()
        session = data["sessions"].get(_key(session_id))
        if not session or session.get("expiresAt", 0) <= time.time():
            return None
        account = data["users"].get(session["userId"])
        return {"account": account, "expiresAt": session["expiresAt"]} if account else None


def account_for(email: str) -> dict[str, Any] | None:
    with _LOCK:
        return _read()["users"].get(_key(email.strip().casefold()))


def delete_garmin_auth(session_id: str) -> None:
    with _LOCK:
        data = _read()
        if data["sessions"].pop(_key(session_id), None) is not None:
            _write(data)