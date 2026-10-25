#!/usr/bin/env python3
"""Run the built backend and Swift push client against a loopback APNs fixture."""
import argparse
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]


def available_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_until(predicate, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.15)
    raise AssertionError("Local integration condition did not complete before its deadline.")


def decode64(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def der_integer(value):
    value = value.lstrip(b"\0") or b"\0"
    if value[0] & 0x80:
        value = b"\0" + value
    return b"\x02" + bytes([len(value)]) + value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", type=Path, default=ROOT / "backend/target/nabao-backend-0.1.0-SNAPSHOT.jar")
    parser.add_argument("--swift-client", type=Path,
                        default=ROOT / "ios/NabaoCore/.build/debug/VerifyPushClient")
    parser.add_argument("--skip-retry", action="store_true", help="Skip the real 60-second retry wait.")
    parser.add_argument("--table-source", action="store_true", help="Verify file-based table semantics and persistent confirmed limits.")
    args = parser.parse_args()
    assert args.jar.is_file(), "Build the backend JAR first."
    assert args.swift_client.is_file(), "Build VerifyPushClient with Swift first."
    java = Path(os.environ.get("JAVA_HOME", "")) / "bin/java"
    if not java.is_file():
        java = Path(shutil.which("java") or "")
    version = subprocess.run([str(java), "-version"], capture_output=True, text=True)
    if 'version "21' not in version.stderr + version.stdout:
        java = Path("/opt/homebrew/opt/openjdk@21/bin/java")
        assert java.is_file(), "Use Java 21."
    parent = ROOT / ".local/push-validation"
    parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="run-", dir=parent))
    key, public = work / "test-key.p8", work / "test-public.pem"
    # LibreSSL otherwise emits explicit EC parameters that Java's PKCS#8 reader rejects.
    subprocess.run(["openssl", "genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256",
                    "-pkeyopt", "ec_param_enc:named_curve",
                    "-out", str(key)], check=True, capture_output=True)
    key.chmod(0o600)
    subprocess.run(["openssl", "pkey", "-in", str(key), "-pubout", "-out", str(public)],
                   check=True, capture_output=True)
    jar = work / "server.jar"
    shutil.copyfile(args.jar, jar)
    report = {"realAppleContacted": False, "syntheticData": True,
              "source": "table" if args.table_source else "legacy",
              "backendJarSHA256": hashlib.sha256(jar.read_bytes()).hexdigest()}
    requests, lock = [], threading.Lock()
    fail_next = [False]
    fixture_errors = []

    class APNs(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        def do_POST(self):
            try:
                assert self.path.startswith("/3/device/")
                assert self.headers.get("apns-topic") == "com.example.nabao"
                assert self.headers.get("apns-push-type") == "alert"
                assert self.headers.get("apns-priority") == "10"
                assert self.headers.get("apns-collapse-id") == "nabao-public-quotas"
                bearer = self.headers.get("authorization", "")
                assert bearer.startswith("bearer ")
                parts = bearer[7:].split(".")
                assert len(parts) == 3
                assert json.loads(decode64(parts[0])) == {"alg": "ES256", "kid": "TESTKEY001"}
                claims = json.loads(decode64(parts[1]))
                assert claims["iss"] == "TESTTEAM01"
                assert abs(time.time() - claims["iat"]) < 3600
                signature = decode64(parts[2])
                assert len(signature) == 64
                integers = der_integer(signature[:32]) + der_integer(signature[32:])
                (work / "signature.der").write_bytes(b"\x30" + bytes([len(integers)]) + integers)
                (work / "signed.txt").write_bytes(".".join(parts[:2]).encode())
                verified = subprocess.run(["openssl", "dgst", "-sha256", "-verify", str(public),
                                           "-signature", str(work / "signature.der"), str(work / "signed.txt")],
                                          capture_output=True)
                assert verified.returncode == 0, "JWT signature did not verify."
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                assert body["screen"] == "quotas"
                assert "公开参考额度" in body["aps"]["alert"]["body"]
                assert "016452" not in json.dumps(body)
                with lock:
                    status = 503 if fail_next[0] else 200
                    fail_next[0] = False
                    requests.append({"status": status, "payload": body, "time": time.monotonic()})
                data = b'{"reason":"ServiceUnavailable"}' if status == 503 else b""
                self.send_response(status)
                self.send_header("content-length", str(len(data)))
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(data)
            except Exception as error:
                fixture_errors.append(type(error).__name__)
                self.send_response(500)
                self.send_header("content-length", "0")
                self.end_headers()

    mock = http.server.ThreadingHTTPServer(("127.0.0.1", 0), APNs)
    thread = threading.Thread(target=mock.serve_forever, daemon=True)
    thread.start()
    port = available_port()
    base = f"http://127.0.0.1:{port}"
    internal_key = secrets.token_hex(32)
    env = {name: value for name, value in os.environ.items() if not name.startswith(
        ("APNS_", "SPRING_", "DB_", "INTERNAL_API_KEY", "PORT", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS"))}
    env.update({"APNS_ENABLED": "true", "APNS_TEAM_ID": "TESTTEAM01", "APNS_KEY_ID": "TESTKEY001",
                "APNS_BUNDLE_ID": "com.example.nabao", "APNS_ENVIRONMENT": "sandbox",
                "APNS_PRIVATE_KEY_PATH": str(key), "APNS_POLL_DELAY_MS": "250",
                "APNS_TEST_ENDPOINT": f"http://127.0.0.1:{mock.server_port}",
                "INTERNAL_API_KEY": internal_key})
    commands = [str(java), "-jar", str(jar), f"--server.port={port}", "--server.address=127.0.0.1",
                "--spring.profiles.active=test", f"--nabao.push-data-source={'table' if args.table_source else 'legacy'}",
                f"--nabao.table-file={work / 'public/latest.json'}",
                f"--nabao.push-state-file={work / 'private/table-state.json'}", "--spring.datasource.username=sa",
                "--spring.datasource.password=", "--spring.datasource.driver-class-name=org.h2.Driver",
                f"--spring.datasource.url=jdbc:h2:file:{work / 'database'};MODE=MySQL;DATABASE_TO_LOWER=TRUE"]
    log = (work / "server.log").open("a")
    process = None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def start():
        return subprocess.Popen(commands, cwd=work, env=env, stdout=log, stderr=log)

    def stop():
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)

    def call(path, body=None, headers=None, method=None):
        request = urllib.request.Request(base + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json", **(headers or {})}, method=method)
        try:
            with opener.open(request, timeout=5) as response:
                raw = response.read()
                return response.status, json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            return error.code, None

    last_health = [None]

    def ready():
        if process.poll() is not None:
            raise AssertionError("Backend exited; inspect the saved local log.")
        try:
            status, data = call("/api/v1/health")
            push_status = data.get("push", {}).get("status") if isinstance(data, dict) else None
            safe_status = push_status if push_status in {
                "READY", "DISABLED", "NOT_CONFIGURED", "INVALID_CONFIGURATION"
            } else "UNAVAILABLE"
            health = (status, safe_status)
            if health != last_health[0]:
                print(f"Backend health: HTTP {status}; push={safe_status}", flush=True)
                last_health[0] = health
            if status == 200 and safe_status in {"DISABLED", "NOT_CONFIGURED", "INVALID_CONFIGURATION"}:
                raise AssertionError(f"Synthetic APNs fixture is not ready: {safe_status}.")
            return status == 200 and safe_status == "READY"
        except OSError:
            return False

    table_date = ["2026-10-21"]
    current_table = [None]

    def publish_table(table):
        destination = work / "public/latest.json"
        destination.parent.mkdir(exist_ok=True)
        temporary = destination.with_suffix(".tmp")
        temporary.write_text(json.dumps(table, ensure_ascii=False))
        temporary.replace(destination)
        current_table[0] = table

    def snapshots(revision, amount, both=False):
        if args.table_source:
            publish_table({"schemaVersion": 1, "dataDate": table_date[0],
                "updatedAt": f"2026-10-21T0{revision}:00:00Z",
                "source": {"name": "本地合成公开数据", "url": "https://www.xiaohongshu.com/explore/" + "a" * 24,
                           "publishedAt": "2026-10-21T01:00:00Z"},
                "rows": [{"fundCode": "016452", "fundName": "本地纳斯达克100联调样例", "feeRate": "0.65%",
                          "distributorLimit": str(amount / 100), "directLimit": "100",
                          "trackingError": "1.44%", "return1y": "15.19%"},
                         {"fundCode": "019441", "fundName": "本地纳斯达克100另一份额", "feeRate": None,
                          "distributorLimit": "待更新", "directLimit": "待更新", "trackingError": None, "return1y": None}]})
            return
        authors = ["6168030000000000020278b5", "64ea885c0000000001004087"] if both else ["6168030000000000020278b5"]
        for index, author in enumerate(authors):
            metadata = {"authorId": author, "noteId": str(index + 1) * 24,
                        "noteRevision": str(revision) * 64,
                        "sourcePublishedAt": "2026-10-21T01:00:00Z",
                        "sourceUpdatedAt": f"2026-10-21T0{revision}:00:00Z",
                        "capturedAt": f"2026-10-21T0{revision}:01:00Z",
                        "evidenceRef": "https://example.test/synthetic-push-fixture"}
            item = {**metadata, "fundCode": "016452", "fundName": "本地推送联调样例",
                    "channelScope": "DIRECT", "businessType": "DCA", "period": "DAILY",
                    "currency": "CNY", "observedForDate": "2026-10-21",
                    "limitKind": "LIMITED", "amountMinor": amount, "sourceGroupId": None}
            code, _ = call("/internal/v1/note-snapshots", {**metadata, "items": [item]},
                          {"X-Internal-Key": internal_key})
            assert code == 200

    identity = {"backendURL": base, "installationId": str(uuid.uuid4()),
                "installationSecret": secrets.token_hex(32), "token": secrets.token_hex(32),
                "environment": "sandbox"}
    fixture = work / "swift-fixture.json"
    fixture.write_text(json.dumps(identity))
    fixture.chmod(0o600)

    def swift(action):
        result = subprocess.run([str(args.swift_client.resolve()), str(fixture), action],
                                capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, "Swift integration client failed; no credentials printed."
        print(result.stdout.strip(), flush=True)

    def count():
        with lock:
            return len(requests)

    try:
        process = start()
        wait_until(ready, 45)
        snapshots(1, 1000, both=True)
        swift("register")
        time.sleep(0.8)
        assert count() == 0, "Registration must not notify historical data."
        report["swiftRegistrationAndBaseline"] = True
        registration = {key: value for key, value in identity.items() if key != "backendURL"}
        assert call("/api/v1/push-devices", {**registration, "installationSecret": "a" * 64})[0] == 401
        assert call("/api/v1/push-devices", {**registration, "token": "invalid-token"})[0] == 400
        assert call("/api/v1/push-devices", {**registration, "plans": []})[0] == 400
        report["authenticationAndPayloadBoundary"] = True
        if args.table_source:
            table_date[0] = "2026-10-22"
            table = current_table[0]
            table["dataDate"] = table_date[0]
            table["updatedAt"] = "2026-10-22T01:00:00Z"
            table["rows"][0]["feeRate"] = "0.60%"
            table["rows"][0]["return1y"] = "16.00%"
            table["rows"][0]["distributorLimit"] = "10.00元†"
            table["rows"][1]["distributorLimit"] = "10"
            publish_table(table)
            time.sleep(1)
            assert count() == 0, "Date, metrics, formatting or first confirmed values generated a push."
            report["dateMetricsAndInitialConfirmationSilent"] = True
        # Publish one author update; there is one deliberate semantic change.
        snapshots(2, 500)
        wait_until(lambda: count() >= 1)
        time.sleep(0.7)
        first = count()
        snapshots(2, 500)
        time.sleep(0.8)
        assert count() == first, "Duplicate snapshots generated another push."
        report["semanticChangeAndDeduplication"] = True
        assert not fixture_errors, "Local APNs header/signature validation failed."
        report["apnsHeadersAndES256Verified"] = True
        if args.table_source:
            table = current_table[0]
            table["rows"][0]["distributorLimit"] = "待更新"
            publish_table(table)
            time.sleep(0.8)
            assert count() == first, "Lost consensus generated a quota-change push."
            table["rows"][0]["directLimit"] = "50"
            publish_table(table)
            wait_until(lambda: count() == first + 1)
            first = count()
            table["rows"][0]["distributorLimit"] = "5"
            publish_table(table)
            time.sleep(0.8)
            assert count() == first, "Recovering the same confirmed limit generated another push."
            report["unknownFieldsDoNotEraseOrBlockConfirmedChanges"] = True
        if not args.skip_retry:
            with lock:
                fail_next[0] = True
            snapshots(3, 700)
            wait_until(lambda: count() > first)
            with lock:
                failed = next(item for item in requests[first:] if item["status"] == 503)
            time.sleep(0.5)
            stop()
            process = start()
            wait_until(ready, 45)
            restarted = time.monotonic()
            print("Backend restarted; waiting for the persisted retry deadline (about 60 seconds).", flush=True)
            wait_until(lambda: any(item["status"] == 200 and item["time"] > failed["time"]
                                  for item in requests), 75)
            retried = next(item for item in requests if item["status"] == 200 and item["time"] > failed["time"])
            assert retried["time"] > restarted
            assert retried["time"] - failed["time"] >= 55, "Restart bypassed the persisted retry deadline."
            report["failedDeliveryRetriedAfterRestart"] = True
        else:
            report["failedDeliveryRetriedAfterRestart"] = "SKIPPED"
        swift("delete")
        swift("delete")
        time.sleep(0.5)
        before = count()
        snapshots(4, 900)
        time.sleep(0.8)
        assert count() == before, "A deleted registration still received a new push."
        report["swiftDeletionAndNoFurtherDelivery"] = True
        assert not fixture_errors
        (work / "notification.apns").write_text(json.dumps(requests[0]["payload"], ensure_ascii=False, indent=2))
        report["notificationsAcceptedByLocalFixture"] = sum(item["status"] == 200 for item in requests)
        report["notificationPayloadFile"] = str(work / "notification.apns")
        report["success"] = True
        print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    finally:
        stop()
        mock.shutdown()
        mock.server_close()
        log.close()
        key.unlink(missing_ok=True)
        (work / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(f"Local push validation evidence: {work}", flush=True)


if __name__ == "__main__":
    main()
