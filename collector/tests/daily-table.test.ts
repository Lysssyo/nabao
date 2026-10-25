import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAILY_FUND_CODES, PRIMARY_DAILY_FUND_CODES, DAILY_TABLE_PROMPT_VERSION, compareDailyTables, currentLimit, extractDailyTable, publishDailyTable, resolveTableDate, validateDailyTablePayload, type DailyTable } from "../src/daily-table.js";
import { contentHash } from "../src/rules.js";
import type { NoteCapture } from "../src/types.js";
import { DAILY_FUND_CATALOG } from "../src/daily-fund-catalog.js";

const capture: NoteCapture = {
  authorId: "aaaaaaaaaaaaaaaaaaaaaaaa", noteId: "bbbbbbbbbbbbbbbbbbbbbbbb",
  evidenceRef: "https://www.xiaohongshu.com/explore/bbbbbbbbbbbbbbbbbbbbbbbb",
  title: "2026年10月21日纳指限额一览", body: "2026年10月21日纳指限额一览，今日万家10元下调至5元。",
  sourcePublishedAt: "2026-10-20T23:00:00Z", sourceUpdatedAt: null, capturedAt: "2026-10-21T02:00:00Z",
  captureStatus: "success", expectedImageCount: 1, images: [], issues: [], revision: null,
};
function payload(date = "2026年10月21日") {
  return {
    dataDateText: date, dateContext: `${date}纳斯达克限额一览`, pageDates: [date, date, date], notes: [],
    rows: DAILY_FUND_CODES.map((fundCode) => ({
      fundCode: String(fundCode), fundName: `纳斯达克100基金${fundCode}`, feeRate: "0.65%", distributorLimit: "10", directLimit: "100",
      trackingError: "1.44%", return1y: "15.19%", mergedLimit: null as string | null,
    })),
  };
}
function table(date = "2026-10-21"): DailyTable {
  const result = validateDailyTablePayload(payload(date), capture, "测试主来源");
  assert.equal(result.status, "COMPLETE");
  return result.table!;
}
async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "nabao-daily-table-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function extractionFixture(t: TestContext, nextPayload: () => unknown) {
  const path = await directory(t);
  const cacheDirectory = await directory(t);
  const priorCache = process.env.NABAO_TABLE_CACHE_DIR;
  process.env.NABAO_TABLE_CACHE_DIR = cacheDirectory;
  t.after(() => { if (priorCache === undefined) delete process.env.NABAO_TABLE_CACHE_DIR; else process.env.NABAO_TABLE_CACHE_DIR = priorCache; });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+sRe8AAAAASUVORK5CYII=", "base64");
  await writeFile(join(path, "image-0.png"), png);
  const evidence: NoteCapture = { ...capture, images: [{
    ordinal: 0, sourceUrl: "https://test.xhscdn.com/a.png", file: "image-0.png", mediaType: "image/png", size: png.length,
    sha256: createHash("sha256").update(png).digest("hex"),
  }] };
  evidence.revision = contentHash(evidence.title, evidence.body, evidence.images);
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the local model request */ }
    calls++;
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(nextPayload()) } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = { apiKey: "test-api-key", model: "test-image-model", baseUrl: `http://127.0.0.1:${address.port}` };
  // The previous format omitted the update timestamp. Keep this fixture independent of the new key format.
  const legacyKey = createHash("sha256").update(JSON.stringify({
    promptVersion: DAILY_TABLE_PROMPT_VERSION, revision: evidence.revision, publishedAt: evidence.sourcePublishedAt,
    model: config.model, baseUrl: config.baseUrl, trustedFundCatalog: [], expectedCodes: [...DAILY_FUND_CODES].sort(),
  })).digest("hex");
  return { path, cacheDirectory, evidence, config, legacyKey, get calls() { return calls; } };
}

test("table transcribes all 44 specified funds and only publishes the display contract", () => {
  const data = table();
  assert.equal(data.rows.length, 44);
  assert.equal(data.dataDate, "2026-10-21");
  assert.equal(data.source.publishedAt, capture.sourcePublishedAt);
  assert.deepEqual(Object.keys(data), ["schemaVersion", "dataDate", "updatedAt", "source", "rows", "notes"]);
  assert.deepEqual(Object.keys(data.rows[0]!), ["fundCode", "fundName", "feeRate", "distributorLimit", "directLimit", "trackingError", "return1y"]);
  assert.equal(data.rows[0]!.fundCode, "040046");
});

test("month-day titles use verified Shanghai publication date, never capture date", () => {
  assert.equal(resolveTableDate("10/21", "今日10/21限额", capture.sourcePublishedAt), "2026-10-21");
  assert.equal(resolveTableDate("10月21日", "10月21日起生效", capture.sourcePublishedAt), "2026-10-21");
  assert.equal(resolveTableDate("10/21", "10/21纳指限额一览表", capture.sourcePublishedAt), "2026-10-21");
  assert.equal(resolveTableDate("10/21", "今日10/21限额", "2026-10-20T02:00:00Z"), null);
  assert.equal(resolveTableDate("2026-02-31", "2026-02-31限额", capture.sourcePublishedAt), null);
  assert.equal(resolveTableDate("12/31", "12/31日起生效", "2027-01-01T00:00:00Z"), null);
});

test("full-date headers accept a verified clock and equivalent separators without guessing around conflicts", () => {
  const day = "2026-10-23";
  const published = "2026-10-23T07:00:00Z";
  assert.equal(resolveTableDate("2026.10.23 09:29", "公开资料更新：2026-10-23 09:29", published), day);
  assert.equal(resolveTableDate("2026/10/23 9:29:00", "公开资料更新：2026年10月23日 09:29", published), day);
  assert.equal(resolveTableDate("2026.10.23", "2026-10-23 | 周五 每日更新", published), day);
  for (const raw of ["2026.10.23 24:00", "2026.10.23 09:60", "2026.10.23 09:29:60",
    "2026.02.30 09:29", "2026.10.23 09:29随意后缀", "2026.10.23 09:29 / 2026.10.24"]) {
    assert.equal(resolveTableDate(raw, raw, published), null);
  }
  for (const context of ["公开资料更新：2026-10-22 09:29", "2026-10-23 09:30", "2026-10-23",
    "2026-10-22 09:29 / 2026-10-23 09:29", "2026-10-23 09:29 / 2026-10-23 09:30"]) {
    assert.equal(resolveTableDate("2026.10.23 09:29", context, published), null);
  }
  const raw = payload("2026.10.23 09:29");
  raw.dateContext = "公开资料更新：2026-10-23 09:29";
  const note = { ...capture, sourcePublishedAt: published };
  assert.equal(validateDailyTablePayload(raw, note, "source").table?.dataDate, day);
  raw.pageDates[1] = "2026.10.22 09:29";
  assert.deepEqual(validateDailyTablePayload(raw, note, "source").issues, ["TABLE_PAGE_DATES_DISAGREE"]);
});

test("old image-table date is retained despite newer title or capture", () => {
  const result = validateDailyTablePayload(payload("2026年10月13日"), capture, "测试主来源");
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.table!.dataDate, "2026-10-13");
  const differing = payload();
  differing.pageDates[2] = "2026年10月13日";
  assert.deepEqual(validateDailyTablePayload(differing, capture, "测试").issues, ["TABLE_PAGE_DATES_DISAGREE"]);
});

test("explicit changes use new amount and retain partial-channel qualification", () => {
  assert.equal(currentLimit("10→5"), "5");
  assert.equal(currentLimit("10元下调至5元"), "5元");
  assert.equal(currentLimit("由10元下调至5元"), "5元");
  assert.equal(currentLimit("由10元/日下调至5元/日"), "5元/日");
  assert.equal(currentLimit("10元/日→5元/日"), "5元/日");
  assert.equal(currentLimit("部分渠道10→5"), "部分渠道5");
  assert.equal(currentLimit("100->200"), "200");
  assert.equal(currentLimit("暂停"), "暂停");
  assert.equal(currentLimit("无"), "无");
  assert.equal(currentLimit("部分渠道100"), "部分渠道100");
  const raw = payload();
  raw.rows[0]!.distributorLimit = "10→5";
  assert.equal(validateDailyTablePayload(raw, capture, "测试").table!.rows[0]!.distributorLimit, "5");
});

test("merged cells never produce two certain channel amounts; missing metrics stay null", () => {
  const raw = payload();
  raw.rows[0]!.mergedLimit = "部分渠道100";
  const first = raw.rows[0]! as Record<string, unknown>;
  first.feeRate = null; first.trackingError = null; first.return1y = null;
  const result = validateDailyTablePayload(raw, capture, "测试");
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.table!.rows[0]!.distributorLimit, "部分渠道100（未区分直代销）");
  assert.equal(result.table!.rows[0]!.directLimit, "部分渠道100（未区分直代销）");
  assert.equal(result.table!.rows[0]!.feeRate, null);
});

test("unrecognized funds, duplicate codes and incomplete tables cannot replace latest", async (t) => {
  const out = await directory(t);
  await publishDailyTable(table(), out);
  const before = await readFile(join(out, "latest.json"), "utf8");
  const raw = payload();
  raw.rows.pop();
  raw.rows[0]!.fundCode = raw.rows[1]!.fundCode;
  const result = validateDailyTablePayload(raw, capture, "测试");
  assert.equal(result.status, "INCOMPLETE");
  await assert.rejects(publishDailyTable(result.table!, out), /TABLE_INCOMPLETE_NOT_PUBLISHED/);
  assert.equal(await readFile(join(out, "latest.json"), "utf8"), before);
  raw.rows[0]!.fundCode = "000001";
  assert.equal(validateDailyTablePayload(raw, capture, "测试").status, "INCOMPLETE");
});

test("file publication is idempotent; older dates and older same-day notes cannot overwrite", async (t) => {
  const out = await directory(t);
  const latest = table();
  assert.equal((await publishDailyTable(latest, out)).status, "PUBLISHED");
  const bytes = await readFile(join(out, "latest.json"), "utf8");
  assert.equal(bytes, await readFile(join(out, "2026-10-21.json"), "utf8"));
  assert.equal((await publishDailyTable({ ...latest, updatedAt: new Date().toISOString() }, out)).status, "UNCHANGED");
  assert.equal((await publishDailyTable(table("2026-10-20"), out)).status, "OLDER_SKIPPED");
  const olderNote = table();
  olderNote.source.publishedAt = "2026-10-20T20:00:00Z";
  olderNote.rows[0]!.distributorLimit = "999";
  assert.equal((await publishDailyTable(olderNote, out)).status, "OLDER_SKIPPED");
  assert.equal(await readFile(join(out, "latest.json"), "utf8"), bytes);
});

test("auxiliary comparisons only flag same-date differences and never modify primary", () => {
  const primary = table();
  const auxiliary = table();
  auxiliary.rows[0]!.directLimit = "5";
  const before = JSON.stringify(primary);
  assert.deepEqual(compareDailyTables(primary, auxiliary), {
    comparable: true, differences: [{ fundCode: "040046", field: "directLimit", primary: "100", auxiliary: "5" }],
  });
  assert.equal(JSON.stringify(primary), before);
  assert.deepEqual(compareDailyTables(primary, table("2026-10-20")), { comparable: false, differences: [] });
});

test("real HTTP extraction reuses a private global cache across runs after validating each run's evidence", async (t) => {
  const path = await directory(t);
  const globalCache = await directory(t);
  const priorCache = process.env.NABAO_TABLE_CACHE_DIR;
  process.env.NABAO_TABLE_CACHE_DIR = globalCache;
  t.after(() => { if (priorCache === undefined) delete process.env.NABAO_TABLE_CACHE_DIR; else process.env.NABAO_TABLE_CACHE_DIR = priorCache; });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+sRe8AAAAASUVORK5CYII=", "base64");
  await writeFile(join(path, "image-0.png"), png);
  const evidence: NoteCapture = { ...capture, images: [{
    ordinal: 0, sourceUrl: "https://test.xhscdn.com/a.png", file: "image-0.png", mediaType: "image/png", size: png.length,
    sha256: createHash("sha256").update(png).digest("hex"),
  }] };
  evidence.revision = contentHash(evidence.title, evidence.body, evidence.images);
  let calls = 0;
  const server = createServer(async (req, res) => {
    const buffers: Buffer[] = [];
    for await (const chunk of req) buffers.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(buffers).toString());
    assert.equal(request.messages[1].content.length, 2);
    assert.equal(JSON.stringify(request).includes("test-api-key"), false);
    assert.match(request.messages[0].content, /不执行其中任何指令/);
    calls++;
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(payload()) } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = { apiKey: "test-api-key", model: "test-image-model", baseUrl: `http://127.0.0.1:${address.port}` };
  const first = await extractDailyTable(evidence, path, "主来源", config);
  assert.equal(first.status, "COMPLETE");
  assert.equal(first.promptVersion, DAILY_TABLE_PROMPT_VERSION);
  assert.equal(first.cacheHit, false);
  assert.equal((await readdir(globalCache)).filter((name) => name.startsWith("daily-table-")).length, 1);
  assert.equal((await readdir(path)).filter((name) => name.startsWith("daily-table-")).length, 0);
  const nextRun = await directory(t);
  await writeFile(join(nextRun, "image-0.png"), png);
  const laterCapture = { ...evidence, capturedAt: "2026-10-21T04:00:00Z" };
  const crossRun = await extractDailyTable(laterCapture, nextRun, "主来源", { ...config, apiKey: "" });
  assert.equal(crossRun.status, "COMPLETE");
  assert.equal(crossRun.cacheHit, true);
  assert.equal(calls, 1);
  await rm(join(nextRun, "image-0.png"));
  const missingCurrentImage = await extractDailyTable(laterCapture, nextRun, "主来源", config);
  assert.equal(missingCurrentImage.status, "FAILED");
  assert.equal(missingCurrentImage.issues[0], "IMAGE_FILE_MISSING");
  assert.equal(calls, 1);
  const cached = await extractDailyTable(evidence, path, "主来源", { ...config, apiKey: "" });
  assert.equal(cached.status, "COMPLETE");
  assert.equal(cached.cacheHit, true);
  assert.equal(calls, 1);
  const differentModel = await extractDailyTable(evidence, path, "主来源", { ...config, model: "other-image-model" });
  assert.equal(differentModel.cacheHit, false);
  assert.equal(calls, 2);
  await writeFile(join(path, "image-0.png"), Buffer.alloc(png.length));
  const tampered = await extractDailyTable(evidence, path, "主来源", config);
  assert.equal(tampered.status, "FAILED");
  assert.equal(tampered.issues[0], "IMAGE_HASH_MISMATCH");
  assert.equal(calls, 2);
});

test("failed, unusable and unknown-only model payloads do not prevent a later successful extraction", async (t) => {
  const unknown = payload();
  for (const row of unknown.rows) {
    Object.assign(row, { feeRate: null, trackingError: null, return1y: null, distributorLimit: "未明确", directLimit: "待更新" });
  }
  const unusable = payload();
  for (const row of unusable.rows) row.fundCode = "000001";
  for (const [label, invalid] of [["schema invalid", {}], ["all rows rejected", unusable], ["all fields unknown", unknown]] as const) {
    await t.test(label, async (t) => {
      let response: unknown = invalid;
      const fixture = await extractionFixture(t, () => response);
      const first = await extractDailyTable(fixture.evidence, fixture.path, "source", fixture.config);
      assert.equal(first.cacheHit, false);
      assert.deepEqual(await readdir(fixture.cacheDirectory), [], "unusable output must not become a reusable cache");
      response = payload();
      const recovered = await extractDailyTable(fixture.evidence, fixture.path, "source", fixture.config);
      assert.equal(recovered.status, "COMPLETE");
      assert.equal(recovered.cacheHit, false);
      assert.equal(fixture.calls, 2);
      const reused = await extractDailyTable(fixture.evidence, fixture.path, "source", { ...fixture.config, apiKey: "" });
      assert.equal(reused.status, "COMPLETE");
      assert.equal(reused.cacheHit, true);
      assert.equal(fixture.calls, 2);
    });
  }
});

test("invalid entries left by earlier runs are skipped and replaced after recovery", async (t) => {
  const fixture = await extractionFixture(t, () => payload());
  await writeFile(join(fixture.cacheDirectory, `daily-table-${fixture.legacyKey}.json`), JSON.stringify({
    cacheKey: fixture.legacyKey, payload: {},
  }));
  const recovered = await extractDailyTable(fixture.evidence, fixture.path, "source", fixture.config);
  assert.equal(recovered.status, "COMPLETE");
  assert.equal(recovered.cacheHit, false);
  const currentFile = (await readdir(fixture.cacheDirectory)).find((file) => !file.includes(fixture.legacyKey))!;
  assert.ok(currentFile);
  const cached = JSON.parse(await readFile(join(fixture.cacheDirectory, currentFile), "utf8"));
  const unusable = payload();
  for (const row of unusable.rows) row.fundCode = "000001";
  await writeFile(join(fixture.cacheDirectory, currentFile), JSON.stringify({ ...cached, payload: unusable }));
  assert.equal((await extractDailyTable(fixture.evidence, fixture.path, "source", fixture.config)).status, "COMPLETE");
  assert.equal(fixture.calls, 2);
  assert.equal((await extractDailyTable(fixture.evidence, fixture.path, "source", { ...fixture.config, apiKey: "" })).cacheHit, true);
  assert.equal(fixture.calls, 2);
});

test("useful partial extractions and explicit withdrawals remain reusable", async (t) => {
  for (const withdrawal of [false, true]) {
    await t.test(withdrawal ? "explicit withdrawal" : "partial amount", async (t) => {
      const partial = payload();
      partial.rows = [partial.rows[0]!];
      Object.assign(partial.rows[0]!, { feeRate: null, trackingError: null, return1y: null,
        distributorLimit: withdrawal ? "未明确" : "10", directLimit: "未明确",
        withdrawnFields: withdrawal ? ["distributorLimit"] : [],
      });
      const fixture = await extractionFixture(t, () => partial);
      const first = await extractDailyTable(fixture.evidence, fixture.path, "source", fixture.config);
      assert.equal(first.status, "INCOMPLETE");
      assert.equal(first.table!.rows.length, 1);
      const reused = await extractDailyTable(fixture.evidence, fixture.path, "source", { ...fixture.config, apiKey: "" });
      assert.equal(reused.cacheHit, true);
      assert.deepEqual(reused.table!.rows, first.table!.rows);
      assert.deepEqual(reused.withdrawnFields, first.withdrawnFields);
      assert.equal(fixture.calls, 1);
    });
  }
});

test("cache keys include source update time and only migrate unambiguous legacy entries", async (t) => {
  let response = payload();
  const fixture = await extractionFixture(t, () => response);
  await writeFile(join(fixture.cacheDirectory, `daily-table-${fixture.legacyKey}.json`), JSON.stringify({
    cacheKey: fixture.legacyKey, payload: response,
  }));
  const legacy = await extractDailyTable(fixture.evidence, fixture.path, "source", { ...fixture.config, apiKey: "" });
  assert.equal(legacy.status, "COMPLETE");
  assert.equal(legacy.cacheHit, true);
  assert.equal(fixture.calls, 0);
  const updated = { ...fixture.evidence, sourceUpdatedAt: "2026-10-22T00:00:00Z", capturedAt: "2026-10-22T01:00:00Z" };
  response = payload("10/22");
  const fresh = await extractDailyTable(updated, fixture.path, "source", fixture.config);
  assert.equal(fresh.cacheHit, false);
  assert.equal(fresh.table!.dataDate, "2026-10-22");
  assert.equal(fixture.calls, 1);
  assert.equal((await extractDailyTable(updated, fixture.path, "source", { ...fixture.config, apiKey: "" })).cacheHit, true);
  const newer = { ...updated, sourceUpdatedAt: "2026-10-23T00:00:00Z", capturedAt: "2026-10-23T01:00:00Z" };
  response = payload("10/23");
  const newest = await extractDailyTable(newer, fixture.path, "source", fixture.config);
  assert.equal(newest.cacheHit, false);
  assert.equal(newest.table!.dataDate, "2026-10-23");
  assert.equal(fixture.calls, 2);
});


test("verified month-day titles reject future dates, cross-year guesses and old screenshot dates", () => {
  assert.equal(resolveTableDate("1/1", "1/1纳指限额", "2026-12-31T20:00:00Z"), "2027-01-01");
  assert.equal(resolveTableDate("12/31", "12/31纳指限额", "2027-01-01T00:00:00Z"), null);
  assert.equal(resolveTableDate("10/22", "10/22纳指限额", capture.sourcePublishedAt), null);
  assert.equal(resolveTableDate("10/13", "10/13纳指限额", capture.sourcePublishedAt), null);
  const future = validateDailyTablePayload(payload("2026年10月22日"), capture, "测试");
  assert.deepEqual(future.issues, ["TABLE_DATE_AFTER_VERIFIED_SOURCE"]);
  const mismatched = payload("10/21");
  mismatched.pageDates[2] = "2026年10月13日";
  assert.deepEqual(validateDailyTablePayload(mismatched, capture, "测试").issues, ["TABLE_PAGE_DATES_DISAGREE"]);
});

test("auxiliary short-post rows resolve only explicit shares from the supplied main-table catalog", () => {
  const auxiliaryCapture = { ...capture, title: "万家纳指限额下调", body: "10月21日QDII申购限额更新，万家纳斯达克100 A/C代销10元下调至5元，直销100元。" };
  const catalog = [
    { code: "019441", name: "万家纳斯达克100指数(QDII)A" },
    { code: "019442", name: "万家纳斯达克100指数(QDII)C" },
  ];
  const short = {
    dataDateText: "10月21日", dateContext: "10月21日QDII申购限额更新", pageDates: [], notes: [],
    rows: ["A", "C"].map((share) => ({
      fundCode: null, fundName: `万家纳指${share}`, feeRate: null, trackingError: null, return1y: null,
      distributorLimit: "10→5", directLimit: "100", mergedLimit: null,
    })),
  };
  const result = validateDailyTablePayload(short, auxiliaryCapture, "辅助来源", catalog);
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.table!.dataDate, "2026-10-21");
  assert.deepEqual(result.table!.rows.map((row) => [row.fundCode, row.distributorLimit, row.directLimit]), [
    ["019441", "5", "100"], ["019442", "5", "100"],
  ]);
  assert.equal(result.table!.rows[0]!.feeRate, null);
  assert.equal(validateDailyTablePayload(short, auxiliaryCapture, "辅助来源").table!.rows.length, 0);
  const ambiguous = structuredClone(short);
  ambiguous.rows = [ambiguous.rows[0]!];
  for (const name of ["万家纳指", "万家纳指A/C", "万家纳斯达克科技A", "万家纳指ETF联接A", "南方纳指A"]) {
    ambiguous.rows[0]!.fundName = name;
    assert.equal(validateDailyTablePayload(ambiguous, auxiliaryCapture, "辅助来源", catalog).table!.rows.length, 0, name);
  }
  ambiguous.rows[0]!.fundName = "万家纳指A";
  const conflicting = ambiguous.rows[0]! as Record<string, unknown>;
  conflicting.fundCode = "019442";
  assert.equal(validateDailyTablePayload(ambiguous, auxiliaryCapture, "辅助来源", catalog).table!.rows.length, 0);
  const invented = { ...short, dateContext: "10月21日今日生效额度" };
  assert.deepEqual(validateDailyTablePayload(invented, auxiliaryCapture, "辅助来源", catalog).issues, ["TABLE_TEXT_DATE_NOT_IN_SOURCE"]);
});

test("the verified primary scope requires all 41 Nasdaq-100 shares and preserves source footnotes", async (t) => {
  const raw = payload();
  raw.rows = raw.rows.filter((row) => PRIMARY_DAILY_FUND_CODES.includes(row.fundCode as typeof PRIMARY_DAILY_FUND_CODES[number]));
  const starred = raw.rows.find((row) => row.fundCode === "018043")!;
  starred.directLimit = "100*";
  const dagger = raw.rows.find((row) => row.fundCode === "019441")!;
  dagger.distributorLimit = "10†";
  dagger.directLimit = "100†";
  raw.rows.find((row) => row.fundCode === "160213")!.return1y = "12.69%‡";
  const notes = ["额度：元/日", "*渠道可能分歧", "†合并限额", "‡收益来源分歧"];
  const primaryPayload = { ...raw, notes };
  const result = validateDailyTablePayload(primaryPayload, capture, "美基搭子", [], PRIMARY_DAILY_FUND_CODES);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.table!.rows.length, 41);
  assert.deepEqual(result.table!.notes, notes);
  assert.equal(result.table!.rows.find((row) => row.fundCode === "019441")!.distributorLimit, "10†");
  assert.equal(result.table!.rows.find((row) => row.fundCode === "160213")!.return1y, "12.69%‡");
  const out = await directory(t);
  assert.equal((await publishDailyTable(result.table!, out, PRIMARY_DAILY_FUND_CODES)).status, "PUBLISHED");
  const before = await readFile(join(out, "latest.json"), "utf8");
  const incomplete = structuredClone(primaryPayload);
  incomplete.rows.pop();
  const missing = validateDailyTablePayload(incomplete, capture, "美基搭子", [], PRIMARY_DAILY_FUND_CODES);
  assert.equal(missing.status, "INCOMPLETE");
  await assert.rejects(publishDailyTable(missing.table!, out, PRIMARY_DAILY_FUND_CODES), /TABLE_INCOMPLETE_NOT_PUBLISHED/);
  assert.equal(await readFile(join(out, "latest.json"), "utf8"), before);
  const extra = payload();
  assert.equal(validateDailyTablePayload(extra, capture, "美基搭子", [], PRIMARY_DAILY_FUND_CODES).status, "INCOMPLETE");
  // Primary-source 10† remains unchanged even when both short-post sources say 5.
  const auxiliary = structuredClone(result.table!);
  auxiliary.rows.find((row) => row.fundCode === "019441")!.distributorLimit = "5";
  const comparison = compareDailyTables(result.table!, auxiliary);
  assert.equal(comparison.differences.length, 1);
  assert.equal(result.table!.rows.find((row) => row.fundCode === "019441")!.distributorLimit, "10†");
  const correctedNotes = { ...result.table!, notes: [...notes, "以公告及下单页为准"] };
  assert.equal((await publishDailyTable(correctedNotes, out, PRIMARY_DAILY_FUND_CODES)).status, "PUBLISHED");
});


test("future-effective transitions cannot silently become today's amount, including cached payloads", async (t) => {
  for (const value of ["10→5（明日起）", "10元下调至5元，后天生效", "10→5（2026-10-22日起）", "10→5（2026-10-22日实施）", "10→5（10月22日起）", "5（下周起）"]) {
    assert.throws(() => currentLimit(value, "2026-10-21"), /LIMIT_(FUTURE_EFFECTIVE|EFFECTIVE_DATE_UNVERIFIED)/, value);
  }
  assert.equal(currentLimit("10→5（2026-10-21日起）", "2026-10-21"), "5（2026-10-21日起）");
  assert.throws(() => currentLimit("10→5（1月1日起）", "2026-12-31"), /LIMIT_EFFECTIVE_DATE_UNVERIFIED/);
  assert.equal(currentLimit("10†", "2026-10-21"), "10†");
  const raw = payload();
  raw.rows[0]!.distributorLimit = "10→5（明日起）";
  const result = validateDailyTablePayload(raw, capture, "主来源");
  assert.equal(result.status, "INCOMPLETE");
  assert.ok(result.issues.includes("TABLE_ROW_VALUE_INVALID:040046"));
  assert.equal(result.table!.rows.some((row) => row.fundCode === "040046"), false);
  const out = await directory(t);
  await publishDailyTable(table(), out);
  const before = await readFile(join(out, "latest.json"), "utf8");
  const forged = table();
  forged.rows[0]!.distributorLimit = "10→5（明日起）";
  await assert.rejects(publishDailyTable(forged, out), /TABLE_INCOMPLETE_NOT_PUBLISHED/);
  assert.equal(await readFile(join(out, "latest.json"), "utf8"), before);
});

test("a source fee without a percent unit stays null without discarding independently valid quota cells", () => {
  const raw = payload();
  raw.rows[0]!.feeRate = "0.66";
  const result = validateDailyTablePayload(raw, capture, "source");
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.table!.rows[0]!.feeRate, null);
  assert.equal(result.table!.rows[0]!.distributorLimit, "10");
  assert.ok(result.issues.includes("TABLE_METRIC_VALUE_INVALID:040046:feeRate"));
});

test("reviewed source abbreviations require their author, explicit code and matching share; source typos do not manufacture codes", () => {
  const raw = payload(); raw.rows = [raw.rows[0]!]; raw.rows[0]!.fundName = "华安·纳斯达克100";
  const sourceCapture = { ...capture, authorId: "6715dd2d000000001d02255b" };
  const result = validateDailyTablePayload(raw, sourceCapture, "纳指雷达", DAILY_FUND_CATALOG, PRIMARY_DAILY_FUND_CODES);
  assert.equal(result.table!.rows[0]!.fundCode, "040046");
  assert.equal(result.table!.rows[0]!.fundName, DAILY_FUND_CATALOG.find((fund) => fund.code === "040046")!.name);
  assert.equal(validateDailyTablePayload(raw, capture, "other", DAILY_FUND_CATALOG, PRIMARY_DAILY_FUND_CODES).table!.rows.length, 0);
  raw.rows[0]!.fundName = "华安·纳斯达克100C";
  assert.equal(validateDailyTablePayload(raw, sourceCapture, "纳指雷达", DAILY_FUND_CATALOG, PRIMARY_DAILY_FUND_CODES).table!.rows.length, 0);
  raw.rows[0]!.fundCode = "019525"; raw.rows[0]!.fundName = "华泰柏瑞纳斯达克100ETF联接(QDII)I";
  assert.equal(validateDailyTablePayload(raw, { ...capture, authorId: "633116cc000000002303dcaa" }, "纳普", DAILY_FUND_CATALOG, PRIMARY_DAILY_FUND_CODES).table!.rows.length, 0);
  raw.rows[0]!.fundCode = "160213"; raw.rows[0]!.fundName = "国泰纳斯达克100ETF联接(QDII)";
  assert.equal(validateDailyTablePayload(raw, { ...capture, authorId: "633116cc000000002303dcaa" }, "纳普", DAILY_FUND_CATALOG, PRIMARY_DAILY_FUND_CODES).table!.rows.length, 0);
});

test("cell unit evidence requires a real image, an explicit daily CNY phrase and the matching fund/channel", () => {
  const evidenceCapture = { ...capture, images: [{ ordinal: 0, sourceUrl: "https://a.xhscdn.com/unit.png", file: "image-0.png", mediaType: "image/png", size: 100, sha256: "a".repeat(64) }] };
  const raw = payload();
  const first = raw.rows[0]! as Record<string, unknown>;
  first.unitContext = { directLimit: { text: "每人每交易日100元", imageOrdinal: 0 } };
  let result = validateDailyTablePayload(raw, evidenceCapture, "source");
  assert.equal(result.unitContexts?.["040046"]?.directLimit?.imageSha256, "a".repeat(64));
  assert.equal(result.unitContexts?.["040046"]?.distributorLimit, undefined);
  assert.equal(result.table!.rows[0]!.directLimit, "100");
  for (const context of [{ text: "每日更新100元", imageOrdinal: 0 }, { text: "每日限额100元", imageOrdinal: 8 }, { text: "每日限额100美元", imageOrdinal: 0 },
    { text: "额度100元", imageOrdinal: 0 }, { text: "每日限额100", imageOrdinal: 0 },
    { text: "021000直销每日100元", imageOrdinal: 0 }, { text: "代销单日100元", imageOrdinal: 0 }]) {
    first.unitContext = { directLimit: context };
    result = validateDailyTablePayload(raw, evidenceCapture, "source");
    assert.equal(result.unitContexts?.["040046"]?.directLimit, undefined);
    assert.ok(result.issues.some((issue) => issue.startsWith("TABLE_UNIT_CONTEXT")));
    assert.equal(result.table!.rows[0]!.directLimit, "100");
  }
});
