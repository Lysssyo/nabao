import test from "node:test";
import assert from "node:assert/strict";
import { amountMinor, normalizeRows } from "../src/normalize.js";
import { canonicalFundName, parseFundCatalog, resolveFund, type Fund } from "../src/catalog.js";
import { reviewedFundAliases } from "../src/fund-aliases.js";
import { validateModelRows, type CandidateRow } from "../src/model-schema.js";
import type { NoteCapture } from "../src/types.js";

const funds: Fund[] = [
  { code: "016452", name: "南方纳斯达克100指数发起(QDII)A" },
  { code: "016453", name: "南方纳斯达克100指数发起(QDII)C" },
  { code: "021000", name: "南方纳斯达克100指数发起(QDII)I" },
  { code: "018043", name: "天弘纳斯达克100指数发起(QDII)A" },
  { code: "022525", name: "天弘纳斯达克100指数发起(QDII)D" },
  { code: "019172", name: "摩根纳斯达克100指数(QDII)人民币A" },
  { code: "019174", name: "摩根纳斯达克100指数(QDII)美元现汇A" },
  { code: "040046", name: "华安纳斯达克100ETF联接(QDII)A" },
  { code: "040047", name: "华安纳斯达克100ETF联接(QDII)A美元现钞" },
  { code: "040048", name: "华安纳斯达克100ETF联接(QDII)A美元现汇" },
  { code: "017091", name: "景顺长城纳斯达克科技ETF联接(QDII)A人民币" },
  { code: "096001", name: "大成标普500等权重指数(QDII)A人民币" },
];
const capture: NoteCapture = {
  authorId: "6168030000000000020278b5", noteId: "aaaaaaaaaaaaaaaaaaaaaaaa",
  evidenceRef: "https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa",
  capturedAt: "2026-10-20T02:00:00Z", sourcePublishedAt: "2026-10-20T01:00:00Z", sourceUpdatedAt: null,
  title: "公开额度表", body: "2026-10-20 额度更新", expectedImageCount: 1, images: [],
  revision: "a".repeat(64), captureStatus: "success", issues: [],
};
const row: CandidateRow = {
  fundName: "南方纳斯达克100指数(QDII)A", fundCode: "016452",
  channelScope: "DISTRIBUTOR", businessType: "UNSPECIFIED", period: "UNSPECIFIED",
  limitKind: "LIMITED", rawAmount: "10元", currency: "CNY", observedForDate: "2026-10-20",
  evidenceLocation: "image:1,row:3", evidenceText: "2026-10-20 016452 南方纳斯达克100指数(QDII)A 代销10元",
};

test("identical image sets share a vote origin even when a repost changes text or order", () => {
  const images = ["a", "b"].map((value, ordinal) => ({
    ordinal, sourceUrl: `https://sns-webpic-qc.xhscdn.com/${value}.png`, file: `image-${ordinal}.png`,
    sha256: value.repeat(64), mediaType: "image/png", size: 100,
  }));
  const first = normalizeRows([row], { ...capture, images }, funds).items[0]!;
  const repost = normalizeRows([row], { ...capture, title: "另一标题", images: [...images].reverse() }, funds).items[0]!;
  const other = normalizeRows([row], { ...capture, images: [{ ...images[0]!, sha256: "c".repeat(64) }] }, funds).items[0]!;
  assert.ok(first.sourceGroupId);
  assert.equal(first.sourceGroupId, repost.sourceGroupId);
  assert.notEqual(first.sourceGroupId, other.sourceGroupId);
});

test("published evidence uses usable public share links or the observed signed note route", () => {
  const known = normalizeRows([row], { ...capture, noteId: "6ad72ff5000000002f02a03a" }, funds).items[0]!;
  assert.equal(known.evidenceRef, "https://xhslink.cn/o/AOWRFQbysRr");
  const openUrl = `${capture.evidenceRef}?xsec_token=test-public-signature&xsec_source=pc_user`;
  assert.equal(normalizeRows([row], { ...capture, openUrl }, funds).items[0]!.evidenceRef, openUrl);
  assert.equal(normalizeRows([row], { ...capture, openUrl: "https://unrelated.example/test" }, funds).items[0]!.evidenceRef, capture.evidenceRef);
});

test("catalog is parsed as data, preserves leading zeroes, and rejects script or duplicate identities", () => {
  const text = `var r = ${JSON.stringify(funds.map((fund) => [fund.code, "abbr", fund.name, "股票指数", "pinyin"]))};`;
  assert.deepEqual(parseFundCatalog(text), funds);
  assert.throws(() => parseFundCatalog(`${text} globalThis.executed = true;`));
  assert.throws(() => parseFundCatalog('var r = [[16452,"","基金A"]];'), /CATALOG_ROW_INVALID/);
  assert.throws(() => parseFundCatalog('var r = [["016452","","基金A"],["016452","","基金C"]];'), /CATALOG_DUPLICATE_CODE/);
  assert.throws(() => parseFundCatalog('var r = [];'), /CATALOG_FORMAT_INVALID/);
});

test("harmless punctuation and product descriptors normalize but share identity remains exact", () => {
  assert.equal(resolveFund(null, "南方 纳斯达克100指数发起式（QDII） A", funds)?.code, "016452");
  assert.equal(resolveFund("016452", "南方纳指100指数A", funds)?.code, "016452");
  assert.equal(resolveFund("016452", "南方纳斯达克100指数(QDII)C", funds), null);
  assert.equal(resolveFund(null, "南方纳斯达克100指数I", funds)?.code, "021000");
  assert.equal(resolveFund(null, "天弘纳斯达克100指数D", funds)?.code, "022525");
  assert.equal(resolveFund(null, "南方纳斯达克100指数A/C", funds), null);
  assert.equal(resolveFund(null, "南方纳指A", funds), null);
});

test("ETF connection, index category and weighting are not erased during name matching", () => {
  assert.equal(resolveFund(null, "华安纳斯达克100指数A", funds), null);
  assert.equal(resolveFund(null, "景顺长城纳斯达克100ETF联接A人民币", funds), null);
  assert.equal(resolveFund(null, "景顺长城纳斯达克科技ETF联接A人民币", funds)?.code, "017091");
  assert.equal(resolveFund(null, "大成标普500指数A人民币", funds), null);
  assert.equal(resolveFund(null, "大成标普500等权重指数A人民币", funds)?.code, "096001");
});

test("missing currency never silently chooses CNY over USD or cash over remittance", () => {
  assert.equal(resolveFund(null, "摩根纳斯达克100指数A", funds), null);
  assert.equal(resolveFund(null, "摩根纳斯达克100指数A", funds, "CNY")?.code, "019172");
  assert.equal(resolveFund(null, "摩根纳斯达克100指数美元现汇A", funds)?.code, "019174");
  assert.equal(resolveFund("019174", "摩根纳斯达克100指数人民币A", funds), null);
  assert.equal(resolveFund("019174", "摩根纳斯达克100指数A", funds, "CNY"), null);
  assert.equal(resolveFund(null, "华安纳斯达克100ETF联接A美元", funds, "USD"), null);
  assert.equal(resolveFund(null, "华安纳斯达克100ETF联接A美元现钞", funds)?.code, "040047");
  assert.equal(resolveFund(null, "华安纳斯达克100ETF联接美元汇A", funds)?.code, "040048");
  assert.notEqual(canonicalFundName("基金人民币A"), canonicalFundName("基金美元A"));
});

test("a missing share suffix must not uniquely select the catalog's unsuffixed USD product", () => {
  const sameFamily: Fund[] = [
    { code: "001668", name: "汇添富全球移动互联混合(QDII)人民币A" },
    { code: "014440", name: "汇添富全球移动互联混合(QDII)人民币C" },
    { code: "006426", name: "汇添富全球移动互联混合(QDII)美元现汇" },
  ];
  assert.equal(resolveFund(null, "汇添富全球移动互联混合", sameFamily), null);
  assert.equal(resolveFund(null, "汇添富全球移动互联混合美元现汇", sameFamily)?.code, "006426");
  assert.equal(resolveFund("006426", "汇添富全球移动互联混合", sameFamily)?.code, "006426");
  assert.equal(resolveFund("006426", "汇添富全球移动互联混合", sameFamily, "CNY"), null);
});

test("ambiguous normalized catalog names and a conflicting supplied code stay unresolved", () => {
  const ambiguous = [...funds, { code: "999999", name: "南方纳斯达克100指数型发起式(QDII)A" }];
  assert.equal(resolveFund(null, row.fundName, ambiguous), null);
  assert.equal(resolveFund("016452", row.fundName, ambiguous)?.code, "016452");
  assert.equal(resolveFund("018043", row.fundName, funds), null);
  assert.equal(resolveFund("16452", row.fundName, funds), null);
});

test("reviewed source aliases require their explicit code, exact short name, and unchanged catalog name", () => {
  const catalog = reviewedFundAliases.map((alias) => ({ code: alias.code, name: alias.catalogName }));
  assert.equal(reviewedFundAliases.length, 49);
  for (const alias of reviewedFundAliases) {
    assert.equal(resolveFund(alias.code, alias.sourceName, catalog)?.code, alias.code);
    assert.equal(resolveFund(null, alias.sourceName, catalog), null, alias.sourceName);
    assert.equal(resolveFund(alias.code, alias.sourceName + "特别版", catalog), null);
    const changed = catalog.map((fund) => fund.code === alias.code ? { ...fund, name: fund.name + "新版" } : fund);
    assert.equal(resolveFund(alias.code, alias.sourceName, changed), null);
  }
  assert.equal(resolveFund("008971", "大成纳斯达克100(QDII)A", catalog), null);
  assert.equal(resolveFund("000834", "南方纳斯达克100指数(QDII)A", catalog), null);
  assert.equal(resolveFund("001668", "汇添富全球移动互联混合", catalog, "USD"), null);
});

test("amount parsing is exact in minor units and agrees with supported schema notation", () => {
  const cases: [string, number][] = [
    ["0", 0], ["10", 1000], ["10.01元", 1001], ["1.5万", 1_500_000],
    ["¥1,000.25", 100025], ["￥10RMB", 1000], ["$10.50USD", 1050],
    ["1亿元", 10_000_000_000], ["0.01万元", 10_000], ["10美元", 1000],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(amountMinor(raw), expected, raw);
    const parsed = validateModelRows({ rows: [{ ...row, rawAmount: raw }], issues: [] }, 1);
    assert.equal(parsed.rows.length, 1, raw);
  }
  for (const invalid of ["1,00", "-1", "10.001", "1e3", "暂停", "部分渠道100", "999999999999999999亿", "NaN"]) {
    assert.equal(amountMinor(invalid), null, invalid);
  }
});

test("normalization attaches trusted capture metadata and preserves unknown business scope", () => {
  const result = normalizeRows([row], capture, funds);
  assert.deepEqual(result.issues, []);
  const item = result.items[0]!;
  assert.equal(item.authorId, capture.authorId);
  assert.equal(item.noteRevision, capture.revision);
  assert.equal(item.sourcePublishedAt, capture.sourcePublishedAt);
  assert.equal(item.capturedAt, capture.capturedAt);
  assert.equal(item.amountMinor, 1000);
  assert.equal(item.businessType, "UNSPECIFIED");
  assert.equal(item.period, "UNSPECIFIED");
  assert.equal(item.fundName, funds[0]!.name);
});

test("unknown codes can be uniquely resolved per explicit share without model-made codes", () => {
  const result = normalizeRows([
    { ...row, fundCode: null, fundName: "南方纳斯达克100指数A" },
    { ...row, fundCode: null, fundName: "南方纳斯达克100指数C" },
  ], capture, funds);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.items.map((item) => item.fundCode), ["016452", "016453"]);
});

test("conflicting rows remove all values for that note and scope; repetitions add no votes", () => {
  const result = normalizeRows([
    row,
    { ...row, rawAmount: "100元" },
    row,
    { ...row, channelScope: "DIRECT" },
    { ...row, channelScope: "DIRECT" },
  ], capture, funds);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.channelScope, "DIRECT");
  assert.equal(result.issues.filter((item) => item.code === "ROW_CONFLICT").length, 1);
});

test("currency contradictions and non-numeric statuses cannot become successful quota rows", () => {
  const result = normalizeRows([
    { ...row, rawAmount: "$10", currency: "CNY" },
    { ...row, rawAmount: "￥10美元", currency: "UNSPECIFIED" },
    { ...row, limitKind: "PAUSED", rawAmount: "0" },
    { ...row, limitKind: "PAUSED", rawAmount: null },
  ], capture, funds);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.limitKind, "PAUSED");
  assert.equal(result.items[0]!.amountMinor, null);
  assert.equal(result.issues.filter((item) => item.code === "CURRENCY_CONFLICT").length, 2);
  assert.ok(result.issues.some((item) => item.code === "STATUS_AMOUNT_CONFLICT"));
});

test("missing date or metadata leaves candidates unpublished", () => {
  assert.equal(normalizeRows([{ ...row, observedForDate: null }], capture, funds).items.length, 0);
  assert.equal(normalizeRows([row], { ...capture, sourcePublishedAt: null }, funds).items.length, 0);
  assert.equal(normalizeRows([{ ...row, observedForDate: "2026-02-31" }], capture, funds).items.length, 0);
});
