<script setup lang="ts">
import { activeLogin, runLabel, scheduleLabel } from '../domain/collector';
import { displayTime, sourceDisplay } from '../domain/table';
import type { CollectorStatus, Dashboard } from '../domain/types';
defineProps<{ status: CollectorStatus | null; model: Dashboard | null; error: string; canRun: boolean; submitting: boolean }>();
const emit = defineEmits<{ run: [] }>();
</script>
<template>
  <section class="panel collection-panel" aria-label="额度采集">
    <div class="section-heading"><div><h2>额度采集</h2><p class="subtle">{{ status ? `${status.sources.length} 位作者 · ` : '' }}采集后自动投票并发布</p></div>
      <button class="collect-button" :disabled="!canRun" @click="emit('run')"><span aria-hidden="true">↻</span> {{ submitting ? '正在提交…' : status?.run?.status === 'running' ? '正在采集…' : '立即采集' }}</button>
    </div>
    <p v-if="error" class="notice" role="status">{{ error }}</p>
    <template v-if="status">
      <div class="collection-meta"><span class="state-pill" :class="{ running: status.run?.status === 'running', failed: ['failed', 'interrupted'].includes(status.run?.status ?? '') }">{{ runLabel(status.run) }}</span><span class="subtle">{{ scheduleLabel(status.schedule) }}</span></div>
      <p v-if="status.run?.message" class="run-message">{{ status.run.message }}</p>
      <p v-if="status.sources.length < 1" class="notice">至少添加一位作者才能采集。请在下方“采集作者”中添加。</p>
      <dl class="timing"><div v-if="status.run"><dt>{{ status.run.status === 'running' ? '本轮开始' : '本轮完成' }}</dt><dd>{{ displayTime(status.run.finishedAt || status.run.startedAt) }}</dd></div><div v-if="status.schedule.enabled"><dt>下次检查</dt><dd>{{ status.schedule.nextRunAt ? displayTime(status.schedule.nextRunAt) : status.busy ? '当前任务结束后安排' : '等待服务安排' }}</dd></div></dl>
      <p v-if="activeLogin(status)" class="notice">当前登录未完成，采集暂停。请在下方“采集账号”完成登录并确认。</p>
      <p v-else-if="status.session.status === 'restricted'" class="notice">小红书访问受限，采集已暂停。请查看下方“采集账号”的说明。</p>
      <p v-else-if="['expired', 'failed'].includes(status.session.status)" class="notice">请在下方“采集账号”完成小红书登录，再开始采集。</p>
    </template>
    <details v-if="model?.summary || model?.notice" class="source-details"><summary>查看最近采集的来源记录</summary>
      <p v-if="model?.notice" class="subtle">{{ model.notice }}</p>
      <template v-if="model?.summary"><p class="subtle">目标日期 {{ model.summary.attemptedDate }} · 最近检查 {{ displayTime(model.summary.lastAttempt) }}</p>
        <div class="source-list"><article v-for="source in model.summary.sources" :key="source.authorId" class="source-item"><h3>{{ source.name }}</h3><p class="source-data">{{ sourceDisplay(source).data }}</p><p v-if="sourceDisplay(source).issue" class="source-issue">{{ sourceDisplay(source).issue }}</p></article></div>
      </template>
    </details>
  </section>
</template>
