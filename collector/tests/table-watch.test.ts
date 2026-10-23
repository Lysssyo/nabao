import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTableWatch, type TableWatchStatus } from "../src/table-watch.js";

async function directory(t: import("node:test").TestContext) {
  const path = await mkdtemp(join(tmpdir(), "nabao-table-watch-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("a rejected round does not kill watch or erase last successful publication", async (t) => {
  const statusFile = join(await directory(t), "status.json");
  const controller = new AbortController();
  const alerts: TableWatchStatus[] = [];
  let calls = 0;
  const result = await runTableWatch({ statusFile, intervalMs: 5, signal: controller.signal,
    onAlert: (state) => alerts.push(state), run: async () => {
      calls++;
      if (calls === 1) return { status: "published", dataDate: "2026-10-21" };
      if (calls === 2) throw new Error("private cookie=secret token=123 https://signed.test/?xsec_token=sensitive");
      controller.abort();
      return { status: "unchanged", dataDate: "2026-10-21" };
    } });
  assert.equal(calls, 3);
  assert.equal(alerts[0]!.status, "failed");
  assert.equal(alerts[0]!.dataDate, "2026-10-21");
  assert.ok(alerts[0]!.lastSuccess);
  assert.equal(result!.status, "unchanged");
  assert.equal((await stat(statusFile)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(alerts).includes("secret"));
});

test("partial publication records successful data while retaining a maintenance alert", async (t) => {
  const alerts: TableWatchStatus[] = [];
  const statusFile = join(await directory(t), "status.json");
  const result = await runTableWatch({ statusFile, intervalMs: 60_000, signal: new AbortController().signal, once: true,
    onAlert: (state) => alerts.push(state),
    run: async () => ({ status: "partial", dataDate: "2026-10-21", publication: { status: "PUBLISHED" }, errorCode: "TABLE_PARTIAL_FIELDS" }) });
  assert.ok(result!.lastSuccess);
  assert.equal(result!.status, "partial");
  assert.equal(result!.errorCode, "TABLE_PARTIAL_FIELDS");
  assert.equal(alerts.length, 1);
});

test("no new post, restricted access and expired session remain distinct across restarts", async (t) => {
  const statusFile = join(await directory(t), "status.json");
  await runTableWatch({ statusFile, intervalMs: 1, signal: new AbortController().signal, once: true,
    run: async () => ({ status: "published", dataDate: "2026-10-21" }) });
  const before = JSON.parse(await readFile(statusFile, "utf8")) as TableWatchStatus;
  for (const [status, errorCode] of [["no_new_post", "TABLE_NO_TODAY_POST"], ["restricted", "TABLE_ACCESS_RESTRICTED"], ["session_expired", "TABLE_SESSION_EXPIRED"]]) {
    const result = await runTableWatch({ statusFile, intervalMs: 1, signal: new AbortController().signal, once: true,
      run: async () => ({ status: status!, dataDate: null }) });
    assert.equal(result!.status, status);
    assert.equal(result!.errorCode, errorCode);
    assert.equal(result!.lastSuccess, before.lastSuccess);
    assert.equal(result!.dataDate, "2026-10-21");
  }
});

test("reused private votes cannot refresh lastSuccess when collection is restricted or failed", async (t) => {
  const statusFile = join(await directory(t), "status.json");
  const previous: TableWatchStatus = { lastAttempt: "2026-10-20T01:00:00.000Z", lastSuccess: "2026-10-20T01:00:00.000Z",
    dataDate: "2026-10-21", status: "published", errorCode: null };
  await writeFile(statusFile, JSON.stringify(previous));
  for (const status of ["restricted", "session_expired", "failed"]) {
    const result = await runTableWatch({ statusFile, intervalMs: 1, signal: new AbortController().signal, once: true,
      run: async () => ({ status, dataDate: "2026-10-21", publication: { status: "UNCHANGED" } }) });
    assert.equal(result!.lastSuccess, previous.lastSuccess);
    assert.equal(result!.status, status);
    assert.notEqual(result!.lastAttempt, previous.lastAttempt);
    assert.equal((JSON.parse(await readFile(statusFile, "utf8")) as TableWatchStatus).lastSuccess, previous.lastSuccess);
  }
});

test("a successful check, a partial unchanged table or an actual publication advances lastSuccess", async (t) => {
  const statusFile = join(await directory(t), "status.json");
  for (const result of [{ status: "unchanged", publication: { status: "UNCHANGED" } },
    { status: "partial", publication: { status: "UNCHANGED" } },
    { status: "restricted", publication: { status: "PUBLISHED" } }]) {
    await writeFile(statusFile, JSON.stringify({ lastAttempt: "2026-10-20T01:00:00.000Z", lastSuccess: "2026-10-20T01:00:00.000Z",
      dataDate: "2026-10-21", status: "published", errorCode: null }));
    const actual = await runTableWatch({ statusFile, intervalMs: 1, signal: new AbortController().signal, once: true,
      run: async () => ({ ...result, dataDate: "2026-10-21" }) });
    assert.ok(actual!.lastSuccess);
    assert.notEqual(actual!.lastSuccess, "2026-10-20T01:00:00.000Z");
  }
});

test("shutdown interrupts the low-frequency sleep without starting another collection", async (t) => {
  const statusFile = join(await directory(t), "status.json");
  const controller = new AbortController();
  let calls = 0;
  const result = await runTableWatch({ statusFile, intervalMs: 3600_000, signal: controller.signal,
    run: async () => { calls++; setTimeout(() => controller.abort(), 20); return { status: "unchanged", dataDate: "2026-10-21" }; } });
  assert.equal(calls, 1);
  assert.equal(result!.status, "unchanged");
});

test("unrecognized errors and dates never leak into the status file", async (t) => {
  const statusFile = join(await directory(t), "status.json");
  const result = await runTableWatch({ statusFile, intervalMs: 1, signal: new AbortController().signal, once: true,
    run: async () => ({ status: "cookie=sensitive", dataDate: "2026-99-99", errorCode: "API_KEY_SECRET" }) });
  assert.equal(result!.status, "incomplete");
  assert.equal(result!.dataDate, null);
  assert.equal(result!.errorCode, "TABLE_RUN_FAILED");
});
