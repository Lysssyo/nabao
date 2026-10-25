<script setup lang="ts">
import type { Dashboard } from '../domain/types';
import { displayField, quotaSortKey } from '../domain/table';
defineProps<{ model: Dashboard }>();
</script>
<template>
  <section class="quota-section" aria-label="额度投票结果">
    <div v-if="model.table" class="result-heading">
      <div><h2>额度投票结果</h2><p class="subtle">数据日期 {{ model.table.dataDate }} · {{ model.table.rows.length }} 个份额</p></div>
      <p v-if="model.summary?.published" class="vote-metrics"><strong>{{ model.summary.published.adoptedFields }}</strong> 项已采用 <span>· {{ model.summary.published.pendingFields }} 项待更新</span></p>
    </div>
    <template v-if="model.table">
      <p id="sort-note" class="sort-note">代销额度由高到低 · 附条件额度单独排列<span class="mobile-hint">左右滑动查看全部字段</span></p>
      <div class="table-wrap" role="region" aria-label="额度表，可左右滚动" tabindex="0">
        <table aria-label="额度投票结果，按代销额度排序" aria-describedby="sort-note">
          <thead><tr><th scope="col">基金</th><th scope="col" aria-sort="descending">代销额度 ↓</th><th scope="col">直销额度</th><th scope="col">费率</th><th scope="col">跟踪误差</th><th scope="col">近一年</th></tr></thead>
          <tbody><tr v-for="row in model.table.rows" :key="row.fundCode" :data-fund-code="row.fundCode">
            <th scope="row" class="fund-cell"><span>{{ row.fundName }}</span><small>{{ row.fundCode }}</small></th>
            <td v-for="(value, index) in [row.distributorLimit, row.directLimit, row.feeRate, row.trackingError, row.return1y]" :key="index"
              :class="{ 'conditional-limit': index === 0 && quotaSortKey(value).bucket === 2, 'pending-field': displayField(value) === '待更新' }">{{ displayField(value) }}</td>
          </tr></tbody>
        </table>
      </div>
      <ul v-if="model.table.notes?.length" class="public-notes"><li v-for="note in model.table.notes" :key="note">{{ note }}</li></ul>
    </template>
    <div v-else class="empty">{{ model.tableState === 'MISSING' ? '尚无已发布的投票结果。' : '额度投票结果暂不可读，请检查发布状态。' }}</div>
    <details class="voting-rules"><summary>投票规则</summary>
      <p>每位作者对每个字段最多一票。至少两票一致且为唯一最高票时采用；单票或最高票并列时显示“待更新”。费率、代销额度、直销额度、跟踪误差和近一年表现均独立投票。</p>
      <p>不限额置顶，明确金额由高到低；附条件额度随后，暂停、无额度与待更新置后。保留额度的原文条件。</p>
    </details>
  </section>
</template>
