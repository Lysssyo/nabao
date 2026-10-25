import test from "node:test";
import assert from "node:assert/strict";
import { DAILY_FUND_CATALOG } from "../src/daily-fund-catalog.js";
import { PRIMARY_DAILY_FUND_CODES, validateDailyTablePayload } from "../src/daily-table.js";
import type { NoteCapture } from "../src/types.js";

// Transcribed from 纳宝's 2026-10-23 image-0/1/2: codes are printed in a separate column.
// The technology rows remain in the fixture so validation must exclude them, not silently relabel them.
const printedRows = [
  ["000834", "大成纳斯达克100(QDII)A"], ["008971", "大成纳斯达克100(QDII)C"],
  ["016452", "南方纳斯达克100指数(QDII)A"], ["016453", "南方纳斯达克100指数(QDII)C"],
  ["021000", "南方纳斯达克100指数(QDII)I"], ["022525", "天弘纳斯达克100指数(QDII)D"],
  ["019524", "华泰柏瑞纳斯达克100(QDII)A"], ["019525", "华泰柏瑞纳斯达克100(QDII)C"],
  ["022664", "华泰柏瑞纳斯达克100(QDII)I"], ["019736", "宝盈纳斯达克100指数(QDII)A"],
  ["019737", "宝盈纳斯达克100指数(QDII)C"], ["019441", "万家纳斯达克100指数(QDII)A"],
  ["019442", "万家纳斯达克100指数(QDII)C"], ["539001", "建信纳斯达克100指数(QDII)A"],
  ["012752", "建信纳斯达克100指数(QDII)C"], ["023422", "建信纳斯达克100指数(QDII)D"],
  ["019172", "摩根纳斯达克100指数(QDII)A"], ["019173", "摩根纳斯达克100指数(QDII)C"],
  ["017091", "景顺长城纳斯达克科技(QDII)A"], ["017093", "景顺长城纳斯达克科技(QDII)C"],
  ["019118", "景顺长城纳斯达克科技(QDII)E"], ["015299", "华夏纳斯达克100(QDII)A"],
  ["015300", "华夏纳斯达克100(QDII)C"], ["040046", "华安纳斯达克100(QDII)A"],
  ["014978", "华安纳斯达克100(QDII)C"], ["016055", "博时纳斯达克100(QDII)A"],
  ["016057", "博时纳斯达克100(QDII)C"], ["024237", "博时纳斯达克100(QDII)I"],
  ["016532", "嘉实纳斯达克100(QDII)A"], ["016533", "嘉实纳斯达克100(QDII)C"],
  ["021838", "嘉实纳斯达克100(QDII)I"], ["160213", "国泰纳斯达克100指数"],
  ["018043", "天弘纳斯达克100指数(QDII)A"], ["018044", "天弘纳斯达克100指数(QDII)C"],
  ["270042", "广发纳斯达克100(QDII)A"], ["006479", "广发纳斯达克100(QDII)C"],
  ["021778", "广发纳指100(QDII)F"], ["019547", "招商纳斯达克100(QDII)A"],
  ["019548", "招商纳斯达克100(QDII)C"], ["161130", "易方达纳斯达克100QDII-LOFA"],
  ["012870", "易方达纳斯达克100QDII-LOFC"], ["018966", "汇添富纳斯达克100(QDII)A"],
  ["018967", "汇添富纳斯达克100(QDII)C"], ["021773", "汇添富纳斯达克100(QDII)E"],
] as const;
const capture: NoteCapture = {
  authorId: "64ea885c0000000001004087", noteId: "6ada2168000000002403641d",
  evidenceRef: "https://www.xiaohongshu.com/explore/6ada2168000000002403641d",
  title: "2026年10月23日纳斯达克限额一览", body: "2026年10月23日纳斯达克限额一览",
  sourcePublishedAt: "2026-10-23T00:00:00Z", sourceUpdatedAt: null, capturedAt: "2026-10-23T02:00:00Z",
  captureStatus: "success", expectedImageCount: 3, images: [], issues: [], revision: null,
};
const row = (fundCode: string | null, fundName: string) => ({
  fundCode, fundName, feeRate: null, trackingError: null, return1y: null,
  distributorLimit: "未明确", directLimit: "未明确", mergedLimit: null,
});
function validate(rows: ReturnType<typeof row>[], authorId = capture.authorId) {
  return validateDailyTablePayload({
    dataDateText: "2026年10月23日", dateContext: "2026年10月23日纳斯达克限额一览",
    pageDates: ["2026年10月23日", "2026年10月23日", "2026年10月23日"], notes: [], rows,
  }, { ...capture, authorId }, "source", DAILY_FUND_CATALOG, PRIMARY_DAILY_FUND_CODES);
}

test("reviewed code/name pairs recover all 41 Nasdaq-100 shares from the printed 44-row table", () => {
  const result = validate(printedRows.map(([code, name]) => row(code, name)));
  assert.equal(result.table!.rows.length, 41);
  assert.deepEqual(result.table!.rows.map((entry) => entry.fundCode).sort(), [...PRIMARY_DAILY_FUND_CODES].sort());
  for (const entry of result.table!.rows) {
    assert.equal(entry.fundName, DAILY_FUND_CATALOG.find((fund) => fund.code === entry.fundCode)!.name);
  }
  assert.deepEqual(result.issues, Array(3).fill("TABLE_CODE_NAME_OR_DUPLICATE_INVALID"));
  const onlyNasdaq100 = printedRows.filter(([code]) => PRIMARY_DAILY_FUND_CODES.includes(code as typeof PRIMARY_DAILY_FUND_CODES[number]));
  assert.equal(validate(onlyNasdaq100.map(([code, name]) => row(code, name))).status, "COMPLETE");
});

test("reviewed abbreviations cannot infer codes, cross authors or repair a wrong company, share or index", () => {
  for (const authorId of ["6168030000000000020278b5", "aaaaaaaaaaaaaaaaaaaaaaaa"]) {
    assert.equal(validate([row("040046", "华安纳斯达克100(QDII)A")], authorId).table!.rows.length, 0);
  }
  for (const candidate of [
    row(null, "华安纳斯达克100(QDII)A"),
    row("014978", "华安纳斯达克100(QDII)A"),
    row("040046", "华安纳斯达克100(QDII)C"),
    row("000834", "华安纳斯达克100(QDII)A"),
    row("040046", "华安标普500(QDII)A"),
    row("040046", "华安纳斯达克科技(QDII)A"),
    row("017091", "景顺长城纳斯达克科技(QDII)A"),
  ]) {
    assert.equal(validate([candidate]).table!.rows.length, 0, JSON.stringify(candidate));
  }
  // The similar-looking code typo from another author must still fail, as must its unsupported product name.
  assert.equal(validate([row("019525", "华泰柏瑞纳斯达克100ETF联接(QDII)I")], "633116cc000000002303dcaa").table!.rows.length, 0);
  assert.equal(validate([row("160213", "国泰纳斯达克100ETF联接(QDII)")], "633116cc000000002303dcaa").table!.rows.length, 0);
});

test("Radar's full ETF/index A/C labels match the currency-free catalog and retain code, share and index", () => {
  // These 16 code/name pairs are printed in the 2026-10-23 A/C tables, without 人民币.
  const pairs = [
    ["016532", "嘉实纳斯达克100ETF联接A"], ["019172", "摩根纳斯达克100指数A"],
    ["161130", "易方达纳斯达克100ETF联接A"], ["016055", "博时纳斯达克100ETF联接A"],
    ["018966", "汇添富纳斯达克100ETF联接A"], ["019736", "宝盈纳斯达克100指数A"],
    ["270042", "广发纳斯达克100ETF联接A"], ["539001", "建信纳斯达克100指数A"],
    ["016533", "嘉实纳斯达克100ETF联接C"], ["012870", "易方达纳斯达克100ETF联接C"],
    ["019173", "摩根纳斯达克100指数C"], ["019737", "宝盈纳斯达克100指数C"],
    ["016057", "博时纳斯达克100ETF联接C"], ["018967", "汇添富纳斯达克100ETF联接C"],
    ["006479", "广发纳斯达克100ETF联接C"], ["012752", "建信纳斯达克100指数C"],
  ] as const;
  const authorId = "6715dd2d000000001d02255b";
  const result = validate(pairs.map(([code, name]) => row(code, name)), authorId);
  assert.equal(result.table!.rows.length, pairs.length);
  assert.deepEqual(result.table!.rows.map((entry) => entry.fundCode), pairs.map(([code]) => code));
  for (const [code, name] of pairs) {
    // These are now full canonical identities after omitting the redundant RMB label.
    assert.equal(validate([row(null, name)], authorId).table!.rows[0]!.fundCode, code);
    assert.equal(validate([row(code, name)], "aaaaaaaaaaaaaaaaaaaaaaaa").table!.rows[0]!.fundCode, code);
    const wrongShare = name.slice(0, -1) + (name.endsWith("A") ? "C" : "A");
    assert.equal(validate([row(code, wrongShare)], authorId).table!.rows.length, 0);
  }
  assert.equal(validate([row("161130", "易方达纳斯达克100指数A")], authorId).table!.rows.length, 0);
  assert.equal(validate([row("017091", "景顺长城纳斯达克科技A"), row("017093", "景顺长城纳斯达克科技C")], authorId).table!.rows.length, 0);
});

test("catalog display names omit RMB while both original currency labels and omitted labels keep the same identities", () => {
  assert.ok(DAILY_FUND_CATALOG.every((fund) => !fund.name.includes("人民币") && !fund.name.includes("()")));
  for (const suffix of ["", "（人民币）"]) {
    const result = validate(DAILY_FUND_CATALOG.map((fund) => row(fund.code, fund.name + suffix)), "aaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(result.status, "COMPLETE");
    assert.deepEqual(result.table!.rows.map((entry) => ({ code: entry.fundCode, name: entry.fundName })), DAILY_FUND_CATALOG);
  }
  assert.equal(validate([row("019172", "摩根纳斯达克100指数(QDII)美元A")]).table!.rows.length, 0);
  assert.equal(validate([row("016532", "嘉实纳斯达克100ETF联接(QDII)C人民币")]).table!.rows.length, 0);
});

test("author-only abbreviated source names still require that author and an explicit code", () => {
  for (const [code, name] of [["016532", "嘉实·纳斯达克100"], ["019172", "摩根·纳斯达克100指数"]]) {
    assert.equal(validate([row(code!, name!)], "6715dd2d000000001d02255b").table!.rows[0]?.fundCode, code);
    assert.equal(validate([row(null, name!)], "6715dd2d000000001d02255b").table!.rows.length, 0);
    assert.equal(validate([row(code!, name!)], "aaaaaaaaaaaaaaaaaaaaaaaa").table!.rows.length, 0);
    assert.equal(validate([row("000834", name!)], "6715dd2d000000001d02255b").table!.rows.length, 0);
  }
});
