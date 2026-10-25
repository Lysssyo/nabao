import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeSources, writeManagementStatus } from "../src/management-status.js";
import { runTableWatch } from "../src/table-watch.js";
import { sources } from "../src/sources.js";

async function directory(t: import("node:test").TestContext) {
  const path = await mkdtemp(join(tmpdir(), "nabao-management-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const prior = { lastAttempt: "2026-10-23T12:00:00.000Z", lastSuccess: "2026-10-23T12:01:00.000Z", dataDate: "2026-10-23", status: "partial", errorCode: "TABLE_PARTIAL_FIELDS" };
const table = { schemaVersion: 1, dataDate: "2026-10-23", updatedAt: "2026-10-23T12:00:30.000Z", rows: [
  { fundCode: "040046", fundName: "华安纳斯达克100A", feeRate: "0.8%", distributorLimit: "部分渠道100", directLimit: "待更新", trackingError: null, return1y: "10%" },
] };

test("next-day no-table checks preserve published-date counts and bind them to actual bytes", async (t) => {
  const root = await directory(t), tableFile = join(root, "latest.json"), file = join(root, "summary.json");
  const bytes = `${JSON.stringify(table)}\n`;
  await writeFile(tableFile, bytes);
  await writeManagementStatus(file, tableFile, { ...prior, lastAttempt: "2026-10-24T02:00:00.000Z", status: "no_new_post", errorCode: "TABLE_NO_TODAY_POST" },
    summarizeSources([], sources.map((source) => ({ authorId: source.id, issues: [] })), "2026-10-24"));
  const summary = JSON.parse(await readFile(file, "utf8"));
  assert.equal(summary.attemptedDate, "2026-10-24");
  assert.equal(summary.published.dataDate, "2026-10-23");
  assert.equal(summary.published.adoptedFields, 3);
  assert.equal(summary.published.pendingFields, 2);
  assert.equal(summary.published.digest, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(summary.lastSuccess, prior.lastSuccess);
  assert.equal((await stat(file)).mode & 0o777, 0o644);
  assert.equal(summary.sources.length, 5);
  assert.ok(summary.sources.every((source: {status: string}) => source.status === "no_new_post"));
});

test("private per-source diagnostics are reduced to fixed codes without URLs or arbitrary fields", async (t) => {
  const root = await directory(t), file = join(root, "summary.json");
  const attempt = summarizeSources([
    { authorId: sources[0]!.id, title: "private body", noteId: "private-id", status: "FAILED", issues: ["https://signed.test/?token=SECRET"] },
    { authorId: sources[1]!.id, status: "COMPLETE", rows: 32, dataDate: "2026-10-23", issues: [] },
  ], sources.map((source, index) => ({ authorId: source.id, issues: index === 2 ? ["LOGIN_REQUIRED cookie=SECRET"] : [] })), "2026-10-23");
  await writeManagementStatus(file, join(root, "missing.json"), prior, attempt);
  const encoded = await readFile(file, "utf8"), summary = JSON.parse(encoded);
  assert.equal(summary.sources[0].errorCode, "SOURCE_EXTRACTION_FAILED");
  assert.equal(summary.sources[1].status, "complete");
  assert.equal(summary.sources[1].rowCount, 32);
  assert.equal(summary.sources[2].status, "session_expired");
  assert.equal(summary.published, null);
  assert.doesNotMatch(encoded, /SECRET|signed\.test|private|cookie|noteId|title|issues/);
});

test("oversized or invalid published tables cannot provide misleading summary counts", async (t) => {
  const root = await directory(t), tableFile = join(root, "latest.json"), file = join(root, "summary.json");
  for (const content of ["x".repeat(256 * 1024 + 1), "{broken", JSON.stringify({ ...table, rows: [{ directLimit: null }] })]) {
    await writeFile(tableFile, content);
    await writeManagementStatus(file, tableFile, prior);
    assert.equal(JSON.parse(await readFile(file, "utf8")).published, null);
  }
});

test("exceptions keep last success while shared-summary write failure cannot break a completed publication", async (t) => {
  const root = await directory(t), privateStatus = join(root, "private.json"), file = join(root, "summary.json"), tableFile = join(root, "latest.json");
  await writeFile(privateStatus, JSON.stringify(prior));
  await writeFile(tableFile, JSON.stringify(table));
  await runTableWatch({ statusFile: privateStatus, managementFiles: { statusFile: file, tableFile }, intervalMs: 1,
    signal: new AbortController().signal, once: true, run: async () => { throw new Error("SECRET"); } });
  const failure = JSON.parse(await readFile(file, "utf8"));
  assert.equal(failure.lastSuccess, prior.lastSuccess);
  assert.equal(failure.status, "failed");
  assert.equal(failure.errorCode, "TABLE_RUN_FAILED");
  await rm(file);
  await mkdir(file);
  const alerts: string[] = [];
  const result = await runTableWatch({ statusFile: privateStatus, managementFiles: { statusFile: file, tableFile }, intervalMs: 1,
    signal: new AbortController().signal, once: true, onAlert: (status) => { if (status.errorCode) alerts.push(status.errorCode); },
    run: async () => ({ status: "published", dataDate: "2026-10-23", publication: { status: "PUBLISHED" } }) });
  assert.equal(result!.status, "published");
  assert.ok(alerts.includes("STATE_WRITE_FAILED"));
  assert.equal(JSON.parse(await readFile(tableFile, "utf8")).dataDate, "2026-10-23");
});
