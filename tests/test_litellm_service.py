import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend.utils import app_db
from backend.services import food_mcp_server, food_parser_client, llm_service, nutrition_service


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

    def test_isolate_is_distinct_from_regular_whey(self):
        items = [
            {"input": "1 scoop iso whey protein", "name": "whey isolate", "qty": 1, "unit": "scoop", "total_grams": 30, "nutrition_basis": "estimate", "per100g": {"protein": 90}},
            {"input": "1 scoop whey protein", "name": "whey protein", "qty": 1, "unit": "scoop", "total_grams": 30, "nutrition_basis": "estimate", "per100g": {"protein": 79}},
        ]
        with patch.object(food_mcp_server, "_generate", return_value=items) as generate:
            parsed = food_mcp_server.llm_parse("1 scoop iso whey protein and 1 scoop whey protein")
        result = nutrition_service._analyse_ai(parsed)
        self.assertEqual([item["name"] for item in result], ["Whey isolate", "Whey protein"])
        self.assertEqual([item["protein"] for item in result], [27, 23.7])
        self.assertIn('"iso whey protein"', generate.call_args.args[0])
        self.assertEqual(nutrition_service._lookup("iso whey protein")["name"], "Whey isolate")

    def test_explicit_label_values_override_generic_nutrition(self):
        items = [{"input": "2 scoops iso whey, 26 g protein per 35 g scoop", "name": "whey isolate", "qty": 2, "unit": "scoop", "total_grams": 70, "nutrition_basis": "label", "per100g": {"protein": 26 / 35 * 100}}]
        with patch.object(food_mcp_server, "_generate", return_value=items):
            parsed = food_mcp_server.llm_parse(items[0]["input"])
        result = nutrition_service._analyse_ai(parsed)[0]
        self.assertEqual(result["protein"], 52)
        self.assertEqual(result["grams"], 70)
        self.assertIn("User label", result["source"])

    def test_parser_preserves_other_food_subtypes(self):
        items = [{"input": "2 egg whites", "name": "egg white", "qty": 2, "unit": "piece", "total_grams": 66, "per100g": {"protein": 10.9}}]
        with patch.object(food_mcp_server, "_generate", return_value=items):
            parsed = food_mcp_server.llm_parse("2 egg whites")
        result = nutrition_service._analyse_ai(parsed)[0]
        self.assertEqual(result["name"], "Egg white")
        self.assertEqual(result["protein"], 7.2)
        self.assertEqual(parsed[0]["nutrition_basis"], "estimate")

    def test_prewarm_does_not_call_model_or_use_quota(self):
        with patch.object(food_parser_client, "_ensure_started") as ensure, patch.object(food_parser_client, "_count_call") as count, patch.object(llm_service, "generate") as generate:
            self.assertTrue(food_parser_client.prewarm())
        ensure.assert_called_once_with()
        count.assert_not_called()
        generate.assert_not_called()

    def test_failed_prewarm_leaves_backend_available(self):
        with patch.object(food_parser_client, "_ensure_started", side_effect=RuntimeError("startup failed")):
            self.assertFalse(food_parser_client.prewarm())

    def test_startup_requires_completed_mcp_handshake(self):
        thread = SimpleNamespace(is_alive=lambda: True)
        with patch.object(food_parser_client, "_thread", thread), patch.object(food_parser_client._startup_done, "wait", return_value=True) as wait, patch.object(food_parser_client._ready, "is_set", return_value=False):
            with self.assertRaisesRegex(RuntimeError, "initialization"):
                food_parser_client._ensure_started()
        wait.assert_called_once_with(timeout=30)

    def test_backend_lifespan_prewarms_and_shuts_down(self):
        from backend.main import app, lifespan

        async def exercise():
            async with lifespan(app):
                prewarm.assert_called_once_with()
                shutdown.assert_not_called()

        with patch.object(food_parser_client, "prewarm", return_value=True) as prewarm, patch.object(food_parser_client, "shutdown") as shutdown:
            asyncio.run(exercise())
        shutdown.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()