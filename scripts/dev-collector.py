#!/usr/bin/env python3
"""Run the collector control service from a stable copy of its compiled sources."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1] / "collector"
LOCAL = ROOT / ".local"
PID = LOCAL / "control.pid"


def running():
    if not PID.exists():
        return None
    try:
        pid = int(PID.read_text())
    except ValueError:
        return None
    command = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True).stdout
    return pid if str(LOCAL / "runtime") in command and "cli.js control" in command else None


def load_environment(env_file=None):
    env = os.environ.copy()
    if env_file:
        try:
            configured = json.loads(Path(env_file).read_text())
        except (OSError, ValueError):
            raise RuntimeError("Cannot read the private JSON environment file; running collector was left untouched.") from None
        if not isinstance(configured, dict) or any(
            not isinstance(key, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key)
            or not isinstance(value, str) or "\0" in value for key, value in configured.items()
        ):
            raise RuntimeError("Environment file must map variable names to strings; running collector was left untouched.")
        env.update(configured)
    # Reuse the existing private management key without writing it to another file.
    env.setdefault("NABAO_CONTROL_KEY", env.get("INTERNAL_API_KEY") or env.get("NABAO_INTERNAL_KEY", ""))
    if not env.get("NABAO_CONTROL_KEY", "").strip():
        raise RuntimeError("Set NABAO_CONTROL_KEY or supply a private environment file containing INTERNAL_API_KEY.")
    env.setdefault("NABAO_CONTROL_HOST", "127.0.0.1")
    env.setdefault("NABAO_CONTROL_PORT", "18082")
    if not env["NABAO_CONTROL_PORT"].isdigit() or not 1 <= int(env["NABAO_CONTROL_PORT"]) <= 65535:
        raise RuntimeError("Invalid control port; running collector was left untouched.")
    if env["NABAO_CONTROL_HOST"] != "127.0.0.1":
        raise RuntimeError("This local launcher only binds the control service to 127.0.0.1; use the Java management proxy.")
    return env


def read_status(env):
    request = urllib.request.Request(
        f"http://127.0.0.1:{env['NABAO_CONTROL_PORT']}/status",
        headers={"X-Internal-Key": env["NABAO_CONTROL_KEY"]},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=2) as response:
        return json.load(response)


def stop():
    pid = running()
    if pid:
        os.kill(pid, signal.SIGTERM)
        for _ in range(100):
            if not running():
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("Collector is still finishing its work; wait and retry. It was not force-killed.")
    PID.unlink(missing_ok=True)


def start(env_file=None, node_binary=None):
    env = load_environment(env_file)
    node = node_binary or env.get("NODE_BINARY") or shutil.which("node")
    if not node or not Path(node).is_file():
        raise RuntimeError("Set NODE_BINARY or pass --node with a Node.js 22–26 executable.")
    version = subprocess.run([node, "--version"], capture_output=True, text=True)
    if version.returncode or not re.match(r"v(22|23|24|25|26)\.", version.stdout):
        raise RuntimeError("Node.js 22–26 is required; running collector was left untouched.")
    compiled = ROOT / "dist"
    if not (compiled / "src/cli.js").is_file():
        raise RuntimeError("Build the collector first: npm run build.")
    if running():
        try:
            status = read_status(env)
        except Exception:
            raise RuntimeError("Cannot inspect the existing collector; it was left running.") from None
        if status.get("busy"):
            raise RuntimeError("Collector is collecting or handling login; finish that operation before restarting.")
    digest = hashlib.sha256()
    for source in sorted(compiled.rglob("*")):
        if source.is_file():
            digest.update(str(source.relative_to(compiled)).encode())
            digest.update(source.read_bytes())
    runtime = LOCAL / "runtime" / digest.hexdigest()[:16]
    runtime.parent.mkdir(parents=True, exist_ok=True)
    if not runtime.exists():
        shutil.copytree(compiled, runtime)
    stop()
    with (LOCAL / "control.log").open("a") as log:
        process = subprocess.Popen([node, str(runtime / "src/cli.js"), "control"],
                                   cwd=ROOT, env=env, stdout=log, stderr=log, start_new_session=True)
    PID.write_text(str(process.pid))
    for _ in range(60):
        if process.poll() is not None:
            raise RuntimeError("Collector exited; inspect collector/.local/control.log.")
        try:
            status = read_status(env)
            if status.get("available"):
                print(json.dumps({"status": "UP", "pid": process.pid,
                                  "port": env["NABAO_CONTROL_PORT"], "address": "127.0.0.1"}))
                return
        except (OSError, ValueError):
            pass
        time.sleep(0.5)
    raise RuntimeError("Collector did not become ready; inspect collector/.local/control.log.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("start", "stop", "status"), nargs="?", default="status")
    parser.add_argument("--env-file", help="Private JSON environment file; can reuse the backend environment file")
    parser.add_argument("--node", help="Path to Node.js 22–26")
    args = parser.parse_args()
    if args.command != "start" and (args.env_file or args.node):
        parser.error("--env-file and --node are only available with start")
    if args.command == "start":
        start(args.env_file, args.node)
    elif args.command == "stop":
        stop()
        print("Collector stopped.")
    else:
        print(json.dumps({"pid": running()}))
