import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend.utils import app_db
from backend.services import llm_service


class LiteLLMServiceTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        override = patch.object(app_db, "DB_PATH", Path(directory.name) / "llm.sqlite3")
        override.start()
        self.addCleanup(override.stop)
        scope = app_db.current_user.set("user:first")
        self.addCleanup(app_db.current_user.reset, scope)
        app_db.set_setting("nutrition_config", {"llm": {"provider": "openai", "model": "gpt-4o-mini", "enabled": True}}, scope="user:first")
        app_db.set_setting("nutrition_secrets", {"llm_api_key": "fake-private-key"}, scope="user:first")

    def test_provider_routing_and_validated_output(self):
        response = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps({"result": [{"name": "rice"}]})))])
        with patch.object(llm_service.litellm, "completion", return_value=response) as call, patch.object(llm_service.litellm, "get_supported_openai_params", return_value=["response_format"]):
            result = llm_service.generate("meal", {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {"name": {"type": "STRING"}}, "required": ["name"]}})
        self.assertEqual(result, [{"name": "rice"}])
        self.assertEqual(call.call_args.kwargs["model"], "openai/gpt-4o-mini")
        self.assertEqual(call.call_args.kwargs["api_key"], "fake-private-key")
        self.assertNotIn("fake-private-key", str(call.call_args.kwargs["messages"]))

    def test_multiple_providers_and_prefixed_models(self):
        response = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"result":{"ok":true}}'))])
        for provider, model, expected in [("gemini", "gemini/gemini-flash-lite-latest", "gemini/gemini-flash-lite-latest"), ("anthropic", "claude-sonnet-4-6", "anthropic/claude-sonnet-4-6"), ("openrouter", "google/gemini-2.5-flash", "openrouter/google/gemini-2.5-flash")]:
            with self.subTest(provider=provider):
                app_db.set_setting("nutrition_config", {"llm": {"provider": provider, "model": model}}, scope="user:first")
                with patch.object(llm_service.litellm, "completion", return_value=response) as call, patch.object(llm_service.litellm, "get_supported_openai_params", return_value=[]):
                    self.assertEqual(llm_service.generate("check", {"type": "OBJECT"}), {"ok": True})
                self.assertEqual(call.call_args.kwargs["model"], expected)

    def test_other_users_do_not_inherit_keys(self):
        scope = app_db.current_user.set("user:second")
        try:
            self.assertIsNone(llm_service.api_key())
            with self.assertRaises(RuntimeError):
                llm_service.generate("meal", {"type": "object"})
        finally:
            app_db.current_user.reset(scope)

    def test_invalid_provider_output_is_rejected_without_leaking_errors(self):
        response = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"wrong":"shape"}'))])
        with patch.object(llm_service.litellm, "completion", return_value=response), patch.object(llm_service.litellm, "get_supported_openai_params", return_value=[]):
            with self.assertRaises(RuntimeError) as error:
                llm_service.generate("meal", {"type": "OBJECT"})
        self.assertNotIn("fake-private-key", str(error.exception))


if __name__ == "__main__":
    unittest.main()