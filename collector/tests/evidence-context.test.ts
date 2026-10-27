import test from "node:test";
import assert from "node:assert/strict";
import { retainUnitContexts } from "../src/evidence-context.js";
import type { SourceTable } from "../src/daily-table-voting.js";
import type { DailyTableExtraction } from "../src/daily-table.js";

function fixture() {
  const previous: SourceTable = { authorId: "a".repeat(24), validationVersion: "verified-v1", capture: {
    authorId: "a".repeat(24),noteId:"b".repeat(24),revision:"same-evidence",title:"table",body:"",captureStatus:"success",
    capturedAt:"2026-10-27T01:00:00Z",sourcePublishedAt:"2026-10-27T00:00:00Z",sourceUpdatedAt:null,
    evidenceRef:"https://www.xiaohongshu.com/explore/"+"b".repeat(24),issues:[],expectedImageCount:1,
    images:[{ordinal:0,sha256:"c".repeat(64),file:"image-0.png",sourceUrl:"https://example.test/image",mediaType:"image/png",size:123}] },
    table:{schemaVersion:1,dataDate:"2026-10-27",updatedAt:"2026-10-27T01:00:00Z",source:{name:"author",url:"https://example.test",publishedAt:"2026-10-27T00:00:00Z"},notes:[],
      rows:[{fundCode:"019441",fundName:"fund A",distributorLimit:"5",directLimit:"100",feeRate:null,trackingError:null,return1y:null}]},
    unitContexts:{"019441":{directLimit:{text:"该产品每日买入限额100元",imageOrdinal:0,imageSha256:"c".repeat(64)}}} };
  const result: DailyTableExtraction={status:"INCOMPLETE",table:structuredClone(previous.table),issues:[],promptVersion:"new-prompt",unitContexts:{}};
  return {previous,result,capture:structuredClone(previous.capture)};
}
test("a new transcription cannot erase verified units from the exact same unchanged evidence",()=>{
  const {previous,result,capture}=fixture();const contexts=retainUnitContexts(previous,capture,result);
  assert.deepEqual(contexts,previous.unitContexts);assert.deepEqual(result.unitContexts,{});
  contexts["019441"]!.directLimit!.text="outside mutation";
  assert.notEqual(previous.unitContexts!["019441"]!.directLimit!.text,"outside mutation");
});
test("changed revision, image, amount, date, note, withdrawn cell or unverified state cannot retain old units",()=>{
  for (const change of ["revision","image","amount","date","note","withdrawn","unverified"]){
    const {previous,result,capture}=fixture();
    if(change==="revision")capture.revision="changed";
    if(change==="image")capture.images[0]!.sha256="d".repeat(64);
    if(change==="amount")result.table!.rows[0]!.directLimit="200";
    if(change==="date")result.table!.dataDate="2026-10-28";
    if(change==="note")capture.noteId="e".repeat(24);
    if(change==="withdrawn")result.withdrawnFields={"019441":["directLimit"]};
    if(change==="unverified")delete previous.validationVersion;
    assert.deepEqual(retainUnitContexts(previous,capture,result),{},change);
  }
});
test("explicit new context takes precedence and a context never leaks to another fund or channel",()=>{
  const {previous,result,capture}=fixture();
  result.unitContexts={"019441":{directLimit:{text:"新转录每日100元",imageOrdinal:0,imageSha256:"c".repeat(64)}}};
  result.table!.rows.push({...result.table!.rows[0]!,fundCode:"019442"});
  const contexts=retainUnitContexts(previous,capture,result);
  assert.equal(contexts["019441"]!.directLimit!.text,"新转录每日100元");
  assert.equal(contexts["019441"]!.distributorLimit,undefined);assert.equal(contexts["019442"],undefined);
});
