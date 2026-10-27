import { expect, test } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import VoteAuditPanel from '../src/components/VoteAuditPanel.vue';
import { compareFundVotes, type AuditEntry } from '../src/domain/voteAudit';
const source={authorId:'a'.repeat(24),name:'博主甲',status:'HAS_TABLE'};
const sourceB={authorId:'c'.repeat(24),name:'博主乙',status:'HAS_TABLE'};
const absent={authorId:'d'.repeat(24),name:'博主丙',status:'NO_TODAY_TABLE'};
const batch={id:'12345678-1234-1234-1234-123456789012',dataDate:'2026-10-27',recordedAt:'2026-10-27T14:00:00Z',rule:'UNIQUE_PLURALITY_SINGLE_SOURCE_ALLOWED_PER_FIELD',publicationStatus:'PUBLISHED',sources:[source,sourceB,absent],entryCount:1};
const fund={fundCode:'019441',fundName:'万家<script>unsafe</script>'};
const entry:AuditEntry={authorId:source.authorId,authorName:source.name,noteId:'b'.repeat(24),sourceUrl:'https://www.xiaohongshu.com/explore/'+ 'b'.repeat(24),sourceDate:'2026-10-27',capturedAt:'2026-10-27T13:00:00Z',...fund,field:'directLimit',rawValue:'100元/日',normalizedValue:'100',voteKey:'[AMOUNT,100]',notes:['单日限额'],ballotStatus:'COUNTED',decisionStatus:'ADOPTED',adoptedValue:'100',supportCount:1};
const page=(entries:AuditEntry[],total=entries.length)=>({batch,total,page:0,pageSize:100,entries});
test('fund matrix shows all bloggers beside the persisted result, retains original evidence and searches funds',async()=>{
  const calls:unknown[][]=[];
  const wrapper=mount(VoteAuditPanel,{props:{loadBatches:async()=>[batch],loadFunds:async()=>[fund],loadEntries:async(...args)=>{calls.push(args);return page([entry]);}}});
  expect(calls).toHaveLength(0);await wrapper.get('button').trigger('click');await flushPromises();
  expect(calls[0]).toEqual([batch.id,'','',0,'019441']);
  expect(wrapper.findAll('.comparison-table tbody tr')).toHaveLength(5);
  expect(wrapper.text()).toContain('博主乙');expect(wrapper.text()).toContain('博主丙');expect(wrapper.text()).toContain('无当日表');
  expect(wrapper.text()).toContain('100元/日');expect(wrapper.text()).toContain('1 票采用');expect(wrapper.text()).toContain(fund.fundName);expect(wrapper.findAll('script')).toHaveLength(0);
  expect(wrapper.get('.vote-cell.winner a').attributes('href')).toBe(entry.sourceUrl);
  await wrapper.get('input').setValue('019441');expect(wrapper.findAll('.fund-option')).toHaveLength(1);
  await wrapper.get('input').setValue('not-a-fund');expect(wrapper.text()).toContain('没有匹配的基金');wrapper.unmount();
});
test('matrix distinguishes equal displayed values with different scopes, a real tie and an older-date non-vote',()=>{
  const b={...entry,authorId:sourceB.authorId,authorName:sourceB.name,voteKey:'different-scope',decisionStatus:'TIE',adoptedValue:null};
  const old={...entry,authorId:absent.authorId,sourceDate:'2026-10-23',ballotStatus:'OTHER_DATE',decisionStatus:'TIE',adoptedValue:null};
  const rows=compareFundVotes([{...entry,decisionStatus:'TIE',adoptedValue:null},b,old],batch.sources,fund.fundCode);
  const direct=rows.find(r=>r.field==='directLimit')!;
  expect(direct.tally).toBe('1 : 1');expect(direct.cells.every(c=>!c.winner)).toBe(true);
  expect(direct.cells[2].label).toContain('非本轮日期');
});
test('multiple posts by one author show the counted record and retain superseded evidence without duplicate voting',()=>{
  const older={...entry,normalizedValue:'50',rawValue:'50',voteKey:'old',ballotStatus:'SUPERSEDED',capturedAt:'2026-10-27T15:00:00Z'};
  const row=compareFundVotes([older,entry],batch.sources,fund.fundCode).find(r=>r.field==='directLimit')!;
  expect(row.cells[0].entry).toBe(entry);expect(row.cells[0].history).toHaveLength(2);expect(row.cells[0].winner).toBe(true);expect(row.tally).toBe('1');
});
test('loading another fund ignores an earlier response and always reads all pages before comparing votes',async()=>{
  const second={fundCode:'019442',fundName:'万家C'};
  let finish!:(data:unknown)=>void;const pending=new Promise(r=>{finish=r;});
  const wrapper=mount(VoteAuditPanel,{props:{loadBatches:async()=>[batch],loadFunds:async()=>[fund,second],loadEntries:async(_id,_a,_f,p,code)=>code==='019441'?pending:page(Array.from({length:p===0?100:1},()=>({...entry,...second})),101)}});
  await wrapper.get('button').trigger('click');await flushPromises();
  await wrapper.findAll('.fund-option')[1].trigger('click');await flushPromises();
  finish(page([entry]));await flushPromises();
  expect(wrapper.get('.comparison-heading').text()).toContain('万家C');expect(wrapper.findAll('.comparison-table tbody tr')).toHaveLength(5);wrapper.unmount();
});
test('audit displays failures and discards a response after closing the panel',async()=>{
  let resolve!:(data:unknown)=>void;const pending=new Promise(r=>{resolve=r;});
  const wrapper=mount(VoteAuditPanel,{props:{loadBatches:()=>pending,loadFunds:async()=>[fund],loadEntries:async()=>{throw new Error();}}});
  await wrapper.get('button').trigger('click');await wrapper.get('button').trigger('click');resolve([batch]);await flushPromises();expect(wrapper.find('select').exists()).toBe(false);
  await wrapper.get('button').trigger('click');await flushPromises();expect(wrapper.text()).toContain('投票日志读取失败');wrapper.unmount();
});
