import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { voteDailyTables, olderPublication, type SourceTable } from "../src/daily-table-voting.js";
import { PRIMARY_DAILY_FUND_CODES, publishDailyTable, type DailyTableRow } from "../src/daily-table.js";
import { dailyTableFromReport } from "../src/daily-table-run.js";
import { sources } from "../src/sources.js";

const ids = ["a", "b", "c", "d", "e"].map((id) => id.repeat(24));
function input(author: number, patch: Partial<DailyTableRow> = {}, options: { day?: string; time?: string; note?: string; notes?: string[] } = {}): SourceTable {
  const dataDate = options.day ?? "2026-10-21";
  const noteId = options.note ?? `${author}`.repeat(24);
  const time = options.time ?? "2026-10-21T02:00:00Z";
  return { authorId: ids[author]!, capture: { authorId: ids[author]!, noteId, title: "纳指限额一览", body: "2026-10-21纳指限额",
    evidenceRef: `https://www.xiaohongshu.com/explore/${noteId}`, sourcePublishedAt: time, sourceUpdatedAt: null,
    capturedAt: "2026-10-21T06:00:00Z", revision: `revision-${author}-${time}`, captureStatus: "success", images: [], expectedImageCount: 0, issues: [] },
  table: { schemaVersion: 1, dataDate, updatedAt: "2026-10-21T06:00:00Z", source: { name: `source-${author}`, url: `https://www.xiaohongshu.com/explore/${noteId}`, publishedAt: time },
    notes: options.notes ?? ["额度：元/日", "收益截至2026-10-20", "跟踪误差截至2026-10-20"],
    rows: [{ fundCode: "019441", fundName: "万家纳斯达克100指数A", feeRate: "0.65%", distributorLimit: "10", directLimit: "100", trackingError: "2.1%", return1y: "15.0%", ...patch }] } };
}
const row = (result: ReturnType<typeof voteDailyTables>) => result.table?.rows.find((row) => row.fundCode === "019441");

test("five authors vote each field independently; a unique two-vote plurality defeats isolated votes", () => {
  const result = voteDailyTables([input(0, { distributorLimit: "5", directLimit: "50" }), input(1, { distributorLimit: "5" }),
    input(2), input(3, { distributorLimit: "20" }), input(4, { distributorLimit: "30", directLimit: "50" })], "2026-10-21", ids);
  assert.equal(row(result)!.distributorLimit, "5");
  assert.equal(row(result)!.directLimit, "100");
  assert.equal(row(result)!.feeRate, "0.65%");
  assert.equal(result.table!.rows.length, 41);
  assert.equal(result.table!.source.name, "公开额度汇总");
  assert.equal(result.table!.rows[0]!.fundName.includes("source"), false);
  assert.deepEqual(Object.keys(result.table!), ["schemaVersion", "dataDate", "updatedAt", "source", "rows", "notes"]);
});

test("2-2 ties stay pending while single-source fields are adopted", () => {
  const result = voteDailyTables([input(0, { distributorLimit: "5", feeRate: null }), input(1, { distributorLimit: "5", feeRate: null }),
    input(2), input(3, { feeRate: null }), input(4, { distributorLimit: "未明确", feeRate: null })], "2026-10-21", ids);
  assert.equal(row(result)!.distributorLimit, "待更新");
  assert.equal(row(result)!.feeRate, "0.65%");
  assert.equal(result.decisions.find((item) => item.fundCode === "019441" && item.field === "distributorLimit")!.status, "TIE");
});

test("old days and unconfigured authors never top up today's votes; all unknown has no public table", () => {
  const single = voteDailyTables([input(0), input(1, {}, { day: "2026-10-20" }), input(4)], "2026-10-21", ids.slice(0, 4));
  assert.equal(row(single)!.distributorLimit, "10");
  assert.equal(single.decisions.find(item => item.fundCode === "019441" && item.field === "distributorLimit")!.votes.length, 1);
  const unknown = { feeRate: null, distributorLimit: "未明确", directLimit: "待更新", return1y: null, trackingError: null };
  assert.equal(voteDailyTables([input(0, unknown), input(1, unknown)], "2026-10-21", ids).table, null);
});

test("repeated dash placeholders and explicit unknown labels never form votes, while business statuses remain values", () => {
  for (const value of ["——", "———", "---", "–—", "_", "未标注", "未注明", "待确认"]) {
    const result = voteDailyTables([input(0, { distributorLimit: value }), input(1, { distributorLimit: value })], "2026-10-21", ids);
    assert.equal(row(result)!.distributorLimit, "待更新", value);
    assert.equal(result.decisions.find((item) => item.fundCode === "019441" && item.field === "distributorLimit")!.votes.length, 0);
  }
  for (const value of ["无", "无代销", "暂停", "0"]) {
    assert.equal(row(voteDailyTables([input(0, { distributorLimit: value }), input(1, { distributorLimit: value })], "2026-10-21", ids))!.distributorLimit, value === "暂停" ? "暂停申购" : value);
  }
});

test("same author corrects one vote; an unrelated later short post does not erase mentioned earlier fields", () => {
  const older = input(0, {}, { time: "2026-10-21T01:00:00Z", note: "f".repeat(24) });
  const latest = input(0, { distributorLimit: "5", directLimit: "未明确", feeRate: null, return1y: null, trackingError: null });
  const result = voteDailyTables([older, latest, input(1, { distributorLimit: "5" }), input(2)], "2026-10-21", ids);
  assert.equal(row(result)!.distributorLimit, "5");
  assert.equal(row(result)!.directLimit, "100");
  assert.equal(result.decisions.find((item) => item.fundCode === "019441" && item.field === "distributorLimit")!.votes.length, 3);
});

test("explicit withdrawal suppresses that author's earlier field; deleted rows in the same revised note cannot keep voting", () => {
  const older = input(0, { distributorLimit: "5" }, { time: "2026-10-21T01:00:00Z", note: "f".repeat(24) });
  const withdrawal = input(0, { distributorLimit: "未明确" });
  withdrawal.withdrawnFields = { "019441": ["distributorLimit"] };
  const result = voteDailyTables([older, withdrawal, input(1, { distributorLimit: "5" }), input(2)], "2026-10-21", ids);
  assert.equal(row(result)!.distributorLimit, "待更新");
  const deleted = input(0); deleted.capture.sourceUpdatedAt = "2026-10-21T03:00:00Z"; deleted.table.rows = [];
  const remaining = voteDailyTables([input(0), deleted, input(1)], "2026-10-21", ids);
  assert.equal(row(remaining)!.distributorLimit, "10");
  assert.equal(remaining.decisions.find(item => item.fundCode === "019441" && item.field === "distributorLimit")!.votes.length, 1);
});

test("plain amount with explicit daily units matches 元/日, but unknown period does not", () => {
  const two = [input(0, { distributorLimit: "10元/日" }), input(1)];
  assert.equal(row(voteDailyTables(two, "2026-10-21", ids))!.distributorLimit, "10");
  two[1]!.table.notes = [];
  const result = voteDailyTables(two, "2026-10-21", ids);
  assert.equal(row(result)!.distributorLimit, "10");
  assert.equal(result.decisions.find(d => d.fundCode === "019441" && d.field === "distributorLimit")!.votes.length, 1);
  assert.equal(row(voteDailyTables([two[1]!], "2026-10-21", ids))!.distributorLimit, "待更新");
});

test("unchanged wording describes a transition, while footnotes and channel conditions still qualify values", () => {
  const a = input(0, { directLimit: "100元/日不变" });
  const b = input(1, { directLimit: "100元/日" });
  assert.equal(row(voteDailyTables([a, b], "2026-10-21", ids))!.directLimit, "100");
  a.table.rows[0]!.directLimit = "部分渠道100元/日不变";
  assert.equal(row(voteDailyTables([a, b], "2026-10-21", ids))!.directLimit, "待更新");
});

test("qualifiers, merged limits, no distributor, pause, and zero are different votes", () => {
  for (const text of ["10†", "部分渠道10", "10（未区分直代销）", "无", "暂停", "0"]) {
    const a = input(0, { distributorLimit: text }, { notes: ["额度：元/日", "†万家合并限额、渠道有差异"] });
    const result = voteDailyTables([a, input(1)], "2026-10-21", ids);
    assert.equal(row(result)!.distributorLimit, "待更新", text);
  }
  const qualified = [0, 1].map((author) => input(author, { distributorLimit: "10†" }, { notes: ["额度：元/日", "†万家合并限额、渠道有差异"] }));
  const result = voteDailyTables(qualified, "2026-10-21", ids);
  assert.equal(row(result)!.distributorLimit, "10†");
  assert.ok(result.table!.notes.some((note) => note.includes("019441 代销") && note.includes("合并限额")));
});

test("explicitly different cutoffs remain separate; missing return cutoffs abstain instead of opposing dated returns", () => {
  const a = input(0);
  const b = input(1, {}, { notes: ["额度：元/日", "收益截至2026-10-19", "跟踪误差截至2026-10-20"] });
  assert.equal(row(voteDailyTables([a, b], "2026-10-21", ids))!.return1y, null);
  assert.equal(row(voteDailyTables([a, b], "2026-10-21", ids))!.trackingError, "2.1%");
  b.table.notes = [];
  assert.equal(row(voteDailyTables([a, b], "2026-10-21", ids))!.return1y, "15%");
  assert.equal(row(voteDailyTables([a, b], "2026-10-21", ids))!.trackingError, null);
  a.table.notes = b.table.notes = [];
  assert.equal(row(voteDailyTables([a, b], "2026-10-21", ids))!.return1y, null);
  assert.equal(row(voteDailyTables([a, b], "2026-10-21", ids))!.trackingError, "2.1%");
});

test("short cutoff dates align only with the same explicit date; unmarked combined caps are not plain personal limits", () => {
  const a = input(0, {}, { notes: ["额度：元/日", "收益截至10/20"] });
  const b = input(1);
  assert.equal(row(voteDailyTables([a, b], "2026-10-21", ids))!.return1y, "15%");
  a.table.notes.push("万家代销A/C合并限额");
  const result = voteDailyTables([a, b], "2026-10-21", ids);
  assert.equal(row(result)!.distributorLimit, "待更新");
  assert.equal(row(result)!.directLimit, "100");
});

test("unit evidence affects exactly one fund and channel; scoped notes do not become global daily units", () => {
  const a = input(0, {}, { notes: [] });
  const b = input(1);
  a.unitContexts = { "019441": { directLimit: { text: "每人每交易日100元", imageOrdinal: 0, imageSha256: "a".repeat(64) } } };
  a.table.rows.push({ ...a.table.rows[0]!, fundCode: "021000", fundName: "南方纳斯达克100指数I" });
  b.table.rows.push({ ...b.table.rows[0]!, fundCode: "021000", fundName: "南方纳斯达克100指数I" });
  let result = voteDailyTables([a, b], "2026-10-21", ids);
  assert.equal(row(result)!.directLimit, "100");
  assert.equal(row(result)!.distributorLimit, "10");
  assert.equal(result.table!.rows.find((row) => row.fundCode === "021000")!.directLimit, "100");
  assert.equal(result.decisions.find(d => d.fundCode === "021000" && d.field === "directLimit")!.votes.length, 1);
  assert.ok(result.decisions.find((decision) => decision.fundCode === "019441" && decision.field === "directLimit")!.votes.some((vote) => vote.unitContext?.imageSha256 === "a".repeat(64)));
  a.unitContexts = {};
  a.table.notes = ["019441直销额度单位：元/日"];
  result = voteDailyTables([a, b], "2026-10-21", ids);
  assert.equal(row(result)!.directLimit, "100");
  assert.equal(row(result)!.distributorLimit, "10");
  assert.equal(result.table!.rows.find((row) => row.fundCode === "021000")!.directLimit, "100");
  assert.equal(result.decisions.find(d => d.fundCode === "021000" && d.field === "directLimit")!.votes.length, 1);
});

test("publication watermarks prevent same-day revision rollback and advance even without visible changes", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "nabao-vote-publish-")); t.after(() => rm(path, { recursive: true, force: true }));
  const initial = voteDailyTables([input(0), input(1)], "2026-10-21", ids);
  assert.equal((await publishDailyTable(initial.table!, path, PRIMARY_DAILY_FUND_CODES, initial.publication)).status, "PUBLISHED");
  const updatedInput = input(0); updatedInput.capture.sourceUpdatedAt = "2026-10-21T04:00:00Z"; updatedInput.capture.revision = "new-revision";
  const newer = voteDailyTables([updatedInput, input(1)], "2026-10-21", ids);
  assert.equal((await publishDailyTable(newer.table!, path, PRIMARY_DAILY_FUND_CODES, newer.publication)).status, "UNCHANGED");
  assert.equal((await publishDailyTable(initial.table!, path, PRIMARY_DAILY_FUND_CODES, initial.publication)).status, "OLDER_SKIPPED");
  assert.equal(olderPublication(initial.publication, newer.publication), true);
  assert.equal(JSON.parse(await readFile(join(path, ".daily-table-state.json"), "utf8")).revision, newer.publication.revision);
  const changed = input(0); changed.capture.sourceUpdatedAt = "2026-10-21T04:00:00Z";
  changed.capture.revision = "later-same-source-clock"; changed.capture.capturedAt = "2026-10-21T07:00:00Z";
  const later = voteDailyTables([changed, input(1)], "2026-10-21", ids);
  assert.equal(olderPublication(newer.publication, later.publication), true);
  assert.equal(olderPublication(later.publication, newer.publication), false);
});

test("removing an author recomputes today's votes and a newer configuration can publish that withdrawal", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "nabao-author-withdrawal-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const evidence = ids.map((_, index) => input(index, { distributorLimit: index < 3 ? "10" : "20" }));
  const first = voteDailyTables(evidence, "2026-10-21", ids);
  first.publication.authorConfig = { revision: 1, authorIds: ids };
  assert.equal(row(first)!.distributorLimit, "10");
  await publishDailyTable(first.table!, path, PRIMARY_DAILY_FUND_CODES, first.publication);

  // The removed author's cached observation remains in this input deliberately.
  const remaining = ids.slice(1);
  const changed = voteDailyTables(evidence, "2026-10-21", remaining);
  changed.publication.authorConfig = { revision: 2, authorIds: remaining };
  assert.equal(row(changed)!.distributorLimit, "待更新");
  assert.equal(changed.publication.watermarks.some(mark => mark.authorId === ids[0]), false);
  assert.equal((await publishDailyTable(changed.table!, path, PRIMARY_DAILY_FUND_CODES, changed.publication)).status, "PUBLISHED");
  const published = JSON.parse(await readFile(join(path, "latest.json"), "utf8"));
  assert.equal(published.rows.find((item: DailyTableRow) => item.fundCode === "019441").distributorLimit, "待更新");
  assert.equal(published.authorConfig, undefined);
  assert.equal((await publishDailyTable(first.table!, path, PRIMARY_DAILY_FUND_CODES, first.publication)).status, "OLDER_SKIPPED");
  assert.equal(olderPublication({ ...first.publication, dataDate: "2026-10-22" }, changed.publication), true,
    "an old author configuration cannot return on a later date");
});

test("author configuration changes cannot discard or regress retained authors' evidence", () => {
  const original = voteDailyTables([input(0), input(1), input(2)], "2026-10-21", ids);
  original.publication.authorConfig = { revision: 3, authorIds: ids };
  const missing = voteDailyTables([input(1), input(2)], "2026-10-21", ids);
  missing.publication.authorConfig = { revision: 4, authorIds: ids };
  assert.equal(olderPublication(missing.publication, original.publication), true);
  missing.publication.authorConfig = { revision: 3, authorIds: ids.slice(1) };
  assert.equal(olderPublication(missing.publication, original.publication), true,
    "changing the author set requires a new revision");
  const older = voteDailyTables([input(1, {}, { time: "2026-10-21T01:00:00Z" }), input(2)], "2026-10-21", ids.slice(1));
  older.publication.authorConfig = { revision: 4, authorIds: ids.slice(1) };
  assert.equal(olderPublication(older.publication, original.publication), true);
  const valid = voteDailyTables([input(1), input(2)], "2026-10-21", ids.slice(1));
  valid.publication.authorConfig = { revision: 4, authorIds: ids.slice(1) };
  assert.equal(olderPublication(valid.publication, original.publication), false);
  const legacy = { ...original.publication }; delete legacy.authorConfig;
  assert.equal(olderPublication(valid.publication, legacy), false, "existing publication state can adopt author management");
  assert.equal(olderPublication(legacy, valid.publication), true);
});

test("malformed author configuration metadata cannot change the published table", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "nabao-author-metadata-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const initial = voteDailyTables([input(0), input(1)], "2026-10-21", ids);
  await publishDailyTable(initial.table!, path, PRIMARY_DAILY_FUND_CODES, initial.publication);
  const before = await readFile(join(path, "latest.json"), "utf8");
  for (const authorConfig of [
    { revision: 0, authorIds: ids }, { revision: 1.5, authorIds: ids },
    { revision: 2, authorIds: [ids[0]!, ids[0]!] }, { revision: 2, authorIds: [] },
    { revision: 2, authorIds: ["not-an-author"] }, { revision: 2, authorIds: [ids[1]!] },
  ]) {
    await assert.rejects(publishDailyTable(initial.table!, path, PRIMARY_DAILY_FUND_CODES,
      { ...initial.publication, authorConfig }), /TABLE_PUBLICATION_STATE_INVALID/);
  }
  assert.equal(await readFile(join(path, "latest.json"), "utf8"), before);
});

test("run persists same-day valid votes during transient source failure, but never relabels yesterday as today", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "nabao-vote-run-")); t.after(() => rm(path, { recursive: true, force: true }));
  const reportFile = join(path, "report.json");
  const reportInputs = sources.map((source, i) => { const data = input(i); data.authorId = source.id; data.capture.authorId = source.id; return data; });
  const report = { results: reportInputs.map((data) => ({ authorId: data.authorId, notes: [data.capture], issues: [] as string[] })) };
  await writeFile(reportFile, JSON.stringify(report));
  const extract: NonNullable<Parameters<typeof dailyTableFromReport>[2]>["extract"] = async (capture) => ({ status: "INCOMPLETE", table: reportInputs.find((item) => item.capture.noteId === capture.noteId)!.table, issues: [], promptVersion: "test" });
  const first = await dailyTableFromReport(reportFile, join(path, "public"), { dataDate: "2026-10-21", extract });
  assert.equal(first.status, "partial"); assert.equal(first.publication?.status, "PUBLISHED"); assert.equal(first.dataDate, "2026-10-21");
  report.results.forEach((item) => { item.notes = []; item.issues = ["PROFILE_ACCESS_RESTRICTED"]; });
  await writeFile(reportFile, JSON.stringify(report));
  const again = await dailyTableFromReport(reportFile, join(path, "public"), { dataDate: "2026-10-21", extract });
  assert.equal(again.publication?.status, "UNCHANGED");
  assert.equal(again.status, "restricted");
  const tomorrow = await dailyTableFromReport(reportFile, join(path, "public"), { dataDate: "2026-10-22", extract });
  assert.equal(tomorrow.status, "restricted"); assert.equal(tomorrow.publication, null); assert.equal(tomorrow.dataDate, "2026-10-21");
});

test("purchase pause synonyms merge while no distributor, large-order pauses and channel qualifiers remain distinct", () => {
  for(const text of ["暂停","暂停申购","暂停购买","停止申购","停购"]) {
    const result=voteDailyTables([input(0,{distributorLimit:text}),input(1,{distributorLimit:"暂停申购"})],"2026-10-21",ids);
    assert.equal(row(result)!.distributorLimit,"暂停申购");
    assert.equal(result.decisions.find(d=>d.fundCode==="019441"&&d.field==="distributorLimit")!.support,2);
  }
  for(const text of ["无代销","暂停大额申购","暂停赎回","部分渠道暂停申购"]) {
    assert.equal(row(voteDailyTables([input(0,{distributorLimit:text}),input(1,{distributorLimit:"暂停申购"})],"2026-10-21",ids))!.distributorLimit,"待更新");
  }
});
test("a global table update date cannot manufacture a return cutoff and incomplete units cannot manufacture opposing votes",()=>{
  const undated=input(0,{return1y:"14%"},{notes:["数据截至2026年10月21日"]});
  const dated=input(1,{return1y:"15%"});
  const result=voteDailyTables([undated,dated],"2026-10-21",ids);
  assert.equal(row(result)!.return1y,"15%");
  for(const field of ["return1y","distributorLimit"] as const) {
    const decision=result.decisions.find(d=>d.fundCode==="019441"&&d.field===field)!;
    assert.equal(decision.votes.length,1);assert.equal(decision.votes[0]!.authorId,ids[1]);
  }
  undated.table.notes.push("收益截至2026-10-19");
  assert.equal(row(voteDailyTables([undated,dated],"2026-10-21",ids))!.return1y,null);
});

test("product-page net-value dates qualify only the explicitly named fund, not the whole reporting table",()=>{
  const a=input(0,{}, {notes:["数据截至2026年10月21日","019441 单位净值（10-20）","额度：元/日"]});
  const b=input(1);
  a.table.rows.push({...a.table.rows[0]!,fundCode:"021000",fundName:"南方纳斯达克100指数I"});
  b.table.rows.push({...b.table.rows[0]!,fundCode:"021000",fundName:"南方纳斯达克100指数I"});
  const result=voteDailyTables([a,b],"2026-10-21",ids);
  const decision=(fundCode:string)=>result.decisions.find(d=>d.fundCode===fundCode&&d.field==="return1y")!;
  assert.equal(decision("019441").support,2);assert.equal(decision("021000").votes.length,1);
  assert.equal(decision("019441").value,"15%");
});
