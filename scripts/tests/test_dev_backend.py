import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("dev_backend", Path(__file__).resolve().parents[1] / "dev-backend.py")
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class DevelopmentEnvironmentTests(unittest.TestCase):
    def test_lan_start_keeps_existing_database_port_and_private_key(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config = root / "environment.json"
            config.write_text(json.dumps({"PORT": "18081", "SERVER_ADDRESS": "127.0.0.1",
                                          "SPRING_DATASOURCE_URL": "jdbc:h2:./private-db",
                                          "INTERNAL_API_KEY": "test-key"}))
            with patch.object(backend, "ROOT", root), patch.dict(os.environ, {"PORT": "8080"}, clear=True):
                ordinary = backend.load_environment(config)
                lan = backend.load_environment(config, lan=True)
            self.assertEqual(ordinary["SERVER_ADDRESS"], "127.0.0.1")
            self.assertEqual(lan["SERVER_ADDRESS"], "0.0.0.0")
            for key in ("PORT", "SPRING_DATASOURCE_URL", "INTERNAL_API_KEY"):
                self.assertEqual(lan[key], ordinary[key])
            self.assertEqual(lan["PORT"], "18081")
            self.assertEqual(json.loads(config.read_text())["SERVER_ADDRESS"], "127.0.0.1")

    def test_bad_configuration_never_stops_running_service_or_echoes_values(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config = root / "environment.json"
            for contents in ('{"private-secret":', '["private-secret"]', '{"INTERNAL_API_KEY": 3}', '{"A": "bad\\u0000value"}'):
                config.write_text(contents)
                with patch.object(backend, "ROOT", root), patch.object(backend, "stop") as stop:
                    with self.assertRaises(RuntimeError) as error:
                        backend.start(config)
                    stop.assert_not_called()
                    self.assertNotIn("private-secret", str(error.exception))

    def test_existing_environment_still_overrides_default_dotenv(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".env").write_text("PORT=8080\nAPNS_ENABLED=false\n")
            with patch.object(backend, "ROOT", root), patch.dict(os.environ, {"PORT": "18081"}, clear=True):
                configured = backend.load_environment()
            self.assertEqual(configured["PORT"], "18081")
            self.assertEqual(configured["APNS_ENABLED"], "false")


if __name__ == "__main__":
    unittest.main()
