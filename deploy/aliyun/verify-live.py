#!/usr/bin/env python3
"""Read-only HTTPS acceptance checks; never print the management key."""
import argparse
import json
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--url", required=True)
parser.add_argument("--env-file", type=Path, required=True)
parser.add_argument("--expected-table", type=Path)
parser.add_argument("--expected-authors", type=Path)
parser.add_argument("--output", type=Path)
args = parser.parse_args()
base = args.url.rstrip("/")
url = urllib.parse.urlsplit(base)
assert url.scheme == "https" and url.hostname and not url.username and not url.password
assert not url.path and not url.query and not url.fragment
settings = dict(line.split("=", 1) for line in args.env_file.read_text().splitlines()
                if line and not line.startswith("#") and "=" in line)
key = settings["INTERNAL_API_KEY"]
assert len(key) >= 16


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def read(path, authorized=False):
    headers = {"X-Internal-Key": key} if authorized else {}
    request = urllib.request.Request(base + path, headers=headers)
    with opener.open(request, timeout=20) as response:
        assert response.status == 200
        return response.read()


health = json.loads(read("/api/v1/health"))
table = json.loads(read("/api/v1/table"))
assert table["rows"]
json.loads(read("/api/v1/readiness"))
html = read("/admin/index.html").decode("utf-8")
assets = re.findall(r'(?:src|href)="(/admin/assets/[A-Za-z0-9._/-]+)"', html)
assert any(asset.endswith(".js") for asset in assets)
assert any(asset.endswith(".css") for asset in assets)
for asset in assets:
    assert read(asset)
for endpoint in ("/internal/v1/collector", "/internal/v1/table-status"):
    try:
        read(endpoint)
        raise AssertionError("Unauthenticated management endpoint accepted")
    except urllib.error.HTTPError as error:
        assert error.code == 401
status = json.loads(read("/internal/v1/collector", True))
assert status["available"]
management = json.loads(read("/internal/v1/table-status", True))
assert management["tableState"] == "AVAILABLE"
if args.expected_table:
    # The API serializes the validated table; compare values, not JSON whitespace.
    assert table == json.loads(args.expected_table.read_text())
if args.expected_authors:
    expected = json.loads(args.expected_authors.read_text())["authors"]
    assert [(item["id"], item["name"]) for item in status["sources"]] == [
        (item["id"], item["name"]) for item in expected]
report = {"url": base, "httpsTrusted": True, "health": health.get("status"),
          "readiness": 200, "dataDate": table["dataDate"], "rows": len(table["rows"]),
          "adminAssetsVerified": len(assets), "unauthenticatedManagement": 401,
          "collectorAvailable": True, "authors": len(status["sources"]),
          "session": status["session"]["status"], "scheduleEnabled": status["schedule"]["enabled"],
          "tableState": management["tableState"], "summaryState": management["summaryState"]}
if args.output:
    args.output.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report))
