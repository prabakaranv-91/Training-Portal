import time
import unittest
from unittest.mock import MagicMock, patch

from cryptography.fernet import InvalidToken
from fastapi import HTTPException, Request, Response

import main
import sheets_sync
from garmin_service import GarminService


class SheetAuthTests(unittest.TestCase):
    def setUp(self):
        self.account = {"email": "test@example.invalid", "user": "Test User", "tokens": "fake-tokens"}
        self.expiry = int(time.time()) + 3600

    def test_encrypted_round_trip_without_disk_queue(self):
        with patch.object(sheets_sync, "is_configured", return_value=True), \
             patch.object(sheets_sync, "_post", return_value={"ok": True}) as post, \
             patch.object(sheets_sync, "_enqueue") as enqueue:
            sheets_sync.save_garmin_auth("test-cookie", self.account, self.expiry)
            record = post.call_args.args[0]
            self.assertNotEqual(record["sessionKey"], "test-cookie")
            self.assertNotIn("fake-tokens", record["ciphertext"])
            post.return_value = {"ok": True, "found": True, "record": record}
            saved = sheets_sync.fetch_garmin_auth("test-cookie")
            self.assertEqual(saved["account"], self.account)
            record["expiresAt"] = 0
            self.assertIsNone(sheets_sync.fetch_garmin_auth("test-cookie"))
            enqueue.assert_not_called()

    def test_modified_ciphertext_is_rejected(self):
        with patch.object(sheets_sync, "is_configured", return_value=True), \
             patch.object(sheets_sync, "_post", return_value={"ok": True}) as post:
            sheets_sync.save_garmin_auth("test-cookie", self.account, self.expiry)
            record = post.call_args.args[0]
            record["ciphertext"] = "invalid-ciphertext"
            post.return_value = {"ok": True, "found": True, "record": record}
            with self.assertRaises(InvalidToken):
                sheets_sync.fetch_garmin_auth("test-cookie")

    def test_garmin_exports_and_restores_without_files(self):
        client = MagicMock()
        client.full_name = "Test User"
        client.garth.dumps.return_value = "fake-tokens"
        service = GarminService()
        service.client = client
        service.email = self.account["email"]
        self.assertEqual(service.export_account(), self.account)
        with patch("garmin_service.Garmin", return_value=client):
            service.restore_account(self.account)
        client.login.assert_called_once_with("fake-tokens")
        client.garth.dump.assert_not_called()
        self.assertTrue(service.is_authenticated)

    def test_restart_recovery_and_refreshed_token_save(self):
        session_id = "test-restored-session"
        service = GarminService()
        client = MagicMock()
        client.full_name = "Test User"
        client.garth.dumps.return_value = "fake-tokens"

        def restore(account):
            service.client = client
            service._ready = True

        try:
            with patch.object(main, "GarminService", return_value=service), \
                 patch.object(service, "restore_account", side_effect=restore), \
                 patch.object(sheets_sync, "fetch_garmin_auth", return_value={"account": self.account, "expiresAt": self.expiry}), \
                 patch.object(sheets_sync, "save_garmin_auth") as save:
                self.assertIs(main._sheet_session(session_id), service)
                save.assert_not_called()
                client.garth.dumps.return_value = "refreshed-tokens"
                self.assertIs(main._sheet_session(session_id), service)
                save.assert_called_once()
                self.assertEqual(save.call_args.args[2], self.expiry)
        finally:
            main.SESSIONS.pop(session_id, None)

    def test_sheet_failure_rejects_login_and_preserves_logout_for_retry(self):
        service = GarminService()
        service.client = MagicMock()
        service.auth_expires_at = self.expiry
        with patch.object(sheets_sync, "save_garmin_auth", side_effect=RuntimeError("offline")):
            with self.assertRaises(HTTPException) as error:
                main._save_login("test-cookie", service)
            self.assertEqual(error.exception.status_code, 503)
        with patch.object(sheets_sync, "delete_garmin_auth", side_effect=RuntimeError("offline")):
            with self.assertRaises(HTTPException) as error:
                main.logout(Response(), "test-cookie")
            self.assertEqual(error.exception.status_code, 503)

    def test_logout_removes_record_and_cookie(self):
        with patch.object(sheets_sync, "delete_garmin_auth") as delete, \
             patch.object(main.strava_service, "disconnect"):
            response = Response()
            main.logout(response, "test-cookie")
            delete.assert_called_once_with("test-cookie")
            self.assertIn("Max-Age=0", response.headers["set-cookie"])

    def test_local_import_requires_sheet_support_before_reading_tokens(self):
        request = Request({"type": "http", "scheme": "http", "server": ("127.0.0.1", 8000),
                           "client": ("127.0.0.1", 12345), "path": "/api/garmin/import-local",
                           "headers": [(b"x-local-token-import", b"1")], "query_string": b""})
        with patch.object(sheets_sync, "script_info", return_value={"ok": True, "version": 5}), \
             patch.object(GarminService, "import_local_account") as import_tokens:
            with self.assertRaises(HTTPException) as error:
                main.garmin_import_local(request, Response())
            self.assertEqual(error.exception.status_code, 503)
            import_tokens.assert_not_called()

    def test_remote_import_is_rejected(self):
        request = Request({"type": "http", "scheme": "https", "server": ("example.test", 443),
                           "client": ("203.0.113.1", 12345), "path": "/api/garmin/import-local",
                           "headers": [(b"x-local-token-import", b"1")], "query_string": b""})
        with patch.object(GarminService, "import_local_account") as import_tokens:
            with self.assertRaises(HTTPException) as error:
                main.garmin_import_local(request, Response())
            self.assertEqual(error.exception.status_code, 403)
            import_tokens.assert_not_called()


if __name__ == "__main__":
    unittest.main()