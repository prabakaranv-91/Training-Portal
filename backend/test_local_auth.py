import json
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import HTTPException, Request, Response
from fastapi.testclient import TestClient

import garmin_auth_store as store
import main


class LocalGarminAuthTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "auth.json"
        override = patch.object(store, "STORE_PATH", self.path)
        override.start()
        self.addCleanup(override.stop)
        self.expiry = int(time.time()) + 3600
        self.account = {"email": "test@example.invalid", "user": "Test User", "tokens": "fake-tokens"}
        main.SESSIONS.clear()
        self.addCleanup(main.SESSIONS.clear)

    def test_per_user_storage_and_password_exclusion(self):
        store.save_garmin_auth("first", {**self.account, "password": "never-save"}, self.expiry)
        second = {"email": "other@example.invalid", "user": "Other", "tokens": "other-token"}
        store.save_garmin_auth("second", second, self.expiry)
        self.assertEqual(store.fetch_garmin_auth("first")["account"], self.account)
        self.assertEqual(store.fetch_garmin_auth("second")["account"], second)
        self.assertEqual(store.account_for(" TEST@EXAMPLE.INVALID "), self.account)
        saved = self.path.read_text()
        self.assertNotIn("never-save", saved)
        self.assertEqual(len(json.loads(saved)["users"]), 2)

    def test_logout_invalidates_only_its_session(self):
        store.save_garmin_auth("first", self.account, self.expiry)
        store.save_garmin_auth("second", self.account, self.expiry)
        store.delete_garmin_auth("first")
        self.assertIsNone(store.fetch_garmin_auth("first"))
        self.assertIsNotNone(store.fetch_garmin_auth("second"))
        self.assertEqual(store.account_for(self.account["email"]), self.account)

    def test_expired_or_missing_session_rejected(self):
        self.assertIsNone(store.fetch_garmin_auth("missing"))
        store.save_garmin_auth("first", self.account, self.expiry)
        with patch.object(store.time, "time", return_value=self.expiry + 1):
            self.assertIsNone(store.fetch_garmin_auth("first"))

    def test_concurrent_user_saves_do_not_lose_accounts(self):
        def save(index):
            store.save_garmin_auth(str(index), {
                "email": f"user{index}@example.invalid", "tokens": f"fake-{index}",
            }, self.expiry)
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(save, range(8)))
        data = json.loads(self.path.read_text())
        self.assertEqual(len(data["users"]), 8)
        self.assertEqual(len(data["sessions"]), 8)
        self.assertEqual(list(self.path.parent.glob("*.tmp")), [])

    def test_login_restart_recovery_refresh_and_logout_without_sheets(self):
        client = MagicMock()
        client.full_name = "Test User"
        client.garth.dumps.return_value = "fake-tokens"

        def login(service, email, password):
            service.client = client
            service.email = email
            service._ready = True
            return "success"

        def restore(service, account):
            service.client = client
            service.email = account["email"]
            service._ready = True

        with patch.object(main.GarminService, "login", autospec=True, side_effect=login), \
             patch.object(main.GarminService, "restore_account", autospec=True, side_effect=restore), \
             patch.object(main.sheets_sync, "_post", side_effect=AssertionError("No sheet calls allowed")):
            browser = TestClient(main.app, base_url="https://example.test")
            response = browser.post("/api/login", json={"email": self.account["email"], "password": "fake"})
            self.assertEqual(response.status_code, 200)
            main.SESSIONS.clear()
            self.assertTrue(browser.get("/api/session").json()["garmin"])
            client.garth.dumps.return_value = "refreshed-token"
            browser.get("/api/session")
            self.assertEqual(store.account_for(self.account["email"])["tokens"], "refreshed-token")
            self.assertEqual(browser.post("/api/logout").status_code, 200)
            self.assertFalse(browser.get("/api/session").json()["authenticated"])

    def test_saved_login_is_email_specific_and_local_only(self):
        store.save_garmin_auth("first", self.account, self.expiry)
        request = Request({"type": "http", "scheme": "http", "server": ("127.0.0.1", 8000),
                           "client": ("127.0.0.1", 1234), "path": "/api/garmin/import-local",
                           "headers": [(b"x-local-token-import", b"1")], "query_string": b""})
        with patch.object(main.GarminService, "restore_account") as restore:
            with self.assertRaises(HTTPException) as error:
                main.garmin_import_local(main.SavedGarminRequest(email="unknown@example.invalid"), request, Response())
            self.assertEqual(error.exception.status_code, 404)
            restore.assert_not_called()
        remote = Request({"type": "http", "scheme": "https", "server": ("example.test", 443),
                          "client": ("203.0.113.1", 1234), "path": "/api/garmin/import-local",
                          "headers": [(b"x-local-token-import", b"1")], "query_string": b""})
        with self.assertRaises(HTTPException) as error:
            main.garmin_import_local(main.SavedGarminRequest(email=self.account["email"]), remote, Response())
        self.assertEqual(error.exception.status_code, 403)

    def test_file_write_failure_is_reported(self):
        service = main.GarminService()
        service.client = MagicMock()
        service.email = self.account["email"]
        service.auth_expires_at = self.expiry
        with patch.object(store, "_write", side_effect=OSError("disk unavailable")):
            with self.assertRaises(HTTPException) as error:
                main._save_login("first", service)
            self.assertEqual(error.exception.status_code, 503)
            self.assertIsNone(service.token_snapshot)


if __name__ == "__main__":
    unittest.main()