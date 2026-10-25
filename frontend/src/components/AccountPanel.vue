<script setup lang="ts">
import { computed } from 'vue';
import { activeLogin, sessionLabel } from '../domain/collector';
import { displayTime } from '../domain/table';
import type { CollectorAction, CollectorStatus } from '../domain/types';
const props = defineProps<{ status: CollectorStatus | null; busy: boolean; action: CollectorAction | null; preview: string; previewError: string }>();
const emit = defineEmits<{ action: [kind: CollectorAction] }>();
const restricted = computed(() => props.status?.session.status === 'restricted' || props.status?.login.status === 'restricted');
const loginActive = computed(() => activeLogin(props.status));
const accountLabel = computed(() => {
  if (!props.status) return '';
  if (!loginActive.value) return sessionLabel(props.status.session.status);
  if (props.action === 'complete') return '正在确认';
  if (props.status.login.status === 'starting') return '正在开启登录';
  return props.status.login.status === 'waiting' ? '等待扫码' : '等待确认';
});
</script>
<template>
  <section id="collector-account" class="panel account-panel" aria-label="采集账号">
    <div class="section-heading"><div><h2>采集账号</h2><p class="subtle">用你的小红书账号访问已添加的作者</p></div><span v-if="status" class="state-pill" :class="{ positive: !loginActive && status.session.status === 'authenticated', failed: !loginActive && ['expired', 'restricted'].includes(status.session.status) }">{{ accountLabel }}</span></div>
    <template v-if="status">
      <p class="account-message">{{ activeLogin(status) ? status.login.message : status.session.message }}</p>
      <template v-if="activeLogin(status)">
        <div class="login-area"><div class="preview-frame"><img v-if="preview" :src="preview" :alt="status.login.status === 'waiting_browser' ? '采集专用 Chrome 的当前页面' : '小红书登录页面，请使用小红书 App 扫码并完成验证'" /><p v-else>{{ previewError || '正在准备登录页面…' }}</p></div>
          <div class="login-instructions"><template v-if="status.login.status === 'waiting_browser'"><strong>在专用 Chrome 中完成登录</strong><ol><li>切换到采集服务打开的专用 Chrome 窗口。</li><li>通过小红书正常登录入口完成本人登录。</li><li>回来点击“已完成登录”，验证通过后保存会话。</li></ol><p class="subtle">当前页面尚未识别到可用二维码，窗口会保持打开。这里显示的是该窗口的页面预览。</p></template><template v-else-if="status.login.status === 'waiting'"><strong>扫码后确认登录</strong><ol><li>用手机小红书扫描登录页中的二维码。</li><li>按小红书提示确认登录并完成本人验证。</li><li>点击“已完成登录”，检查成功后保存会话。</li></ol><p class="subtle">如果当前手机无法扫码，可在另一台设备打开本管理端。验证码或滑块须在采集服务的专用浏览器中由你完成。</p></template><strong v-else>正在检查已保存会话…</strong><p v-if="status.login.expiresAt" class="subtle">本次登录有效至 {{ displayTime(status.login.expiresAt) }}</p></div>
        </div>
        <div class="button-row"><button :disabled="action !== null || status.login.status === 'starting'" @click="emit('action', 'complete')">{{ action === 'complete' ? '正在验证…' : '已完成登录' }}</button><button class="quiet" :disabled="action !== null || status.login.status === 'starting'" @click="emit('action', 'cancel')">取消登录</button></div>
      </template>
      <template v-else>
        <div v-if="restricted" class="account-recovery">
          <strong>先恢复访问，再检查现有会话</strong>
          <p>小红书返回了访问限制，自动采集已暂停。已保存的会话和额度表会继续保留。</p>
          <p>请先在采集服务所在电脑上打开小红书，按平台提示处理。恢复正常访问后，点击下方“检查登录状态”；只有会话失效时才需要重新登录。</p>
          <details v-if="status.login.previewAvailable" class="restriction-details"><summary>查看小红书返回的页面</summary><div class="preview-frame restricted-preview"><img v-if="preview" :src="preview" alt="小红书访问受限页面" /><p v-else>{{ previewError || '正在读取访问受限页面…' }}</p></div></details>
        </div>
        <p v-if="['failed', 'expired'].includes(status.login.status)" class="notice">{{ status.login.message }}</p>
        <div class="button-row"><button :disabled="busy" @click="emit('action', 'check')">{{ action === 'check' || status.session.status === 'checking' ? '正在检查…' : '检查登录状态' }}</button><button class="quiet" :disabled="busy" @click="emit('action', 'login')">{{ action === 'login' ? '正在打开…' : restricted ? '恢复登录' : status.session.status === 'authenticated' ? '打开登录会话' : '登录小红书' }}</button></div>
        <p class="subtle">登录和采集复用此服务保存的浏览器会话，无需每次重新登录。</p>
        <p v-if="status.session.checkedAt" class="last-checked subtle">最近检查 {{ displayTime(status.session.checkedAt) }}</p>
      </template>
    </template>
    <p v-else class="subtle">采集服务连接后可登录与检查账号。</p>
  </section>
</template>
