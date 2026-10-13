import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.services import nutrition_service, nutrition_store
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

    def test_manual_nutrients_persist_and_quantity_scales_corrected_values(self):
        scope = app_db.current_user.set("user:one")
        self.addCleanup(app_db.current_user.reset, scope)
        nutrition_store.save_entry("user:one", {"id": "meal", "date": "2026-10-13", "items": [{"name": "Bowl", "qty": 1, "unit": "bowl", "grams": 400, "found": True, "protein": 42, "kcal": 600, "fat": 12}]})
        result = nutrition_service.set_item_nutrition("one", "meal", 0, {"protein": 54})
        self.assertIsNotNone(result)
        saved = nutrition_store.load_user("user:one")["entries"][0]["items"][0]
        self.assertEqual(saved["protein"], 54)
        self.assertEqual(saved["kcal"], 600)
        self.assertEqual(saved["source"], "User-edited nutrition")
        changed = nutrition_service.set_item_qty("one", "meal", 0, 2)
        assert changed is not None
        self.assertEqual(changed["totals"]["protein"], 108)
        self.assertEqual(changed["totals"]["kcal"], 1200)
        self.assertEqual(changed["items"][0]["fat"], 24)

    def test_manual_nutrients_are_scoped_and_invalid_values_do_not_save(self):
        nutrition_store.save_entry("user:one", {"id": "meal", "date": "2026-10-13", "items": [{"name": "Food", "qty": 1, "found": True, "protein": 42}]})
        scope = app_db.current_user.set("user:two")
        try:
            self.assertIsNone(nutrition_service.set_item_nutrition("two", "meal", 0, {"protein": 54}))
        finally:
            app_db.current_user.reset(scope)
        for values in ({}, {"protein": -1}, {"protein": float("nan")}, {"protein": float("inf")}, {"unknown": 1}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                nutrition_service.set_item_nutrition("one", "meal", 0, values)
        self.assertEqual(nutrition_store.load_user("user:one")["entries"][0]["items"][0]["protein"], 42)

    def test_manual_nutrients_can_complete_unmatched_food_but_not_revoked_food(self):
        scope = app_db.current_user.set("user:one")
        self.addCleanup(app_db.current_user.reset, scope)
        nutrition_store.save_entry("user:one", {"id": "meal", "date": "2026-10-13", "items": [{"name": "Homemade food", "qty": 1, "found": False, "protein": 0}, {"name": "Removed food", "qty": 1, "found": True, "revoked": True, "protein": 10}]})
        self.assertIsNotNone(nutrition_service.set_item_nutrition("one", "meal", 0, {"protein": 54, "kcal": 600}))
        saved = nutrition_store.load_user("user:one")["entries"][0]["items"][0]
        self.assertTrue(saved["found"])
        self.assertEqual(saved["protein"], 54)
        self.assertIsNone(nutrition_service.set_item_nutrition("one", "meal", 1, {"protein": 99}))

    def test_failed_manual_nutrition_write_is_not_acknowledged(self):
        scope = app_db.current_user.set("user:one")
        self.addCleanup(app_db.current_user.reset, scope)
        nutrition_store.save_entry("user:one", {"id": "meal", "date": "2026-10-13", "items": [{"name": "Food", "qty": 1, "found": True, "protein": 42}]})
        with patch.object(nutrition_store, "save_entry", side_effect=OSError("disk full")), self.assertRaises(OSError):
            nutrition_service.set_item_nutrition("one", "meal", 0, {"protein": 54})
        self.assertEqual(nutrition_store.load_user("user:one")["entries"][0]["items"][0]["protein"], 42)

    def test_manual_nutrition_endpoint_validates_and_isolates_authenticated_users(self):
        from backend import main

        app_db.save_session("strava", "editor-session", "77", {"refresh_token": "fake", "athlete": {"id": 77, "firstname": "Editor"}}, int(time.time()) + 3600)
        app_db.save_session("strava", "other-session", "88", {"refresh_token": "fake", "athlete": {"id": 88, "firstname": "Other"}}, int(time.time()) + 3600)
        nutrition_store.save_entry("user:strava:77", {"id": "meal", "date": "2026-10-13", "items": [{"name": "Bowl", "qty": 1, "found": True, "protein": 42, "kcal": 600}]})
        browser = TestClient(main.app, base_url="https://example.test")
        path = "/api/nutrition/entries/meal/items/0/nutrition"
        with patch.object(main, "_nutrition_ready", return_value=True):
            self.assertEqual(browser.patch(path, json={"protein": 54}).status_code, 401)
            browser.cookies.set("strava_session", "v2.editor-session")
            self.assertEqual(browser.patch(path, json={"protein": 54}).status_code, 200)
            for values in ({}, {"protein": -1}, {"protein": "NaN"}, {"protein": "Infinity"}, {"protein": 1000001}, {"unexpected": 1}):
                with self.subTest(values=values):
                    self.assertEqual(browser.patch(path, json=values).status_code, 422)
            browser.cookies.set("strava_session", "v2.other-session")
            self.assertEqual(browser.patch(path, json={"protein": 99}).status_code, 404)
        saved = nutrition_store.load_user("user:strava:77")["entries"][0]["items"][0]
        self.assertEqual(saved["protein"], 54)
        self.assertEqual(saved["kcal"], 600)
        coach_routes = [route for route in main.app.routes if getattr(route, "path", "") == "/api/nutrition/coach"]
        self.assertEqual([route.endpoint.__name__ for route in coach_routes], ["nutrition_coach"])


if __name__ == "__main__":
    unittest.main()