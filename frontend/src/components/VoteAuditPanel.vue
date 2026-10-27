<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { compareFundVotes, type AuditEntry, type AuditFund, type AuditPage, type AuditSummary } from '../domain/voteAudit';
import { displayTime } from '../domain/table';
const props = defineProps<{ loadBatches: () => Promise<unknown>; loadFunds: (id: string) => Promise<unknown>;
  loadEntries: (id: string, author: string, field: string, page: number, fundCode?: string) => Promise<unknown>; runId?: string; runStatus?: string }>();
const open = ref(false), loading = ref(false), error = ref(''), batches = ref<AuditSummary[]>([]), selected = ref('');
const funds = ref<AuditFund[]>([]), fundCode = ref(''), search = ref(''), entries = ref<AuditEntry[]>([]);
let generation = 0;
const batch = computed(() => batches.value.find(b => b.id === selected.value));
const fund = computed(() => funds.value.find(f => f.fundCode === fundCode.value));
const filteredFunds = computed(() => { const query=search.value.trim().toLowerCase(); return funds.value.filter(f=>`${f.fundName} ${f.fundCode}`.toLowerCase().includes(query)); });
const rows = computed(() => compareFundVotes(entries.value, batch.value?.sources ?? [], fundCode.value));
async function readFund(token: number) {
  if (!selected.value || !fundCode.value) return;
  const first = await props.loadEntries(selected.value, '', '', 0, fundCode.value) as AuditPage;
  if (token !== generation) return;
  if (!first || !Array.isArray(first.entries) || !Number.isInteger(first.total) || first.pageSize !== 100 || first.total > 70000) throw new Error('INVALID_RESPONSE');
  const all = [...first.entries];
  for (let page=1;page*first.pageSize<first.total;page++) {
    const next = await props.loadEntries(selected.value, '', '', page, fundCode.value) as AuditPage;
    if (token !== generation) return;
    if (!next || !Array.isArray(next.entries) || next.total !== first.total) throw new Error('INVALID_RESPONSE');
    all.push(...next.entries);
  }
  if (all.length !== first.total || all.some(e=>e.fundCode !== fundCode.value)) throw new Error('INVALID_RESPONSE');
  entries.value = all;
}
async function chooseFund(code: string) {
  const token=++generation;fundCode.value=code;entries.value=[];loading.value=true;error.value='';
  try { await readFund(token); } catch { if(token===generation) error.value='基金投票记录读取失败，请重试。'; }
  finally { if(token===generation)loading.value=false; }
}
async function readBatch(token: number) {
  if(!selected.value){funds.value=[];fundCode.value='';return;}
  const data=await props.loadFunds(selected.value) as AuditFund[];if(token!==generation)return;
  if(!Array.isArray(data)||data.some(f=>!/^\d{6}$/.test(f.fundCode)||typeof f.fundName!=='string'))throw new Error('INVALID_RESPONSE');
  funds.value=data;if(!data.some(f=>f.fundCode===fundCode.value))fundCode.value=data[0]?.fundCode??'';
  await readFund(token);
}
async function refresh(batchOnly=false) {
  const token=++generation;loading.value=true;error.value='';entries.value=[];
  try {
    if(!batchOnly){
      const data=await props.loadBatches();if(token!==generation)return;
      if(!Array.isArray(data))throw new Error('INVALID_RESPONSE');
      batches.value=data;if(!data.some(b=>b.id===selected.value))selected.value=data[0]?.id??'';
    }
    await readBatch(token);
  } catch { if(token===generation)error.value='投票日志读取失败，请重试。'; }
  finally { if(token===generation)loading.value=false; }
}
function toggle(){open.value=!open.value;if(open.value)void refresh();else{generation++;loading.value=false;}}
watch(()=>[props.runId,props.runStatus],()=>{if(open.value&&props.runStatus!=='running')void refresh();});
onBeforeUnmount(()=>generation++);
</script>
<template>
  <section id="vote-audit" class="panel audit-panel" aria-label="投票日志">
    <div class="section-heading"><div><h2>基金投票对照</h2><p class="subtle">选一个基金，横向对照每位博主的票和最终结果。</p></div><button class="quiet" @click="toggle">{{open?'收起日志':'查看日志'}}</button></div>
    <div v-if="open">
      <div class="audit-toolbar"><label>采集批次<select v-model="selected" :disabled="loading" @change="refresh(true)"><option v-for="item in batches" :key="item.id" :value="item.id">{{displayTime(item.recordedAt)}} · 表日期 {{item.dataDate}}</option></select></label><button class="quiet" :disabled="loading" @click="refresh()">刷新日志</button></div>
      <p v-if="error" class="notice" role="alert">{{error}}</p>
      <p v-if="!loading&&!batches.length" class="subtle">还没有投票日志，完成采集后会保存到这里。</p>
      <div v-else class="comparison-layout">
        <aside class="fund-picker" aria-label="选择基金"><label for="audit-fund-search">基金名称或代码</label><input id="audit-fund-search" v-model="search" type="search" placeholder="搜索基金 / 代码" autocomplete="off" /><p class="picker-count">{{funds.length}} 个基金份额</p><div class="fund-options"><button v-for="item in filteredFunds" :key="item.fundCode" type="button" :class="['fund-option',{selected:item.fundCode===fundCode}]" :aria-pressed="item.fundCode===fundCode" @click="chooseFund(item.fundCode)"><span>{{item.fundName}}</span><small>{{item.fundCode}}</small></button><p v-if="!filteredFunds.length&&!loading" class="subtle">没有匹配的基金</p></div></aside>
        <div class="comparison-content" :aria-busy="loading">
          <div v-if="fund" class="comparison-heading"><div><h3>{{fund.fundName}}</h3><p>{{fund.fundCode}} · {{batch?.dataDate}}</p></div><span v-if="!loading" class="adoption-count">{{rows.filter(r=>r.status==='ADOPTED').length}} / 5 字段已采用</span></div>
          <p v-if="loading" role="status">正在读取基金投票…</p>
          <template v-else-if="fund&&batch&&!error">
            <div class="comparison-legend"><span class="winner">● 采纳票</span><span class="other-vote">● 其他有效票</span><span>○ 未计票</span></div>
            <div class="comparison-scroll" role="region" aria-label="基金各博主投票对照，可左右滚动" tabindex="0"><table class="comparison-table"><thead><tr><th class="field-column" scope="col">字段</th><th class="result-column" scope="col">最终结果</th><th v-for="source in batch.sources" :key="source.authorId" scope="col">{{source.name}}</th></tr></thead><tbody>
              <tr v-for="row in rows" :key="row.field" :data-field="row.field"><th class="field-column" scope="row">{{row.label}}</th><td class="result-column"><strong :class="row.status==='ADOPTED'?'adopted-result':'pending-result'">{{row.adoptedValue??'待更新'}}</strong><small>{{row.status==='ADOPTED'?`${row.support} 票采用`:row.status==='TIE'?`平票 ${row.tally}`:'无有效票'}}</small></td>
                <td v-for="cell in row.cells" :key="cell.author.authorId" :data-author="cell.author.authorId" :class="['vote-cell',{winner:cell.winner,'other-vote':cell.entry?.ballotStatus==='COUNTED'&&!cell.winner}]">
                  <strong>{{cell.entry?.normalizedValue??cell.entry?.rawValue??'未提供'}}</strong><small>{{cell.winner?'采纳票':cell.label}}</small>
                  <details v-if="cell.entry" class="vote-evidence"><summary>来源与口径<span v-if="cell.history.length>1"> · {{cell.history.length}} 条</span></summary><article v-for="(record,n) in cell.history" :key="n"><p>原值：{{record.rawValue??'未提供'}}</p><p>表日期 {{record.sourceDate}}</p><p>采集 {{displayTime(record.capturedAt)}}</p><a :href="record.sourceUrl" target="_blank" rel="noopener noreferrer">查看原笔记 ↗</a><p v-for="(note,i) in record.notes" :key="i">{{note}}</p><code v-if="record.voteKey">{{record.voteKey}}</code></article></details>
                </td>
              </tr>
            </tbody></table></div>
            <p class="comparison-help">每位博主每字段最多一票；仅一位提供有效数据时直接采用，多来源按唯一最高票采用。旧日期和缺少必要口径的原值保留在详情中，不计入本轮。左右滑动可查看全部博主。</p>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>
<style scoped>
.audit-toolbar{display:flex;gap:12px;align-items:end;margin:20px 0}.audit-toolbar label{display:grid;gap:6px;font-size:13px;color:#647870}select,input{min-height:42px;border:1px solid #d7e3de;border-radius:8px;background:#fff;padding:9px;color:#183c33;max-width:100%}.comparison-layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:22px}.fund-picker{min-width:0}.fund-picker label{font-size:13px;color:#647870}.fund-picker input{width:100%;box-sizing:border-box;margin-top:8px}.picker-count{font-size:12px;color:#718077;margin:10px 0}.fund-options{max-height:530px;overflow:auto;display:grid;gap:7px}.fund-option{text-align:left;background:#f6f8f6;border:1px solid transparent;border-radius:9px;padding:11px;color:#344a40;font-size:12px;line-height:1.6;cursor:pointer}.fund-option.selected{background:#e9f4ee;border-color:#267b5f;color:#15563d}.fund-option span,.fund-option small{display:block}.fund-option small{color:#76877f;margin-top:3px}.comparison-heading{display:flex;gap:14px;align-items:center;justify-content:space-between;margin-bottom:14px}.comparison-heading h3{font-size:17px;margin:0}.comparison-heading p{font-size:12px;color:#74877c;margin:6px 0 0}.adoption-count{flex-shrink:0;border-radius:20px;padding:6px 10px;background:#eef5f0;color:#366c50;font-size:12px}.comparison-legend{display:flex;gap:16px;font-size:12px;color:#829087;margin:14px 0}.winner{color:#176c4b}.other-vote{color:#a76518}.comparison-scroll{overflow:auto;border:1px solid #dce6df;border-radius:10px}.comparison-table{border-collapse:separate;border-spacing:0;min-width:100%;font-size:13px}.comparison-table th,.comparison-table td{padding:16px 12px;text-align:left;vertical-align:top;border-bottom:1px solid #e6ece8;border-right:1px solid #edf1ee;white-space:normal;min-width:145px;max-width:230px;position:static;background:#fff}.comparison-table thead th{background:#f0f6f2;font-size:12px}.comparison-table .field-column{position:sticky;left:0;min-width:90px;width:90px;z-index:2;background:#f6f9f6}.comparison-table .result-column{position:sticky;left:115px;min-width:115px;width:115px;z-index:2;box-shadow:3px 0 5px #183c3307;background:#fafcfb}.comparison-table thead .result-column{background:#f0f6f2}.comparison-table .vote-cell.winner{background:#eff8f2}.comparison-table .vote-cell.other-vote{background:#fff8ec}.comparison-table small{display:block;font-size:11px;color:#7b8c81;line-height:1.5;margin-top:6px}.comparison-table .winner small{color:#398162}.adopted-result{color:#176c4b}.pending-result{color:#aa711e}.vote-evidence{margin-top:12px;font-size:11px}.vote-evidence summary{cursor:pointer;color:#5b7566;white-space:nowrap}.vote-evidence article{border-top:1px solid #e3eae5;margin-top:9px;padding-top:6px;min-width:150px;max-width:220px;color:#64786c}.vote-evidence p{margin:5px 0;line-height:1.6}.vote-evidence code{overflow-wrap:anywhere;font-size:10px}.vote-evidence a{color:#276f52}.comparison-help{font-size:12px;line-height:1.8;color:#75867a;margin-bottom:0}@media(max-width:750px){.comparison-layout{grid-template-columns:minmax(0,1fr)}.fund-options{display:flex;max-height:115px;overflow-x:auto;gap:9px}.fund-option{min-width:180px;max-width:210px;flex:0 0 auto}.comparison-heading{align-items:flex-start}.comparison-heading h3{font-size:15px}.audit-toolbar{align-items:stretch;flex-direction:column}.comparison-table .field-column{min-width:65px;width:65px;padding-left:8px;padding-right:8px}.comparison-table .result-column{left:82px;min-width:90px;width:90px;padding-left:8px;padding-right:8px}.comparison-table td{min-width:130px}.comparison-legend{gap:12px;font-size:11px}}
</style>
