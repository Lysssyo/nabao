import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dailyTableFromReport } from "../src/daily-table-run.js";
import type { DailyTable } from "../src/daily-table.js";
import { contentHash } from "../src/rules.js";
import { sources } from "../src/sources.js";
import type { NoteCapture } from "../src/types.js";
import { addAuthor, removeAuthor } from "../src/author-store.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "nabao-table-run-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const notes: NoteCapture[] = [];
  for (const [index, source] of sources.entries()) {
    const noteId = String(index + 1).repeat(24);
    const directory = join(root, source.id, noteId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "image-0.png"), bytes);
    const capture: NoteCapture = {
      authorId: source.id, noteId, evidenceRef: `https://www.xiaohongshu.com/explore/${noteId}`,
      title: "10月21日纳指限额", body: "10月21日纳指限额一览", sourcePublishedAt: "2026-10-21T02:00:00Z",
      sourceUpdatedAt: null, capturedAt: "2026-10-21T06:00:00Z", captureStatus: "success", issues: [],
      expectedImageCount: 1, images: [{ ordinal: 0, file: "image-0.png", sourceUrl: "https://ci.xiaohongshu.com/test.png",
        size: bytes.length, mediaType: "image/png", sha256: createHash("sha256").update(bytes).digest("hex") }], revision: null,
    };
    capture.revision = contentHash(capture.title, capture.body, capture.images);
    notes.push(capture);
  }
  const report = { results: sources.map((source, index) => ({ authorId: source.id, notes: [notes[index]!], issues: [] as string[],
    status: "success", discoveryComplete: true })) };
  const reportFile = join(root, "report.json");
  const outputDirectory = join(root, "public");
  const save = () => writeFile(reportFile, JSON.stringify(report));
  const extract: NonNullable<Parameters<typeof dailyTableFromReport>[2]>["extract"] = async (capture) => ({
    status: "INCOMPLETE", promptVersion: "test", issues: [], table: {
      schemaVersion: 1, dataDate: "2026-10-21", updatedAt: "2026-10-21T06:00:00Z",
      source: { name: "测试来源", url: capture.evidenceRef, publishedAt: capture.sourcePublishedAt! }, notes: ["额度：元/日"],
      rows: [{ fundCode: "019441", fundName: "万家纳斯达克100指数A", feeRate: null, directLimit: "100",
        distributorLimit: capture.noteId.startsWith("3") ? "20" : "10", trackingError: null, return1y: null }],
    },
  });
  return { root, notes, report, reportFile, outputDirectory, save, extract,
    run: (override = extract) => dailyTableFromReport(reportFile, outputDirectory, { dataDate: "2026-10-21", extract: override }),
    latest: async () => JSON.parse(await readFile(join(outputDirectory, "latest.json"), "utf8")) as DailyTable,
  };
}

test("report replay removes deselected authors and their cached votes before publishing with the current config", async t => {
  const f = await fixture(t);
  await f.save(); await f.run();
  assert.equal((await f.latest()).rows.find(row => row.fundCode === "019441")!.distributorLimit, "10");
  for (const index of [0, 1, 3]) await removeAuthor(f.root, sources[index]!.id);
  const rerun = await f.run(async () => { throw new Error("remaining unchanged notes must use validated evidence"); });
  assert.equal(rerun.publication?.status, "PUBLISHED");
  assert.equal((await f.latest()).rows.find(row => row.fundCode === "019441")!.distributorLimit, "待更新", "one vote each cannot retain the removed authors' majority");
  assert.deepEqual(rerun.management.sources.map(source => source.authorId), [sources[2]!.id, sources[4]!.id]);
  assert.deepEqual(rerun.management.sources.map(source => source.name), [sources[2]!.name, sources[4]!.name]);
  const cached = JSON.parse(await readFile(join(f.root, "table-state", "daily-source-tables-2026-10-21.json"), "utf8"));
  assert.deepEqual(cached.map((source: { authorId: string }) => source.authorId).sort(), [sources[2]!.id, sources[4]!.id].sort());
  const voted = JSON.parse(await readFile(rerun.reportFile, "utf8"));
  assert.ok(voted.voting.decisions.every((decision: { votes: { authorId: string }[] }) => decision.votes.every(vote => [sources[2]!.id, sources[4]!.id].includes(vote.authorId))));
});

test("a newly configured author is extracted and named, and edits stay locked during extraction", async t => {
  const f = await fixture(t), id = "aaaaaaaaaaaaaaaaaaaaaaaa", noteId = "bbbbbbbbbbbbbbbbbbbbbbbb";
  await addAuthor(f.root, { name: "新增作者", profileUrl: `https://www.xiaohongshu.com/user/profile/${id}` });
  const note = { ...f.notes[0]!, authorId: id, noteId, evidenceRef: `https://www.xiaohongshu.com/explore/${noteId}` };
  await mkdir(join(f.root, id, noteId), { recursive: true });
  await writeFile(join(f.root, id, noteId, "image-0.png"), await readFile(join(f.root, sources[0]!.id, f.notes[0]!.noteId, "image-0.png")));
  f.report.results.push({ authorId: id, notes: [note], issues: [], status: "success", discoveryComplete: true });
  await f.save();
  const visited: string[] = [];
  const result = await f.run(async (...args) => {
    visited.push(args[0].authorId);
    await assert.rejects(removeAuthor(f.root, sources[0]!.id), /AUTHOR_CONFIG_BUSY/);
    return f.extract(...args);
  });
  assert.ok(visited.includes(id));
  assert.equal(result.management.sources.find(source => source.authorId === id)?.name, "新增作者");
  assert.equal(result.management.sources.length, 6);
  // The same report cannot restore a deleted author, even though its evidence remains on disk.
  await removeAuthor(f.root, id);
  const next = await f.run(async () => { throw new Error("no new evidence"); });
  assert.equal(next.management.sources.some(source => source.authorId === id), false);
});

test("an unexpected extraction failure is isolated so other authors still publish and a safe report survives", async (t) => {
  const f = await fixture(t);
  await f.save();
  const visited: string[] = [];
  const result = await f.run(async (...args) => {
    visited.push(args[0].authorId);
    if (args[0].authorId === sources[0]!.id) throw new Error("private key and signed URL must not enter the report");
    return f.extract(...args);
  });
  assert.equal(visited.length, 5);
  assert.equal(result.status, "failed");
  assert.equal(result.publication?.status, "PUBLISHED");
  assert.equal((await f.latest()).rows.find((row) => row.fundCode === "019441")!.directLimit, "100");
  const rawReport = await readFile(result.reportFile, "utf8");
  assert.equal(rawReport.includes("private key"), false);
  assert.deepEqual(JSON.parse(rawReport).attempts[0].issues, ["TABLE_EXTRACTION_EXCEPTION"]);
});

test("known note edits still extract their images after the title loses quota keywords; new unrelated posts stay ignored", async (t) => {
  const f = await fixture(t);
  f.report.results[3]!.notes = [];
  f.report.results[4]!.notes = [];
  await f.save();
  await f.run();
  assert.equal((await f.latest()).rows.find((row) => row.fundCode === "019441")!.distributorLimit, "10");
  const changed = f.notes[0]!;
  changed.title = "今日更新见图";
  changed.body = "具体信息详见配图。";
  changed.sourceUpdatedAt = "2026-10-21T07:00:00Z";
  changed.capturedAt = "2026-10-21T08:00:00Z";
  changed.revision = contentHash(changed.title, changed.body, changed.images);
  // A new unrelated post should also stay outside the model's work queue.
  const unrelated = f.notes[3]!;
  unrelated.title = "周末生活"; unrelated.body = "新发的生活笔记";
  unrelated.revision = contentHash(unrelated.title, unrelated.body, unrelated.images);
  f.report.results[3]!.notes = [unrelated];
  await f.save();
  let modelCalls = 0;
  const result = await f.run(async (...args) => { modelCalls++; return f.extract(...args); });
  assert.equal(modelCalls, 1, "the known revision is re-extracted; cached notes and unrelated new posts are not");
  assert.equal(result.publication?.status, "UNCHANGED");
  assert.equal((await f.latest()).rows.find((row) => row.fundCode === "019441")!.distributorLimit, "10");
  // A subsequent extraction confirms that the same post now only lists another share.
  const priorCapture = structuredClone(changed);
  changed.body = "已订正，具体信息详见配图。";
  changed.capturedAt = changed.sourceUpdatedAt = "2026-10-21T09:00:00Z";
  changed.revision = contentHash(changed.title, changed.body, changed.images);
  await f.save();
  const removed = await f.run(async (...args) => {
    const extraction = await f.extract(...args);
    extraction.table!.rows = extraction.table!.rows.map((row) => ({ ...row, fundCode: "019442", fundName: "万家纳斯达克100指数C" }));
    return extraction;
  });
  assert.equal(removed.publication?.status, "PUBLISHED");
  const revised = (await f.latest()).rows.find((row) => row.fundCode === "019441")!;
  assert.equal(revised.distributorLimit, "待更新");
  assert.equal(revised.directLimit, "100");
  // Replaying a capture from before the edit must not revive the removed vote.
  f.report.results[0]!.notes = [priorCapture];
  await f.save();
  await f.run();
  assert.equal((await f.latest()).rows.find((row) => row.fundCode === "019441")!.distributorLimit, "待更新");
});

test("empty or wholly unknown source-state entries cannot permanently suppress extraction retries", async (t) => {
  for (const kind of ["empty", "unknown"] as const) await t.test(kind, async (t) => {
    const f = await fixture(t);
    await f.save();
    await f.run(async (...args) => {
      const result = await f.extract(...args);
      result.table!.rows = kind === "empty" ? [] : result.table!.rows.map((row) => ({ ...row,
        feeRate: null, directLimit: "待更新", distributorLimit: "未明确", trackingError: null, return1y: null }));
      return result;
    });
    const stateFile = join(f.root, "table-state", "daily-source-tables-2026-10-21.json");
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    assert.ok(saved.every((entry: { validationVersion?: string }) => entry.validationVersion === undefined));
    // Previously written v3 state must recover too, not only state written by this version.
    saved.forEach((entry: { validationVersion?: string }) => { entry.validationVersion = "daily-source-validation-v3"; });
    await writeFile(stateFile, JSON.stringify(saved));
    let retried = 0;
    const recovered = await f.run(async (...args) => { retried++; return f.extract(...args); });
    assert.equal(retried, 5);
    assert.equal(recovered.publication?.status, "PUBLISHED");
    assert.ok(recovered.adoptedFields > 0);
  });
});

test("an incomplete source scan cannot be reported as a successful unchanged table check", async (t) => {
  const f = await fixture(t);
  await f.save(); await f.run();
  f.report.results[0]!.notes = [];
  f.report.results[0]!.status = "partial";
  f.report.results[0]!.discoveryComplete = false;
  await f.save();
  const result = await f.run();
  assert.equal(result.publication?.status, "UNCHANGED");
  assert.equal(result.status, "failed");
  const privateReport = JSON.parse(await readFile(result.reportFile, "utf8"));
  assert.ok(privateReport.captureIssues[0].issues.includes("SOURCE_CAPTURE_INCOMPLETE"));
});

test("a cached partial verification retains its source status instead of becoming complete", async (t) => {
  const f = await fixture(t);
  await f.save();
  const first = await f.run();
  assert.ok(first.management.sources.every((source) => source.status === "partial" && source.errorCode === "SOURCE_PARTIAL_FIELDS"));
  const repeated = await f.run(async () => { throw new Error("validated unchanged sources must reuse their saved outcome"); });
  assert.deepEqual(repeated.management, first.management);
  assert.equal(repeated.publication?.status, "UNCHANGED");
  const state = JSON.parse(await readFile(join(f.root, "table-state", "daily-source-tables-2026-10-21.json"), "utf8"));
  assert.ok(state.every((source: { validationStatus: string }) => source.validationStatus === "INCOMPLETE"));
});

test("source identity review changes revalidate useful saved subsets and then resume cache reuse", async (t) => {
  const f = await fixture(t);
  await f.save(); await f.run();
  const stateFile = join(f.root, "table-state", "daily-source-tables-2026-10-21.json");
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  saved.forEach((entry: { validationVersion: string }) => { entry.validationVersion = "daily-source-validation-v4:previous-identity-review"; });
  await writeFile(stateFile, JSON.stringify(saved));
  let revalidated = 0;
  await f.run(async (...args) => {
    revalidated++;
    const result = await f.extract(...args);
    result.table!.rows.push({ ...result.table!.rows[0]!, fundCode: "019442", fundName: "万家纳斯达克100指数C" });
    return result;
  });
  assert.equal(revalidated, 5);
  assert.equal((await f.latest()).rows.find((row) => row.fundCode === "019442")!.directLimit, "100");
  const repeated = await f.run(async () => { throw new Error("unchanged identity review must reuse validated state"); });
  assert.equal(repeated.publication?.status, "UNCHANGED");
  assert.equal(repeated.status, "partial");
});

test("later posts vote only for their extracted table date and revisions cannot retain votes for another date", async (t) => {
  const f = await fixture(t);
  f.report.results[3]!.notes = [];
  f.report.results[4]!.notes = [];
  // Two independent authors publish the previous day's table the following morning.
  for (const note of f.notes.slice(0, 2)) {
    note.sourcePublishedAt = "2026-10-22T01:00:00Z";
    note.capturedAt = "2026-10-22T02:00:00Z";
  }
  await f.save();
  const visited: string[] = [];
  const previousDay = await f.run(async (...args) => {
    visited.push(args[0].noteId);
    return f.extract(...args);
  });
  assert.equal(previousDay.publication?.status, "PUBLISHED");
  assert.ok(f.notes.slice(0, 2).every((note) => visited.includes(note.noteId)));
  const priorTable = await f.latest();
  assert.equal(priorTable.dataDate, "2026-10-21");
  assert.equal(priorTable.rows.find((row) => row.fundCode === "019441")!.distributorLimit, "10");

  // Processing the same evidence for its publication day cannot relabel yesterday's image table.
  const today = await dailyTableFromReport(f.reportFile, f.outputDirectory, {
    dataDate: "2026-10-22", extract: f.extract,
  });
  assert.equal(today.attemptedDate, "2026-10-22");
  assert.equal(today.status, "no_new_post");
  assert.equal(today.publication, null);
  assert.equal(today.adoptedFields, 0);
  assert.deepEqual(await f.latest(), priorTable);

  // The first author then replaces the post with today's table; its old-date vote must be removed.
  const changed = f.notes[0]!;
  const oldCapture = structuredClone(changed);
  changed.title = "10月22日纳指限额";
  changed.body = "已更新为10月22日纳指限额一览";
  changed.sourceUpdatedAt = "2026-10-22T03:00:00Z";
  changed.capturedAt = "2026-10-22T04:00:00Z";
  changed.revision = contentHash(changed.title, changed.body, changed.images);
  await f.save();
  const revised = await f.run(async (...args) => {
    const result = await f.extract(...args);
    if (args[0].noteId === changed.noteId) result.table!.dataDate = "2026-10-22";
    return result;
  });
  assert.equal(revised.publication?.status, "PUBLISHED");
  assert.equal((await f.latest()).rows.find((row) => row.fundCode === "019441")!.distributorLimit, "待更新");
  f.report.results[0]!.notes = [oldCapture];
  await f.save();
  await f.run();
  assert.equal((await f.latest()).rows.find((row) => row.fundCode === "019441")!.distributorLimit, "待更新");
});
