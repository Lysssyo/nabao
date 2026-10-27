#!/usr/bin/env python3
"""Validate the merged deployment without a daemon, credentials or network calls."""
import json
import os
from pathlib import Path
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[2]
COMMAND = shlex.split(os.environ.get("NABAO_COMPOSE_COMMAND", "docker compose"))
TEST_ENV = {
    "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
    "HOME": os.environ.get("HOME", "/tmp"),
    "MYSQL_PASSWORD": "isolated-config-test-password",
    "MYSQL_ROOT_PASSWORD": "isolated-config-test-root-password",
    "INTERNAL_API_KEY": "isolated-config-test-internal-key",
    "NABAO_BACKEND_IMAGE": "nabao-backend:config-test",
    "NABAO_COLLECTOR_IMAGE": "nabao-collector:config-test",
    # Must never override the production loopback binding.
    "BACKEND_BIND_ADDRESS": "0.0.0.0",
}
BASE_VOLUMES = {"mysql-data", "collector-data", "public-data", "status-data", "push-data"}


def config(https=False, extra=None, succeeds=True):
    env = {**TEST_ENV, **(extra or {})}
    args = COMMAND + ["--project-name", "nabao", "--env-file", "/dev/null", "-f", "compose.yml",
                      "-f", "deploy/aliyun/compose.production.yml"]
    if https:
        args += ["-f", "deploy/aliyun/compose.https.yml"]
    result = subprocess.run(args + ["config", "--format", "json"], cwd=ROOT, env=env,
                            capture_output=True, text=True, timeout=30)
    if succeeds:
        assert result.returncode == 0, "Compose configuration failed: " + result.stderr
        return json.loads(result.stdout)
    assert result.returncode != 0, "Invalid deployment unexpectedly accepted"


def check_common(value):
    assert value["name"] == "nabao"
    assert BASE_VOLUMES.issubset(value["volumes"])
    for name in BASE_VOLUMES:
        assert value["volumes"][name]["name"] == "nabao_" + name
    services = value["services"]
    assert services["collector"]["environment"]["NABAO_CONTROL_SCHEDULE_ENABLED"] == "false"
    assert services["collector"]["environment"]["NABAO_CONTROL_HEADLESS"] == "true"
    assert not services["mysql"].get("ports")
    assert not services["collector"].get("ports")
    assert services["collector"]["depends_on"]["backend"]["condition"] == "service_healthy"
    for name in ("mysql", "backend", "collector"):
        assert services[name]["healthcheck"]["test"]
        assert services[name]["logging"]["options"]["max-file"] == "3"
    backend_mounts = {item["target"]: item for item in services["backend"]["volumes"]}
    assert backend_mounts["/app/public"]["source"] == "public-data"
    assert backend_mounts["/app/public"]["read_only"] is True
    assert backend_mounts["/app/status"]["source"] == "status-data"
    assert backend_mounts["/app/status"]["read_only"] is True
    assert backend_mounts["/app/push"]["source"] == "push-data"
    assert services["backend"]["environment"]["JAVA_TOOL_OPTIONS"].startswith("-Xms64m -Xmx192m")
    assert services["collector"]["environment"]["NODE_OPTIONS"] == "--max-old-space-size=256"
    # Compose releases serialize this byte count as either a JSON string or number.
    assert int(services["collector"]["shm_size"]) == 256 * 1024 ** 2
    assert sum(int(services[name]["mem_limit"]) for name in ("mysql", "backend", "collector")) == 1600 * 1024 ** 2


core = config()
check_common(core)
assert set(core["services"]) == {"mysql", "backend", "collector"}
assert len(core["services"]["backend"]["ports"]) == 1
assert core["services"]["backend"]["ports"][0]["host_ip"] == "127.0.0.1"

https = config(True, {"NABAO_DOMAIN": "quota.example.invalid", "ACME_EMAIL": "ops@example.invalid"})
check_common(https)
assert not https["services"]["backend"].get("ports")
caddy = https["services"]["caddy"]
assert {(port["target"], port["published"], port["protocol"]) for port in caddy["ports"]} == {(80, "80", "tcp"), (443, "443", "tcp")}
assert int(caddy["mem_limit"]) == 64 * 1024 ** 2
assert set(https["volumes"]) == BASE_VOLUMES | {"caddy-data", "caddy-config"}
caddy_config = next(item for item in caddy["volumes"] if item["target"] == "/etc/caddy/Caddyfile")
assert caddy_config["source"] == str(ROOT / "deploy/aliyun/Caddyfile") and caddy_config["read_only"]

config(True, succeeds=False)
config(extra={"NABAO_BACKEND_IMAGE": ""}, succeeds=False)
config(extra={"NABAO_COLLECTOR_IMAGE": ""}, succeeds=False)
config(extra={"INTERNAL_API_KEY": ""}, succeeds=False)
print("Deployment config passed: private core ports, HTTPS-only ingress, persistent volumes, resource limits, health probes and required settings.")
