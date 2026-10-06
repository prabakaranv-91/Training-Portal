import secrets
import time
import unittest
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, urlparse
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

import auth_cookies
import main
import strava_service


class StravaBrowserAuthTests(unittest.TestCase):
    def parsed_cookies(self, browser):
        parsed = SimpleCookie()
        for name, value in dict(browser.cookies).items():
            parsed.load(f"{name}={value}")
        return {name: value.value for name, value in parsed.items()}

    def setUp(self):
        self.config = patch.object(strava_service, "_load_config", return_value={
            "client_id": "123", "client_secret": "fake-secret",
        })
        self.config.start()
        self.addCleanup(self.config.stop)
        self.browser = TestClient(main.app, base_url="https://example.test")
        self.other = TestClient(main.app, base_url="https://example.test")
        strava_service._ACTIVITY_CACHE.clear()
        strava_service._ATHLETE_WEIGHT_CACHE.clear()

    def authorize(self, browser, athlete_id=1, expires_at=None):
        provider = MagicMock()
        provider.json.return_value = {
            "access_token": f"fake-access-{athlete_id}", "refresh_token": f"fake-refresh-{athlete_id}",
            "expires_at": expires_at if expires_at is not None else int(time.time()) + 3600,
            "athlete": {"id": athlete_id, "firstname": f"Athlete{athlete_id}", "lastname": "Test"},
        }
        start = browser.get("/api/strava/connect", follow_redirects=False)
        state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]
        with patch.object(strava_service.requests, "post", return_value=provider):
            callback = browser.get("/api/strava/callback", params={
                "code": "fake", "state": state, "scope": "read,activity:read_all,profile:read_all",
            }, follow_redirects=False)
        self.assertEqual(callback.headers["location"], "/?strava=connected")
        return callback

    def test_consent_redirect_and_cross_browser_state(self):
        start = self.browser.get("/api/strava/connect", follow_redirects=False)
        self.assertEqual(start.status_code, 302)
        self.assertEqual(start.headers.get("cache-control"), "no-store")
        parsed = urlparse(start.headers["location"])
        self.assertEqual(parsed.hostname, "www.strava.com")
        query = parse_qs(parsed.query)
        self.assertEqual(query["response_type"], ["code"])
        with patch.object(strava_service.requests, "post") as post:
            result = self.other.get("/api/strava/callback", params={
                "code": "fake", "state": query["state"][0],
            }, follow_redirects=False)
            self.assertEqual(result.headers["location"], "/?strava=state_error")
            post.assert_not_called()

    def test_new_authorization_rejects_a_stale_callback(self):
        first = self.browser.get("/api/strava/connect", follow_redirects=False)
        first_state = parse_qs(urlparse(first.headers["location"]).query)["state"][0]
        second = self.browser.get("/api/strava/connect", follow_redirects=False)
        second_state = parse_qs(urlparse(second.headers["location"]).query)["state"][0]
        self.assertNotEqual(first_state, second_state)
        with patch.object(strava_service.requests, "post") as post:
            callback = self.browser.get("/api/strava/callback", params={
                "code": "fake", "state": first_state,
            }, follow_redirects=False)
            self.assertEqual(callback.headers["location"], "/?strava=state_error")
            self.assertEqual(callback.headers.get("cache-control"), "no-store")
            post.assert_not_called()

    def test_each_browser_has_its_own_account(self):
        self.authorize(self.browser, 1)
        self.assertFalse(self.other.get("/api/session").json()["authenticated"])
        self.authorize(self.other, 2)
        self.assertEqual(self.browser.get("/api/profile").json()["fullName"], "Athlete1 Test")
        self.assertEqual(self.other.get("/api/profile").json()["fullName"], "Athlete2 Test")

    def test_rotated_refresh_token_updates_cookie(self):
        self.authorize(self.browser, expires_at=0)
        provider = MagicMock()
        provider.json.return_value = {
            "access_token": "rotated-access", "refresh_token": "rotated-refresh",
            "expires_at": int(time.time()) + 3600,
        }
        activities = MagicMock()
        activities.status_code = 200
        activities.json.return_value = []
        with patch.object(strava_service.requests, "post", return_value=provider) as post, \
             patch.object(strava_service.requests, "get", return_value=activities):
            self.assertEqual(self.browser.get("/api/strava/activities").status_code, 200)
            self.assertEqual(post.call_args.kwargs["data"]["refresh_token"], "fake-refresh-1")
        record = auth_cookies.decode("strava", self.parsed_cookies(self.browser))
        self.assertEqual(record["account"]["refresh_token"], "rotated-refresh")

    def test_switching_account_changes_cache_identity(self):
        self.authorize(self.browser, 1)
        first = auth_cookies.decode("strava", self.parsed_cookies(self.browser))
        self.authorize(self.browser, 2)
        second = auth_cookies.decode("strava", self.parsed_cookies(self.browser))
        self.assertNotEqual(first["sid"], second["sid"])
        self.assertEqual(self.browser.get("/api/profile").json()["fullName"], "Athlete2 Test")

    def test_cookie_flags_and_disconnect(self):
        callback = self.authorize(self.browser)
        headers = [header for header in callback.headers.get_list("set-cookie") if header.startswith("strava_session")]
        self.assertTrue(headers)
        for header in headers:
            self.assertIn("HttpOnly", header)
            self.assertIn("Secure", header)
            self.assertIn("SameSite=lax", header)
        self.assertEqual(self.browser.post("/api/strava/disconnect").status_code, 200)
        self.assertFalse(self.browser.get("/api/session").json()["authenticated"])
        self.assertNotIn("strava_session", self.browser.cookies)

    def test_cache_is_partitioned_by_browser(self):
        self.authorize(self.browser, 1)
        self.authorize(self.other, 2)
        response = MagicMock()
        response.status_code = 200
        response.json.return_value = []
        with patch.object(strava_service.requests, "get", return_value=response) as get:
            self.browser.get("/api/strava/activities")
            self.other.get("/api/strava/activities")
            self.assertEqual(get.call_count, 2)

    def test_expired_tampered_and_oversized_cookie_rejection(self):
        token = auth_cookies.encode("strava", {"sid": "test", "expiresAt": 0})
        self.assertIsNone(auth_cookies.decode("strava", {"strava_session": f"v1.1.{token}"}))
        self.authorize(self.browser)
        cookies = self.parsed_cookies(self.browser)
        self.assertIsNotNone(auth_cookies.decode("strava", cookies))
        cookies["strava_session"] = cookies["strava_session"][:-3] + "bad"
        self.assertIsNone(auth_cookies.decode("strava", cookies))
        with self.assertRaises(ValueError):
            auth_cookies.encode("strava", {"tokens": secrets.token_urlsafe(auth_cookies.MAX_PAYLOAD)})


if __name__ == "__main__":
    unittest.main()