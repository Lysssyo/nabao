import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("dev_collector", Path(__file__).parents[1] / "dev-collector.py")
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class CollectorLauncherTests(unittest.TestCase):
    def test_private_backend_key_is_reused_without_modifying_the_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "environment.json"
            value = json.dumps({"INTERNAL_API_KEY": "test-only-secret", "NABAO_DATA_DIR": "../data"})
            path.write_text(value)
            with patch.dict(os.environ, {}, clear=True):
                env = launcher.load_environment(path)
            self.assertEqual(env["NABAO_CONTROL_KEY"], "test-only-secret")
            self.assertEqual(env["NABAO_CONTROL_HOST"], "127.0.0.1")
            self.assertEqual(env["NABAO_DATA_DIR"], "../data")
            self.assertEqual(path.read_text(), value)

    def test_invalid_configuration_never_stops_a_running_worker_or_prints_the_value(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "environment.json"
            path.write_text(json.dumps({"INTERNAL_API_KEY": ["test-only-secret"]}))
            with patch.object(launcher, "stop") as stop:
                with self.assertRaises(RuntimeError) as raised:
                    launcher.start(path)
            stop.assert_not_called()
            self.assertNotIn("test-only-secret", str(raised.exception))

    def test_busy_collection_cannot_be_restarted(self):
        with patch.dict(os.environ, {"NABAO_CONTROL_KEY": "test-only-secret"}, clear=True), \
             patch("subprocess.run") as run, patch.object(Path, "is_file", return_value=True), \
             patch.object(launcher, "running", return_value=1234), \
             patch.object(launcher, "read_status", return_value={"busy": True}), \
             patch.object(launcher, "stop") as stop:
            run.return_value.returncode = 0
            run.return_value.stdout = "v22.0.0\n"
            with self.assertRaisesRegex(RuntimeError, "finish that operation"):
                launcher.start(node_binary="/test/node")
            stop.assert_not_called()


if __name__ == "__main__":
    unittest.main()
