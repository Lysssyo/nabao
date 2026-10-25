<script setup lang="ts">
import ConnectionBar from '../components/ConnectionBar.vue';
import QuotaTable from '../components/QuotaTable.vue';
import CollectionPanel from '../components/CollectionPanel.vue';
import AccountPanel from '../components/AccountPanel.vue';
import AuthorManagementPanel from '../components/AuthorManagementPanel.vue';
import { useAdmin } from '../composables/useAdmin';
import type { AdminApi } from '../api/admin';
const props = defineProps<{ api?: AdminApi }>();
const { connected, loading, action, dashboard, collector, message, collectorError, actionError,
  previewUrl, previewError, busy, canRun, connect, disconnect, refresh, perform,
  authorAction, authorError, authorSaved, addAuthor, removeAuthor } = useAdmin(props.api);
</script>
<template>
  <main>
    <header class="page-header"><div><div class="brand"><img class="brand-icon" :src="'/admin/brand/nabao-icon-192.png'" width="48" height="48" alt="" aria-hidden="true" /><div class="brand-wordmark"><span class="brand-name">纳宝</span><span class="brand-latin">nabao</span></div></div><h1>额度管理</h1></div><button v-if="connected" class="quiet refresh-button" :disabled="busy" @click="refresh()">{{ loading ? '刷新中…' : '刷新结果' }}</button></header>
    <ConnectionBar :connected="connected" :loading="loading" @connect="connect" @disconnect="disconnect" />
    <p id="message" class="connection-message" role="status" aria-live="polite">{{ message }}</p>
    <nav v-if="connected" class="section-nav" aria-label="管理功能"><a href="#quota-results">额度与采集</a><a href="#collector-authors">采集作者</a><a href="#collector-account">采集账号 ↓</a></nav>
    <div v-if="connected" id="quota-results" class="dashboard" :aria-busy="loading">
      <CollectionPanel :status="collector" :model="dashboard" :error="collectorError" :can-run="canRun" :submitting="action === 'run'" @run="perform('run')" />
      <p v-if="actionError" class="notice action-error" role="alert">{{ actionError }}</p>
      <QuotaTable v-if="dashboard" :model="dashboard" />
      <div v-else class="empty">正在读取投票结果…</div>
      <AuthorManagementPanel :status="collector" :busy="busy" :pending="authorAction" :error="authorError" :saved="authorSaved" @add="addAuthor" @remove="removeAuthor" />
      <AccountPanel :status="collector" :busy="busy" :action="action" :preview="previewUrl" :preview-error="previewError" @action="perform" />
    </div>
    <div v-else class="empty welcome"><h2>查看额度，管理采集</h2><p>连接后可查看投票结果、立即采集和登录小红书。</p></div>
    <footer>投票结果不等于官方交易确认，实际额度以渠道为准。</footer>
  </main>
</template>
