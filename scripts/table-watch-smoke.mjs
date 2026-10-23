#!/usr/bin/env node
// A real process/signal exercise with synthetic rounds; this does not contact Xiaohongshu.
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { runTableWatch } from "../collector/dist/src/table-watch.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const parent = resolve(root, ".local/collector-validation");
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, "watch-"));
const statusFile = join(directory, "status.json");
const controller = new AbortController();
const shutdown = () => controller.abort();
process.once("SIGINT", shutdown);
let attempts = 0;
const alerts = [];
const result = await runTableWatch({ statusFile, intervalMs: 25, signal: controller.signal,
  onAlert: (status) => alerts.push(status),
  run: async () => {
    attempts++;
    if (attempts === 1) throw new Error("synthetic upstream failure with sensitive token");
    if (attempts === 2) return { status: "partial", dataDate: "2026-10-21",
      publication: { status: "PUBLISHED" }, errorCode: "TABLE_PARTIAL_FIELDS" };
    setTimeout(() => process.kill(process.pid, "SIGINT"), 5);
    return { status: "unchanged", dataDate: "2026-10-21", publication: { status: "UNCHANGED" } };
  } });
process.removeListener("SIGINT", shutdown);
const saved = JSON.parse(await readFile(statusFile, "utf8"));
assert.equal(attempts, 3);
assert.equal(alerts[0].errorCode, "TABLE_RUN_FAILED");
assert.equal(alerts[1].errorCode, "TABLE_PARTIAL_FIELDS");
assert.ok(alerts[1].lastSuccess);
assert.equal(result.status, "unchanged");
assert.deepEqual(saved, result);
assert.ok(!JSON.stringify(alerts).includes("sensitive token"));
const report = { syntheticData: true, realXiaohongshuContacted: false, attempts,
  rejectedRoundRecovered: true, partialPublicationRecorded: true, sigintExitedCleanly: true,
  privateStatusPersisted: true, success: true };
await writeFile(join(directory, "results.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...report, evidenceDirectory: directory }, null, 2));
