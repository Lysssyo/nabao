#!/usr/bin/env bash
set -euo pipefail

# Uses a disposable Compose project; never connects to the developer H2 service.
# Set DOCKER_HOST for a dedicated daemon, and optionally NABAO_COMPOSE_BIN.
cd "$(dirname "$0")/.."
task_dir="$(pwd)/.local/container-validation"
mkdir -p "$task_dir"
umask 077

if [[ -n "${NABAO_COMPOSE_BIN:-}" ]]; then
  compose=("$NABAO_COMPOSE_BIN")
else
  compose=(docker compose)
fi
docker info >/dev/null
"${compose[@]}" version
python3 - "$task_dir/runtime.env" <<'PY'
import secrets, sys
from pathlib import Path
values = {
    "MYSQL_PASSWORD": secrets.token_hex(24),
    "MYSQL_ROOT_PASSWORD": secrets.token_hex(24),
    "INTERNAL_API_KEY": secrets.token_hex(32),
    "BACKEND_BIND_ADDRESS": "127.0.0.1",
    "BACKEND_PORT": "18080",
    "NABAO_BACKEND_IMAGE": "nabao-backend:smoke",
    "NABAO_COLLECTOR_IMAGE": "nabao-collector:smoke",
}
Path(sys.argv[1]).write_text("".join(f"{k}={v}\n" for k, v in values.items()))
PY
# Compose shell variables otherwise override --env-file (including CI job values).
set -a
source "$task_dir/runtime.env"
set +a
compose+=(--project-name nabao-container-smoke --env-file "$task_dir/runtime.env" --file compose.yml)
cleanup() {
  local result=$?
  "${compose[@]}" logs --no-color --tail 100 >"$task_dir/services.log" 2>&1 || true
  "${compose[@]}" down --volumes >"$task_dir/cleanup.log" 2>&1 || true
  return "$result"
}
trap cleanup EXIT
"${compose[@]}" config --quiet
build_args=()
if [[ -n "${NABAO_BUILD_PROXY:-}" ]]; then
  # Docker's predefined proxy build arguments are not image ENV settings.
  for name in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; do
    build_args+=(--build-arg "$name=$NABAO_BUILD_PROXY")
  done
fi
"${compose[@]}" build backend >"$task_dir/build.log" 2>&1
"${compose[@]}" build "${build_args[@]}" collector >>"$task_dir/build.log" 2>&1
"${compose[@]}" up -d --no-build mysql backend >"$task_dir/start.log" 2>&1

python3 - "$task_dir" <<'PY'
import json, sys, time, urllib.error, urllib.request
from pathlib import Path
root = Path(sys.argv[1])
values = dict(line.split("=", 1) for line in (root / "runtime.env").read_text().splitlines())
base = "http://127.0.0.1:18080"
def call(path, body=None, authorized=False):
    headers = {"Content-Type": "application/json"}
    if authorized:
        headers["X-Internal-Key"] = values["INTERNAL_API_KEY"]
    request = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(),
                                     headers=headers)
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)
for attempt in range(90):
    try:
        call("/api/v1/health")
        break
    except (OSError, urllib.error.URLError):
        if attempt == 89:
            raise
        time.sleep(2)
assert call("/api/v1/quotas") == {"items": []}
sources = call("/api/v1/sources")
authors = ["6168030000000000020278b5", "64ea885c0000000001004087"]
assert set(authors).issubset({source["authorId"] for source in sources["items"]})
def snapshot(author, revision, captured, include=True):
    note = "container-smoke-" + author
    evidence = "https://example.test/" + note
    source = dict(authorId=author, noteId=note, noteRevision=revision,
                  sourcePublishedAt="2026-10-20T01:00:00Z", sourceUpdatedAt=None,
                  capturedAt=captured, evidenceRef=evidence)
    item = dict(**source, fundCode="016452", fundName="容器隔离验证样例",
                channelScope="DISTRIBUTOR", businessType="UNSPECIFIED", period="UNSPECIFIED",
                limitKind="LIMITED", amountMinor=1000, currency="CNY",
                observedForDate="2026-10-20", sourceGroupId=None)
    return dict(**source, items=[item] if include else [])
first = snapshot(authors[0], "smoke-r1", "2026-10-20T02:00:00Z")
try:
    call("/internal/v1/note-snapshots", first)
    raise AssertionError("Unauthenticated ingestion unexpectedly accepted")
except urllib.error.HTTPError as error:
    assert error.code == 401
for author in authors:
    result = call("/internal/v1/note-snapshots", snapshot(author, "smoke-r1", "2026-10-20T02:00:00Z"), True)
    assert result["status"] == "ACTIVATED"
quota = call("/api/v1/quotas")["items"]
assert len(quota) == 1 and quota[0]["status"] == "AGREED" and quota[0]["supportCount"] == 2
assert quota[0]["fundName"] == "容器隔离验证样例"
assert call("/internal/v1/note-snapshots", first, True)["status"] == "DUPLICATE"
call("/internal/v1/note-snapshots", snapshot(authors[0], "smoke-r2", "2026-10-20T03:00:00Z", False), True)
quota = call("/api/v1/quotas")["items"]
assert len(quota) == 1 and quota[0]["status"] == "INSUFFICIENT" and quota[0]["sourceCount"] == 1
report = dict(mysqlHttp=True, authentication=True, majority=True, idempotence=True,
              removedRowWithdrawal=True, utf8RoundTrip=True, syntheticIsolatedData=True)
(root / "http-results.json").write_text(json.dumps(report, indent=2))
print("MySQL HTTP smoke: authentication, majority, duplicate, withdrawal passed.")
PY

"${compose[@]}" restart backend >"$task_dir/restart.log" 2>&1
python3 - "$task_dir" <<'PY'
import json, sys, time, urllib.request
from pathlib import Path
for attempt in range(45):
    try:
        with urllib.request.urlopen("http://127.0.0.1:18080/api/v1/quotas", timeout=5) as response:
            items = json.load(response)["items"]
        assert len(items) == 1 and items[0]["status"] == "INSUFFICIENT" and items[0]["sourceCount"] == 1
        break
    except OSError:
        if attempt == 44:
            raise
        time.sleep(2)
p = Path(sys.argv[1]) / "http-results.json"
report = json.loads(p.read_text())
report["backendRestartPersistence"] = True
p.write_text(json.dumps(report, indent=2))
print("MySQL persisted state survived backend restart.")
PY
"${compose[@]}" run --rm --no-deps collector doctor >"$task_dir/collector-doctor.json"
python3 - "$task_dir/collector-doctor.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
assert report["nodeSupported"] and report["browserInstalled"] and report["internalKeyConfigured"]
print("Collector image: Node, Chromium and internal API configuration passed.")
PY
"${compose[@]}" run --rm --no-deps --entrypoint node collector --input-type=module -e '
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent("<title>nabao container smoke</title>");
  if (await page.title() !== "nabao container smoke") throw new Error("Chromium page check failed");
  console.log("Chromium runtime passed.");
} finally {
  await browser.close();
}
' >"$task_dir/chromium-runtime.log" 2>&1
echo "Container smoke passed. Reports: $task_dir"
