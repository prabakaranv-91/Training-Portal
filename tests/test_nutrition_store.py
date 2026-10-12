import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.services import nutrition_store
from backend.utils import app_db


class NutritionStoreTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        override = patch.object(app_db, "DB_PATH", Path(temporary.name) / "nutrition.sqlite3")
        override.start()
        self.addCleanup(override.stop)

    def test_import_keeps_consumed_fields_and_discards_sheet_extras(self):
        source = {
            "entries": [{"id": "meal", "date": "2026-10-09", "time": "08:00", "text": "breakfast", "revoked": False,
                         "totals": {"protein": 99}, "items": [{"input": "whey", "name": "Whey", "qty": 1, "unit": "scoop",
                                                                      "protein": 25, "found": True, "rating": "computed-only"}]}],
            "days": {"2026-10-09": {"intake": {"protein": 25}, "targets": {"protein": 150}, "unneeded": "drop"}},
            "programs": [{"from": "2026-01-01", "program": "maintain", "label": "Maintain", "setAt": "2026-01-01", "unused": "drop"}],
            "weights": [{"date": "2026-10-09", "kg": 70, "source": "manual", "setAt": "now", "unneeded": "drop"}],
            "coach": {"2026-10-09": {"sig": "signature", "review": {"summary": "Review"}, "at": "now", "unneeded": "drop"}},
        }
        self.assertEqual(nutrition_store.import_user_data("user:one", source), {
            "entries": 1, "items": 1, "days": 1, "programs": 1, "weights": 1, "reviews": 1,
        })
        loaded = nutrition_store.load_user("user:one")
        item = loaded["entries"][0]["items"][0]
        self.assertEqual(item["protein"], 25)
        self.assertNotIn("rating", item)
        self.assertNotIn("totals", loaded["entries"][0])
        self.assertNotIn("unused", loaded["programs"][0])
        self.assertEqual(loaded["days"]["2026-10-09"], {"intake": {"protein": 25}, "targets": {"protein": 150}})
        self.assertNotIn("unneeded", loaded["weights"][0])
        self.assertEqual(loaded["coach"]["2026-10-09"], {"sig": "signature", "review": {"summary": "Review"}, "at": "now"})

    def test_user_data_is_isolated_and_entry_replacement_removes_old_items(self):
        nutrition_store.save_entry("user:one", {"id": "meal", "date": "2026-10-09", "text": "meal", "items": [
            {"name": "old", "qty": 1}, {"name": "removed", "qty": 2},
        ]})
        nutrition_store.save_entry("user:one", {"id": "meal", "date": "2026-10-09", "text": "edited", "items": [
            {"name": "new", "qty": 3},
        ]})
        stored = nutrition_store.load_user("user:one")["entries"]
        self.assertEqual(stored[0]["text"], "edited")
        self.assertEqual([item["name"] for item in stored[0]["items"]], ["new"])
        self.assertFalse(any(nutrition_store.load_user("user:two").values()))

    def test_import_is_refused_if_user_already_has_records(self):
        nutrition_store.save_weight("user:one", {"date": "2026-10-09", "kg": 70})
        with self.assertRaisesRegex(ValueError, "already exist"):
            nutrition_store.import_user_data("user:one", {"entries": [{"id": "must-not-write", "date": "2026-10-09", "items": []}]})
        self.assertEqual(nutrition_store.load_user("user:one")["entries"], [])


if __name__ == "__main__":
    unittest.main()