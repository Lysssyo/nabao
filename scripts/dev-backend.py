#!/usr/bin/env python3
"""Run a stable copy of the built JAR, so subsequent Maven builds cannot corrupt it."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import signal
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1] / "backend"
LOCAL = ROOT / ".local"
PID = LOCAL / "server.pid"


def running():
    if not PID.exists():
        return None
    pid = int(PID.read_text())
    command = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True).stdout
    if str(ROOT) in command and "java" in command and ".jar" in command:
        return pid
    return None


def stop():
    pid = running()
    if pid:
        os.kill(pid, signal.SIGTERM)
        for _ in range(100):
            if not running():
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("Backend has not stopped; inspect the local process before retrying.")
    PID.unlink(missing_ok=True)


def load_environment(env_file=None, lan=False):
    env = os.environ.copy()
    config = ROOT / ".env"
    if config.exists():
        for line in config.read_text().splitlines():
            if line.strip() and not line.lstrip().startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                env.setdefault(key.strip(), value.strip())
    if env_file:
        try:
            configured = json.loads(Path(env_file).read_text())
        except (OSError, ValueError):
            raise RuntimeError("Cannot read the JSON environment file; the running service was left untouched.") from None
        if not isinstance(configured, dict) or any(
            not isinstance(key, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key)
            or not isinstance(value, str) or "\0" in value
            for key, value in configured.items()
        ):
            raise RuntimeError("Environment file must map variable names to strings; the running service was left untouched.")
        env.update(configured)
    if lan:
        env["SERVER_ADDRESS"] = "0.0.0.0"
    return env


def start(env_file=None, lan=False):
    env = load_environment(env_file, lan)
    java = Path(env.get("JAVA_HOME", "/opt/homebrew/opt/openjdk@21")) / "bin/java"
    if not java.exists():
        raise RuntimeError("Set JAVA_HOME to a Java 21 installation.")
    version = subprocess.run([str(java), "-version"], capture_output=True, text=True)
    if version.returncode or not re.search(r'version "21[."]', version.stderr + version.stdout):
        raise RuntimeError("JAVA_HOME must point to Java 21; the running service was left untouched.")
    source = ROOT / "target/nabao-backend-0.1.0-SNAPSHOT.jar"
    digest = hashlib.sha256(source.read_bytes()).hexdigest()[:16]
    stop()
    runtime = LOCAL / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    jar = runtime / f"nabao-{digest}.jar"
    if not jar.exists():
        shutil.copyfile(source, jar)
    with (LOCAL / "server.log").open("a") as log:
        process = subprocess.Popen([str(java), "-jar", str(jar)], cwd=ROOT, env=env,
                                   stdout=log, stderr=log, start_new_session=True)
    PID.write_text(str(process.pid))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(60):
        if process.poll() is not None:
            raise RuntimeError("Backend exited; inspect backend/.local/server.log.")
        try:
            with opener.open(f"http://127.0.0.1:{env.get('PORT', '8080')}/api/v1/health", timeout=1) as response:
                if response.status == 200:
                    print(json.dumps({"status": "UP", "pid": process.pid,
                                      "port": env.get("PORT", "8080"),
                                      "address": env.get("SERVER_ADDRESS", "0.0.0.0")}))
                    return
        except OSError:
            time.sleep(0.5)
    raise RuntimeError("Backend did not become healthy; inspect the local log.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("start", "stop", "status"), nargs="?", default="status")
    parser.add_argument("--env-file", help="Private JSON file of environment variables; overrides inherited configuration")
    parser.add_argument("--lan", action="store_true", help="Listen on the local network for iPhone testing (start only)")
    args = parser.parse_args()
    if args.command != "start" and (args.env_file or args.lan):
        parser.error("--env-file and --lan are only available with start")
    if args.command == "start":
        start(args.env_file, args.lan)
    elif args.command == "stop":
        stop()
        print("Backend stopped.")
    elif args.command == "status":
        print(json.dumps({"pid": running()}))
