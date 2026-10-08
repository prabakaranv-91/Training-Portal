import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

import app_db
import auth_cookies
import main
import sheets_sync


class SQLiteStoreTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        override = patch.object(app_db, "DB_PATH", self.root / "test.sqlite3")
        override.start()
        self.addCleanup(override.stop)
        self.client = TestClient(main.app, base_url="http://localhost:8000")
        self.headers = {"Origin": "http://localhost:8000", "X-App-Settings": "1"}

    def test_legacy_migration_is_once_and_keeps_source_files(self):
        data = self.root / "legacy"
        data.mkdir()
        source = self.root / "strava_config.json"
        source.write_text(json.dumps({"client_id": "old", "client_secret": "fake-secret"}))
        (data / "nutrition_log_example.json").write_text(json.dumps({"entries": [{"id": "old"}], "days": {}}))
        with app_db.connection() as database:
            app_db.migrate_legacy(database, self.root, data, {})
        source.write_text(json.dumps({"client_id": "changed"}))
        with app_db.connection() as database:
            app_db.migrate_legacy(database, self.root, data, {})
        self.assertEqual(app_db.get_setting("strava_config")["client_id"], "old")
        self.assertTrue(source.exists())
        self.assertEqual(app_db.adopt_legacy("nutrition_log", "legacy_user:example", "user:one", {})["entries"][0]["id"], "old")
        self.assertEqual(app_db.adopt_legacy("nutrition_log", "legacy_user:example", "user:two", {}), {})

    def test_settings_are_saved_without_returning_secrets(self):
        response = self.client.post("/api/settings/integrations", headers=self.headers, json={
            "strava_client_id": "fake-id", "strava_client_secret": "fake-secret", "gemini_api_key": "fake-key",
            "sheets_url": "https://script.google.com/macros/s/fake/exec", "sheets_token": "fake-sheet", "sheets_enabled": True,
        })
        self.assertEqual(response.status_code, 200)
        for secret in ("fake-secret", "fake-key", "fake-sheet"):
            self.assertNotIn(secret, response.text)
        self.assertTrue(response.json()["sheets"]["tokenConfigured"])
        self.assertEqual(app_db.get_setting("nutrition_secrets")["sheets_token"], "fake-sheet")

    def test_settings_reject_cross_origin_and_unsafe_urls(self):
        self.assertEqual(self.client.post("/api/settings/integrations", json={}).status_code, 403)
        self.assertEqual(self.client.post("/api/settings/integrations", json={}, headers={**self.headers, "Origin": "https://evil.invalid"}).status_code, 403)
        for url in ("http://127.0.0.1/private", "https://script.google.com:bad/macros/s/fake/exec"):
            self.assertEqual(self.client.post("/api/settings/integrations", headers=self.headers, json={"sheets_url": url}).status_code, 400)

    def test_authenticated_settings_are_isolated_by_account(self):
        for user in ("one", "two"):
            app_db.save_session("strava", user, user, {"refresh_token": "fake", "athlete": {"id": user}}, int(time.time()) + 3600)
        self.client.cookies.set("strava_session", "v2.one")
        self.assertEqual(self.client.post("/api/settings/integrations", headers=self.headers, json={"gemini_api_key": "one-key"}).status_code, 200)
        self.client.cookies.set("strava_session", "v2.two")
        self.assertFalse(self.client.get("/api/settings/integrations").json()["gemini"]["keyConfigured"])
        self.assertEqual(app_db.get_setting("nutrition_secrets", scope="user:strava:one")["gemini_api_key"], "one-key")

    def test_opaque_cookie_survives_restart_and_logout_revokes_it(self):
        app_db.save_session("strava", "opaque", "one", {"refresh_token": "never-in-cookie"}, int(time.time()) + 3600)
        cookie = auth_cookies.encode("strava", {"sid": "opaque"})
        self.assertNotIn("never-in-cookie", cookie)
        self.assertEqual(auth_cookies.decode("strava", {"strava_session": cookie})["account"]["refresh_token"], "never-in-cookie")
        app_db.delete_session("strava", "opaque")
        self.assertIsNone(auth_cookies.decode("strava", {"strava_session": cookie}))

    def test_sheet_worker_uses_originating_user_credentials(self):
        app_db.set_setting("nutrition_config", {"google_sheets": {"web_app_url": "https://example.invalid/one"}}, scope="user:one")
        app_db.set_setting("nutrition_secrets", {"sheets_token": "one-token"}, scope="user:one")
        response = MagicMock()
        response.json.return_value = {"ok": True}
        with patch.object(sheets_sync.requests, "post", return_value=response) as post:
            sheets_sync._post({"action": "info", "_scope": "user:one"})
        self.assertEqual(post.call_args.args[0], "https://example.invalid/one")
        self.assertEqual(post.call_args.kwargs["json"]["token"], "one-token")
        self.assertNotIn("_scope", post.call_args.kwargs["json"])


if __name__ == "__main__":
    unittest.main()