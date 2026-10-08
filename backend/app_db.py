import hashlib
import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Any


DB_PATH = Path(__file__).resolve().parent / "data" / "app.sqlite3"
DEFAULT_DB_PATH = DB_PATH
current_user: ContextVar[str | None] = ContextVar("database_user", default=None)
_schema_lock = threading.Lock()


def _legacy_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ValueError(f"Could not migrate {path.name}; the original file was not changed.") from None


def migrate_legacy(database, root: Path, data_root: Path, environment: dict[str, str]) -> None:
    if database.execute("SELECT 1 FROM settings WHERE scope = 'global' AND name = 'legacy_migrated'").fetchone():
        return
    database.execute("BEGIN IMMEDIATE")
    if database.execute("SELECT 1 FROM settings WHERE scope = 'global' AND name = 'legacy_migrated'").fetchone():
        return
    values = {
        "app_config": {"port": environment.get("PORT", "8000"), "allowed_origins": [origin.strip() for origin in environment.get("AUTH_ALLOWED_ORIGINS", "http://127.0.0.1:8000,http://localhost:8000").split(",") if origin.strip()]},
        "strava_config": _legacy_json(root / "strava_config.json", {}),
        "nutrition_config": _legacy_json(root / "nutrition_config.json", {}),
        "nutrition_secrets": _legacy_json(root / "nutrition_secrets.json", {}),
        "sheets_pending": _legacy_json(data_root / "sheets_pending.json", []),
        "gemini_usage": _legacy_json(data_root / "gemini_usage.json", {}),
        "food_lookup_cache": _legacy_json(data_root / "food_lookup_cache.json", {}),
    }
    for variable, key in (("STRAVA_CLIENT_ID", "client_id"), ("STRAVA_CLIENT_SECRET", "client_secret"), ("STRAVA_YEARLY_GOAL_KM", "yearly_goal_km")):
        if environment.get(variable):
            values["strava_config"][key] = environment[variable]
    for variable, key in (("GEMINI_API_KEY", "gemini_api_key"), ("NUTRITION_SHEETS_TOKEN", "sheets_token"), ("USDA_FDC_API_KEY", "usda_api_key")):
        if environment.get(variable):
            values["nutrition_secrets"][key] = environment[variable]
    for variable, key in (("NUTRITION_BODY_WEIGHT_KG", "default_weight_kg"), ("NUTRITION_BMR_KCAL", "default_bmr_kcal")):
        if environment.get(variable):
            values["nutrition_config"][key] = float(environment[variable])
    for name, value in values.items():
        database.execute("INSERT OR IGNORE INTO settings(scope, name, value) VALUES ('global', ?, ?)", (name, json.dumps(value)))
    auth_path = Path(environment.get("GARMIN_AUTH_FILE") or data_root / "garmin_auth.json")
    auth = _legacy_json(auth_path, {"users": {}, "sessions": {}})
    for user_id, account in auth.get("users", {}).items():
        saved = {key: account.get(key) for key in ("email", "user", "tokens")}
        database.execute("INSERT OR IGNORE INTO accounts(provider, user_id, account) VALUES ('garmin', ?, ?)", (user_id, json.dumps(saved)))
    for key, session in auth.get("sessions", {}).items():
        if session.get("expiresAt", 0) > time.time() and session.get("userId") in auth.get("users", {}):
            database.execute("INSERT OR IGNORE INTO sessions(provider, session_hash, user_id, expires_at) VALUES ('garmin', ?, ?, ?)", (key, session["userId"], session["expiresAt"]))
    for path in data_root.glob("nutrition_log*.json"):
        scope = "legacy_user:" + path.stem.removeprefix("nutrition_log_") if path.stem != "nutrition_log" else "legacy_user:default"
        database.execute("INSERT OR IGNORE INTO settings(scope, name, value) VALUES (?, 'nutrition_log', ?)", (scope, json.dumps(_legacy_json(path, {}))))
    legacy_strava = _legacy_json(Path.home() / ".strava_portal_tokens.json", {}) if root == DEFAULT_DB_PATH.parent.parent else {}
    if legacy_strava.get("refresh_token"):
        user_id = str((legacy_strava.get("athlete") or {}).get("id") or "legacy")
        database.execute("INSERT OR IGNORE INTO accounts(provider, user_id, account) VALUES ('strava', ?, ?)", (user_id, json.dumps(legacy_strava)))
    database.execute("INSERT INTO settings(scope, name, value) VALUES ('global', 'legacy_migrated', 'true')")


def session_key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


@contextmanager
def connection():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    database = sqlite3.connect(DB_PATH, timeout=30)
    database.row_factory = sqlite3.Row
    try:
        os.chmod(DB_PATH, 0o600)
        database.execute("PRAGMA foreign_keys = ON")
        with _schema_lock:
            if database.execute("PRAGMA journal_mode").fetchone()[0] != "wal":
                database.execute("PRAGMA journal_mode = WAL")
        database.executescript("""
            CREATE TABLE IF NOT EXISTS settings (
                scope TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
                PRIMARY KEY (scope, name)
            );
            CREATE TABLE IF NOT EXISTS accounts (
                provider TEXT NOT NULL, user_id TEXT NOT NULL, account TEXT NOT NULL,
                PRIMARY KEY (provider, user_id)
            );
            CREATE TABLE IF NOT EXISTS sessions (
                provider TEXT NOT NULL, session_hash TEXT NOT NULL,
                user_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
                PRIMARY KEY (provider, session_hash),
                FOREIGN KEY (provider, user_id) REFERENCES accounts(provider, user_id)
            );
        """)
        if DB_PATH == DEFAULT_DB_PATH and not database.execute("SELECT 1 FROM settings WHERE scope = 'global' AND name = 'legacy_migrated'").fetchone():
            with database:
                migrate_legacy(database, Path(__file__).resolve().parent, Path(os.environ.get("NUTRITION_DATA_DIR") or Path.home() / ".training_lab"), dict(os.environ))
        with database:
            yield database
    finally:
        database.close()


def get_setting(name: str, default: Any = None, scope: str = "global") -> Any:
    with connection() as database:
        row = database.execute("SELECT value FROM settings WHERE scope = ? AND name = ?", (scope, name)).fetchone()
    return json.loads(row["value"]) if row else default


def set_setting(name: str, value: Any, scope: str = "global") -> None:
    with connection() as database:
        database.execute("INSERT INTO settings(scope, name, value) VALUES (?, ?, ?) ON CONFLICT(scope, name) DO UPDATE SET value = excluded.value", (scope, name, json.dumps(value)))


def save_session(provider: str, session_id: str, user_id: str, account: dict[str, Any], expires_at: int) -> None:
    if expires_at <= time.time():
        raise ValueError("Session expiry must be in the future.")
    with connection() as database:
        database.execute("INSERT INTO accounts(provider, user_id, account) VALUES (?, ?, ?) ON CONFLICT(provider, user_id) DO UPDATE SET account = excluded.account", (provider, user_id, json.dumps(account)))
        database.execute("DELETE FROM sessions WHERE expires_at <= ?", (time.time(),))
        database.execute("INSERT INTO sessions(provider, session_hash, user_id, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(provider, session_hash) DO UPDATE SET user_id = excluded.user_id, expires_at = excluded.expires_at", (provider, session_key(session_id), user_id, expires_at))


def fetch_session(provider: str, session_id: str) -> dict[str, Any] | None:
    with connection() as database:
        row = database.execute("SELECT accounts.account, sessions.expires_at, sessions.user_id FROM sessions JOIN accounts USING(provider, user_id) WHERE provider = ? AND session_hash = ? AND expires_at > ?", (provider, session_key(session_id), time.time())).fetchone()
    return {"account": json.loads(row["account"]), "expiresAt": row["expires_at"], "sid": session_id, "provider": provider, "userId": row["user_id"]} if row else None


def fetch_account(provider: str, user_id: str) -> dict[str, Any] | None:
    with connection() as database:
        row = database.execute("SELECT account FROM accounts WHERE provider = ? AND user_id = ?", (provider, user_id)).fetchone()
    return json.loads(row["account"]) if row else None


def delete_session(provider: str, session_id: str) -> None:
    with connection() as database:
        database.execute("DELETE FROM sessions WHERE provider = ? AND session_hash = ?", (provider, session_key(session_id)))


def user_scope() -> str:
    return current_user.get() or "global"


def merge_settings(base: dict, updates: dict) -> dict:
    result = dict(base)
    for key, value in updates.items():
        result[key] = merge_settings(result[key], value) if isinstance(result.get(key), dict) and isinstance(value, dict) else value
    return result


def user_setting(name: str, default: Any = None, scope: str | None = None) -> Any:
    scope = scope or user_scope()
    base = get_setting(name, default)
    if scope == "global":
        return base
    value = get_setting(name, scope=scope)
    if value is None:
        return base
    return merge_settings(base, value) if isinstance(base, dict) and isinstance(value, dict) else value


def adopt_legacy(name: str, legacy_scope: str, scope: str, default: Any) -> Any:
    with connection() as database:
        database.execute("BEGIN IMMEDIATE")
        existing = database.execute("SELECT value FROM settings WHERE scope = ? AND name = ?", (scope, name)).fetchone()
        if existing:
            return json.loads(existing["value"])
        legacy = database.execute("SELECT value FROM settings WHERE scope = ? AND name = ?", (legacy_scope, name)).fetchone()
        if not legacy:
            return default
        database.execute("INSERT INTO settings(scope, name, value) VALUES (?, ?, ?)", (scope, name, legacy["value"]))
        database.execute("DELETE FROM settings WHERE scope = ? AND name = ?", (legacy_scope, name))
        return json.loads(legacy["value"])