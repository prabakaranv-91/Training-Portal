import hashlib
import time
from typing import Any
import app_db


def _key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def save_garmin_auth(session_id: str, account: dict[str, Any], expires_at: int) -> None:
    email = str(account.get("email") or "").strip().casefold()
    if not email or not account.get("tokens") or expires_at <= time.time():
        raise ValueError("A valid account email, tokens and session expiry are required.")
    user_id = _key(email)
    saved = {"email": email, "user": account.get("user"), "tokens": account["tokens"]}
    app_db.save_session("garmin", session_id, user_id, saved, expires_at)


def fetch_garmin_auth(session_id: str) -> dict[str, Any] | None:
    saved = app_db.fetch_session("garmin", session_id)
    return {"account": saved["account"], "expiresAt": saved["expiresAt"]} if saved else None


def account_for(email: str) -> dict[str, Any] | None:
    return app_db.fetch_account("garmin", _key(email.strip().casefold()))


def delete_garmin_auth(session_id: str) -> None:
    app_db.delete_session("garmin", session_id)