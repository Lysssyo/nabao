import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVoteAudit, saveVoteAudit, flushVoteAudits } from "../src/vote-audit.js";
import { voteDailyTables, type SourceTable } from "../src/daily-table-voting.js";
const authors=[{id:"a".repeat(24),name:"作者甲"},{id:"b".repeat(24),name:"作者乙"}];
function source(author=0,date="2026-10-27"): SourceTable {
  return {authorId:authors[author]!.id,capture:{authorId:authors[author]!.id,noteId:String(author).repeat(24),title:"test",body:"",
    evidenceRef:"https://www.xiaohongshu.com/explore/"+String(author).repeat(24),openUrl:"https://example.test?secret=never-export",
    capturedAt:"2026-10-27T14:00:00Z",sourcePublishedAt:"2026-10-27T01:00:00Z",sourceUpdatedAt:null,revision:"r",captureStatus:"success",images:[],expectedImageCount:0,issues:[]},
    table:{schemaVersion:1,dataDate:date,updatedAt:"2026-10-27T14:00:00Z",source:{name:authors[author]!.name,url:"https://example.test",publishedAt:"2026-10-27T01:00:00Z"},notes:["额度单位：元/日"],
      rows:[{fundCode:"019441",fundName:"万家A",feeRate:null,distributorLimit:"10",directLimit:"100",trackingError:null,return1y:null}]}};
}
test("audit keeps each author's original values, absent fields, counted votes, ties and older-date exclusions without session secrets",()=>{
  const a=source(),b=source(1);b.table.rows[0]!.distributorLimit="20";
  const old=source(1,"2026-10-23");old.capture.noteId="f".repeat(24);
  const v=voteDailyTables([a,b,old],"2026-10-27",authors.map(a=>a.id));
  const audit=createVoteAudit([a,b,old],v.decisions,authors,"2026-10-27",v.publication.revision,"PUBLISHED");
  assert.equal(audit.entries.length,15);
  const limits=audit.entries.filter(e=>e.field==="distributorLimit");
  assert.deepEqual(limits.map(e=>e.rawValue),["10","20","10"]);
  assert.deepEqual(limits.map(e=>e.ballotStatus),["COUNTED","COUNTED","OTHER_DATE"]);
  assert.ok(limits.every(e=>e.decisionStatus==="TIE"&&e.adoptedValue===null));
  assert.equal(audit.entries.find(e=>e.field==="feeRate")!.ballotStatus,"NO_VALUE");
  assert.doesNotMatch(JSON.stringify(audit),/never-export|openUrl/);
});
test("audit outbox survives a failed request and a retry sends the identical batch once before archiving",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"nabao-audit-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const previous=[process.env.NABAO_BACKEND_URL,process.env.NABAO_INTERNAL_KEY];
  process.env.NABAO_BACKEND_URL="http://backend:8080";process.env.NABAO_INTERNAL_KEY="test-private-key";
  t.after(()=>{for(const [i,k] of ["NABAO_BACKEND_URL","NABAO_INTERNAL_KEY"].entries())if(previous[i]===undefined)delete process.env[k];else process.env[k]=previous[i];});
  const a=source(),v=voteDailyTables([a],"2026-10-27",[authors[0]!.id]);
  const batch=createVoteAudit([a],v.decisions,authors,"2026-10-27",v.publication.revision,"PUBLISHED");
  await saveVoteAudit(dir,batch);const path=join(dir,"vote-audit/pending",`${batch.id}.json`),original=await readFile(path,"utf8");
  assert.equal(await flushVoteAudits(dir,async()=>new Response(null,{status:503})),0);
  assert.equal(await readFile(path,"utf8"),original);
  let calls=0;
  assert.equal(await flushVoteAudits(dir,async(url,init)=>{calls++;assert.equal(url,"http://backend:8080/internal/v1/vote-audits");assert.equal(init?.body,original);return new Response(null,{status:204});}),1);
  assert.equal(await readFile(join(dir,"vote-audit/sent",`${batch.id}.json`),"utf8"),original);
  assert.deepEqual(await readdir(join(dir,"vote-audit/pending")),[]);
  assert.equal(await flushVoteAudits(dir,async()=>{calls++;throw new Error();}),0);assert.equal(calls,1);
});
