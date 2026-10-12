"""User-scoped SQLite storage for nutrition records."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from backend.utils import app_db

NUTRIENTS = ("kcal", "protein", "carbs", "fat", "fiber", "sugar", "sodium")
ITEM_FIELDS = (
    "input", "readAs", "name", "qty", "unit", "grams", "source", "found", "revoked", *NUTRIENTS,
)
DAY_FIELDS = ("intake", "targets", "burn", "status", "weightKg", "program")
PROGRAM_FIELDS = ("from", "program", "label", "setAt")
WEIGHT_FIELDS = ("date", "kg", "setAt", "source")
REVIEW_FIELDS = ("sig", "review", "at")


def _dump(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _project(value: dict[str, Any], fields: tuple[str, ...]) -> dict[str, Any]:
    return {key: value[key] for key in fields if key in value}


def _save_entry(database: sqlite3.Connection, owner_scope: str, entry: dict[str, Any]) -> None:
    entry_id = str(entry["id"])
    database.execute(
        "INSERT INTO nutrition_entries(owner_scope, entry_id, entry_date, entry_time, text, revoked) "
        "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_scope, entry_id) DO UPDATE SET "
        "entry_date=excluded.entry_date, entry_time=excluded.entry_time, text=excluded.text, revoked=excluded.revoked",
        (owner_scope, entry_id, entry["date"], entry.get("time") or "", entry.get("text") or "", int(bool(entry.get("revoked")))),
    )
    database.execute("DELETE FROM nutrition_items WHERE owner_scope = ? AND entry_id = ?", (owner_scope, entry_id))
    database.executemany(
        "INSERT INTO nutrition_items(owner_scope, entry_id, item_index, item_json) VALUES (?, ?, ?, ?)",
        [(owner_scope, entry_id, index, _dump({key: item[key] for key in ITEM_FIELDS if key in item}))
         for index, item in enumerate(entry.get("items") or [])],
    )


def load_user(owner_scope: str) -> dict[str, Any]:
    with app_db.connection() as database:
        entries = database.execute(
            "SELECT entry_id, entry_date, entry_time, text, revoked FROM nutrition_entries "
            "WHERE owner_scope = ? ORDER BY entry_date, entry_time, entry_id", (owner_scope,),
        ).fetchall()
        item_rows = database.execute(
            "SELECT entry_id, item_json FROM nutrition_items WHERE owner_scope = ? ORDER BY entry_id, item_index",
            (owner_scope,),
        ).fetchall()
        days = database.execute("SELECT day_date, day_json FROM nutrition_days WHERE owner_scope = ?", (owner_scope,)).fetchall()
        programs = database.execute("SELECT program_json FROM nutrition_programs WHERE owner_scope = ? ORDER BY start_date", (owner_scope,)).fetchall()
        weights = database.execute("SELECT weight_json FROM nutrition_weights WHERE owner_scope = ? ORDER BY weight_date", (owner_scope,)).fetchall()
        reviews = database.execute("SELECT review_date, review_json FROM nutrition_reviews WHERE owner_scope = ?", (owner_scope,)).fetchall()

    items_by_entry: dict[str, list[dict[str, Any]]] = {}
    for row in item_rows:
        items_by_entry.setdefault(row["entry_id"], []).append(json.loads(row["item_json"]))
    loaded_entries = [{
        "id": row["entry_id"], "date": row["entry_date"], "time": row["entry_time"], "text": row["text"],
        "revoked": bool(row["revoked"]), "items": items_by_entry.get(row["entry_id"], []),
    } for row in entries]
    return {
        "entries": loaded_entries,
        "days": {row["day_date"]: json.loads(row["day_json"]) for row in days},
        "programs": [json.loads(row["program_json"]) for row in programs],
        "weights": [json.loads(row["weight_json"]) for row in weights],
        "coach": {row["review_date"]: json.loads(row["review_json"]) for row in reviews},
    }


def save_entry(owner_scope: str, entry: dict[str, Any]) -> None:
    with app_db.connection() as database:
        _save_entry(database, owner_scope, entry)


def _upsert(owner_scope: str, table: str, key_column: str, data_column: str, key: str,
            value: dict[str, Any]) -> None:
    with app_db.connection() as database:
        database.execute(
            f"INSERT INTO {table}(owner_scope, {key_column}, {data_column}) VALUES (?, ?, ?) "
            f"ON CONFLICT(owner_scope, {key_column}) DO UPDATE SET {data_column}=excluded.{data_column}",
            (owner_scope, key, _dump(value)),
        )


def save_day(owner_scope: str, date: str, day: dict[str, Any]) -> None:
    _upsert(owner_scope, "nutrition_days", "day_date", "day_json", date, _project(day, DAY_FIELDS))


def save_program(owner_scope: str, program: dict[str, Any]) -> None:
    _upsert(owner_scope, "nutrition_programs", "start_date", "program_json", program["from"], _project(program, PROGRAM_FIELDS))


def save_weight(owner_scope: str, weight: dict[str, Any]) -> None:
    _upsert(owner_scope, "nutrition_weights", "weight_date", "weight_json", weight["date"], _project(weight, WEIGHT_FIELDS))


def save_review(owner_scope: str, date: str, review: dict[str, Any]) -> None:
    _upsert(owner_scope, "nutrition_reviews", "review_date", "review_json", date, _project(review, REVIEW_FIELDS))


def import_user_data(owner_scope: str, data: dict[str, Any]) -> dict[str, int]:
    """Import a verified source snapshot once, without replacing existing user data."""
    with app_db.connection() as database:
        database.execute("BEGIN IMMEDIATE")
        if database.execute(
            "SELECT 1 FROM settings WHERE scope = ? AND name = 'nutrition_sqlite_import_v1'", (owner_scope,),
        ).fetchone():
            raise ValueError("Nutrition data was already imported for this user.")
        existing = database.execute(
            "SELECT EXISTS(SELECT 1 FROM nutrition_entries WHERE owner_scope = ?) OR "
            "EXISTS(SELECT 1 FROM nutrition_days WHERE owner_scope = ?) OR "
            "EXISTS(SELECT 1 FROM nutrition_programs WHERE owner_scope = ?) OR "
            "EXISTS(SELECT 1 FROM nutrition_weights WHERE owner_scope = ?) OR "
            "EXISTS(SELECT 1 FROM nutrition_reviews WHERE owner_scope = ?)",
            (owner_scope,) * 5,
        ).fetchone()[0]
        if existing:
            raise ValueError("Nutrition records already exist for this user; import was not applied.")
        for entry in data.get("entries", []):
            _save_entry(database, owner_scope, entry)
        for date, day in data.get("days", {}).items():
            database.execute("INSERT INTO nutrition_days VALUES (?, ?, ?)", (owner_scope, date, _dump(_project(day, DAY_FIELDS))))
        for program in data.get("programs", []):
            database.execute("INSERT INTO nutrition_programs VALUES (?, ?, ?)", (owner_scope, program["from"], _dump(_project(program, PROGRAM_FIELDS))))
        for weight in data.get("weights", []):
            database.execute("INSERT INTO nutrition_weights VALUES (?, ?, ?)", (owner_scope, weight["date"], _dump(_project(weight, WEIGHT_FIELDS))))
        for date, review in data.get("coach", {}).items():
            database.execute("INSERT INTO nutrition_reviews VALUES (?, ?, ?)", (owner_scope, date, _dump(_project(review, REVIEW_FIELDS))))
        counts = {
        "entries": len(data.get("entries", [])),
        "items": sum(len(entry.get("items", [])) for entry in data.get("entries", [])),
        "days": len(data.get("days", {})),
        "programs": len(data.get("programs", [])),
        "weights": len(data.get("weights", [])),
        "reviews": len(data.get("coach", {})),
        }
        database.execute("INSERT INTO settings(scope, name, value) VALUES (?, 'nutrition_sqlite_import_v1', ?)", (owner_scope, _dump(counts)))
    return counts
