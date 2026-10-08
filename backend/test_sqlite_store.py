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
        app_db.save_session("strava", "registered-session", "registered-test", {"refresh_token": "fake", "athlete": {"id": "registered-test"}}, int(time.time()) + 3600)
        self.client.cookies.set("strava_session", "v2.registered-session")
        self.scope = "user:strava:registered-test"

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
            "gemini_api_key": "fake-key",
            "sheets_url": "https://script.google.com/macros/s/fake/exec", "sheets_token": "fake-sheet", "sheets_enabled": True,
        })
        self.assertEqual(response.status_code, 200)
        for secret in ("fake-secret", "fake-key", "fake-sheet"):
            self.assertNotIn(secret, response.text)
        self.assertTrue(response.json()["sheets"]["tokenConfigured"])
        self.assertEqual(app_db.get_setting("nutrition_secrets", scope=self.scope)["sheets_token"], "fake-sheet")

    def test_llm_provider_switch_requires_new_key_and_model_changes_need_recheck(self):
        settings = {"llm_provider": "openai", "llm_model": "gpt-4o-mini", "llm_api_key": "fake-openai-key", "llm_enabled": True}
        saved = self.client.post("/api/settings/integrations", headers=self.headers, json=settings)
        self.assertEqual(saved.status_code, 200)
        self.assertNotIn("fake-openai-key", saved.text)
        with patch.object(main.llm_service, "generate", return_value={"ok": True}):
            self.assertEqual(self.client.post("/api/settings/check/llm", headers=self.headers).status_code, 200)
        self.assertTrue(self.client.get("/api/settings/integrations").json()["llm"]["ready"])
        changed = self.client.post("/api/settings/integrations", headers=self.headers, json={"llm_model": "gpt-4.1-mini"})
        self.assertFalse(changed.json()["llm"]["ready"])
        rejected = self.client.post("/api/settings/integrations", headers=self.headers, json={"llm_provider": "anthropic"})
        self.assertEqual(rejected.status_code, 400)
        self.assertEqual(app_db.get_setting("nutrition_config", scope=self.scope)["llm"]["provider"], "openai")

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

    def test_public_settings_and_script_download_are_denied(self):
        anonymous = TestClient(main.app, base_url="http://localhost:8000")
        self.assertEqual(anonymous.get("/api/settings/integrations").status_code, 401)
        self.assertEqual(anonymous.post("/api/settings/integrations", headers=self.headers, json={}).status_code, 401)
        self.assertEqual(anonymous.get("/api/settings/sheets/script").status_code, 401)

    def test_setup_is_private_and_provider_login_recovers_settings(self):
        self.client.post("/api/settings/integrations", headers=self.headers, json={"gemini_api_key": "private-test-key"})
        other = TestClient(main.app, base_url="http://localhost:8000")
        app_db.save_session("strava", "other-session", "other-test", {"refresh_token": "fake", "athlete": {"id": "other-test"}}, int(time.time()) + 3600)
        other.cookies.set("strava_session", "v2.other-session")
        self.assertFalse(other.get("/api/settings/integrations").json()["gemini"]["keyConfigured"])
        context = app_db.current_user.set(self.scope)
        try:
            app_db.save_session("strava", "verified", "account-one", {"refresh_token": "fake"}, int(time.time()) + 3600)
        finally:
            app_db.current_user.reset(context)
        self.client.cookies.set("strava_session", "v2.verified")
        self.client.post("/api/logout")
        self.assertEqual(self.client.get("/api/settings/integrations").status_code, 401)
        app_db.save_session("strava", "verified-again", "account-one", {"refresh_token": "fake"}, int(time.time()) + 3600)
        self.client.cookies.set("strava_session", "v2.verified-again")
        self.assertTrue(self.client.get("/api/settings/integrations").json()["gemini"]["keyConfigured"])
        with app_db.connection() as database:
            self.assertEqual(database.execute("SELECT COUNT(*) FROM accounts WHERE provider NOT IN ('garmin', 'strava')").fetchone()[0], 0)

    def test_migrated_owner_configuration_is_not_inherited(self):
        with app_db.connection() as database:
            database.execute("DELETE FROM sessions WHERE provider = 'strava'")
            database.execute("DELETE FROM accounts WHERE provider = 'strava'")
        app_db.save_session("garmin", "owner-session", "owner", {"tokens": "fake-owner"}, int(time.time()) + 3600)
        app_db.set_setting("nutrition_secrets", {"gemini_api_key": "owner-key"})
        with app_db.connection() as database:
            app_db.privatize_integrations(database)
        self.assertIsNone(app_db.get_setting("nutrition_secrets"))
        self.assertEqual(app_db.get_setting("nutrition_secrets", scope="user:garmin:owner")["gemini_api_key"], "owner-key")
        app_db.save_session("strava", "registered-session", "registered-test", {"refresh_token": "fake", "athlete": {"id": "registered-test"}}, int(time.time()) + 3600)
        self.assertFalse(self.client.get("/api/settings/integrations").json()["gemini"]["keyConfigured"])

    def test_setup_readiness_requires_successful_checks(self):
        self.client.post("/api/settings/sheets/token", headers=self.headers)
        script = self.client.get("/api/settings/sheets/script")
        self.assertEqual(script.status_code, 200)
        self.assertNotIn("PASTE_SHEETS_TOKEN_HERE", script.text)
        self.assertEqual(script.headers["cache-control"], "no-store")
        self.client.post("/api/settings/integrations", headers=self.headers, json={"sheets_url": "https://script.google.com/macros/s/fake/exec", "gemini_api_key": "fake-key"})
        self.assertFalse(self.client.get("/api/settings/integrations").json()["sheets"]["ready"])
        with patch.object(main.sheets_sync, "_post", return_value={"ok": True}):
            self.assertTrue(self.client.post("/api/settings/check/sheets", headers=self.headers).json()["sheets"]["ready"])
        response = MagicMock()
        response.json.return_value = {"supportedGenerationMethods": ["generateContent"]}
        with patch.object(main.llm_service, "generate", return_value={"ok": True}):
            self.assertTrue(self.client.post("/api/settings/check/gemini", headers=self.headers).json()["gemini"]["ready"])
        self.client.post("/api/settings/integrations", headers=self.headers, json={"gemini_api_key": "changed-key"})
        self.assertFalse(self.client.get("/api/settings/integrations").json()["gemini"]["ready"])

    def test_setup_promotes_to_a_verified_provider(self):
        setup = app_db.create_setup_session("legacy-setup", int(time.time()) + 3600)
        app_db.set_setting("nutrition_secrets", {"gemini_api_key": "setup-key"}, scope=setup["ownerScope"])
        context = app_db.current_user.set(setup["ownerScope"])
        try:
            app_db.save_session("strava", "new-provider", "new-athlete", {"refresh_token": "fake"}, int(time.time()) + 3600)
        finally:
            app_db.current_user.reset(context)
        self.assertEqual(app_db.fetch_session("strava", "new-provider")["ownerScope"], "user:strava:new-athlete")
        self.assertEqual(app_db.get_setting("nutrition_secrets", scope="user:strava:new-athlete")["gemini_api_key"], "setup-key")
        context = app_db.current_user.set("user:strava:unrelated")
        try:
            app_db.save_session("strava", "other-session", "new-athlete", {"refresh_token": "fake"}, int(time.time()) + 3600)
        finally:
            app_db.current_user.reset(context)
        self.assertEqual(app_db.fetch_session("strava", "other-session")["ownerScope"], "user:strava:new-athlete")

    def test_setup_requires_login_and_incomplete_nutrition_is_blocked(self):
        anonymous = TestClient(main.app, base_url="http://localhost:8000")
        self.assertEqual(anonymous.post("/api/setup/start", headers=self.headers).status_code, 401)
        self.assertTrue(self.client.get("/api/session").json()["authenticated"])
        self.assertFalse(self.client.get("/api/session").json()["nutritionReady"])
        self.assertEqual(self.client.get("/api/nutrition/history").status_code, 403)
        self.assertEqual(self.client.post("/api/nutrition/log", json={"text": "rice"}).status_code, 403)
        self.assertFalse(any(getattr(route, "path", None) == "/api/guest/login" for route in main.app.routes))
        with app_db.connection() as database:
            self.assertEqual(database.execute("SELECT COUNT(*) FROM accounts WHERE provider NOT IN ('garmin', 'strava')").fetchone()[0], 0)

    def test_both_verified_integrations_unlock_nutrition(self):
        self.client.post("/api/settings/integrations", headers=self.headers, json={"sheets_url": "https://script.google.com/macros/s/fake/exec", "sheets_token": "sheet-secret", "gemini_api_key": "gemini-secret"})
        with patch.object(main.sheets_sync, "_post", return_value={"ok": True}):
            self.client.post("/api/settings/check/sheets", headers=self.headers)
        self.assertFalse(self.client.get("/api/session").json()["nutritionReady"])
        response = MagicMock()
        response.json.return_value = {"supportedGenerationMethods": ["generateContent"]}
        with patch.object(main.llm_service, "generate", return_value={"ok": True}):
            self.client.post("/api/settings/check/gemini", headers=self.headers)
        self.assertTrue(self.client.get("/api/session").json()["nutritionReady"])
        self.assertEqual(self.client.get("/api/nutrition/history").status_code, 200)
        self.client.post("/api/settings/integrations", headers=self.headers, json={"gemini_enabled": False})
        self.assertFalse(self.client.get("/api/session").json()["nutritionReady"])
        self.assertEqual(self.client.get("/api/nutrition/history").status_code, 403)

    def test_strava_uses_shared_app_and_rejects_user_overrides(self):
        anonymous = TestClient(main.app, base_url="http://localhost:8000")
        response = anonymous.get("/api/strava/connect", follow_redirects=False)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["location"], "/dashboard.html?strava=app_unavailable")
        saved = self.client.post("/api/settings/integrations", headers=self.headers, json={"strava_client_id": "123", "strava_client_secret": "private-test-secret"})
        self.assertEqual(saved.status_code, 403)
        app_db.set_setting("strava_app_config", {"client_id": "123", "client_secret": "private-test-secret"})
        response = anonymous.get("/api/strava/connect", follow_redirects=False)
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers["location"].startswith("https://www.strava.com/oauth/authorize"))
        self.assertNotIn("private-test-secret", response.headers["location"])
        self.assertNotIn("client_id", self.client.get("/api/settings/integrations").json()["strava"])

    def test_verified_provider_link_preserves_both_histories(self):
        expiry = int(time.time()) + 3600
        app_db.save_session("garmin", "garmin", "g-id", {"email": " Same@Example.invalid ", "tokens": "fake"}, expiry)
        app_db.save_session("strava", "strava", "42", {"refresh_token": "fake"}, expiry)
        app_db.set_setting("nutrition_log", {"entries": [{"id": "first"}], "days": {}}, scope="user:garmin:g-id")
        app_db.set_setting("nutrition_log", {"entries": [{"id": "second"}], "days": {}}, scope="user:strava:42")
        self.assertEqual(app_db.profile_email("user:garmin:g-id"), "same@example.invalid")
        app_db.link_provider("user:garmin:g-id", "strava", "42")
        app_db.link_provider("user:garmin:g-id", "strava", "42")
        self.assertEqual(app_db.fetch_session("strava", "strava")["ownerScope"], "user:garmin:g-id")
        self.assertEqual(len(app_db.get_setting("nutrition_log", scope="user:garmin:g-id")["entries"]), 2)

    def test_different_verified_emails_are_not_silently_merged(self):
        expiry = int(time.time()) + 3600
        app_db.save_session("garmin", "first", "one", {"email": "one@example.invalid", "tokens": "fake"}, expiry)
        app_db.save_session("garmin", "second", "two", {"email": "two@example.invalid", "tokens": "fake"}, expiry)
        with self.assertRaises(ValueError):
            app_db.link_provider("user:garmin:one", "garmin", "two")
        self.assertEqual(app_db.fetch_session("garmin", "second")["ownerScope"], "user:garmin:two")

    def test_strava_link_requires_an_active_garmin_session(self):
        app_db.set_setting("strava_app_config", {"client_id": "123", "client_secret": "fake-secret"})
        anonymous = TestClient(main.app, base_url="http://localhost:8000")
        self.assertEqual(anonymous.get("/api/strava/connect?link=1", follow_redirects=False).status_code, 401)


if __name__ == "__main__":
    unittest.main()