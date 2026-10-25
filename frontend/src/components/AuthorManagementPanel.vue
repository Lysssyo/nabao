<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { activeLogin } from '../domain/collector';
import { authorURL, normalizedAuthor } from '../domain/authors';
import type { AuthorInput, CollectorStatus } from '../domain/types';
const props = defineProps<{ status: CollectorStatus | null; busy: boolean; pending: string | null; error: string; saved: number }>();
const emit = defineEmits<{ add: [input: AuthorInput]; remove: [id: string] }>();
const name = ref(''), profileUrl = ref(''), localError = ref(''), confirming = ref<string | null>(null);
const disabled = computed(() => props.busy || !props.status?.available || activeLogin(props.status));
const atLimit = computed(() => (props.status?.sources.length ?? 0) >= 50);
watch(() => props.saved, () => { name.value = ''; profileUrl.value = ''; localError.value = ''; });
watch(() => props.status?.sources, sources => { if (confirming.value && !sources?.some(source => source.id === confirming.value)) confirming.value = null; });
function submit() {
  if (disabled.value || atLimit.value) return;
  localError.value = '';
  const input = normalizedAuthor({ name: name.value, profileUrl: profileUrl.value });
  if (!input) { localError.value = '请填写 1–80 字昵称，并粘贴 https://www.xiaohongshu.com/user/profile/ 开头的作者主页链接。'; return; }
  emit('add', input);
}
</script>
<template>
  <section id="collector-authors" class="panel author-panel" aria-label="采集作者">
    <div class="section-heading"><div><h2>采集作者</h2><p class="subtle">维护要抓取的小红书作者，修改从下次采集生效。</p></div><span v-if="status" class="state-pill">{{ status.sources.length }} 位作者</span></div>
    <template v-if="status">
      <p v-if="status.busy || activeLogin(status)" class="subtle author-busy">当前有采集或登录任务，完成后可修改作者。</p>
      <ul v-if="status.sources.length" class="author-list">
        <li v-for="source in status.sources" :key="source.id" class="author-row" :data-author-id="source.id">
          <div class="author-identity"><strong>{{ source.name }}</strong><a :href="authorURL(source.id)" target="_blank" rel="noopener noreferrer">查看小红书主页 ↗</a></div>
          <button v-if="confirming !== source.id" type="button" class="quiet author-remove" :disabled="disabled" :aria-label="`移除作者 ${source.name}`" @click="confirming = source.id">移除</button>
          <div v-else class="author-confirm"><p>移除“{{ source.name }}”？历史记录保留，也可重新添加。</p><div class="author-confirm-buttons"><button type="button" :disabled="disabled" @click="emit('remove', source.id)">{{ pending === source.id ? '正在移除…' : '确认移除' }}</button><button type="button" class="quiet" :disabled="disabled" @click="confirming = null">取消</button></div></div>
        </li>
      </ul>
      <p v-else class="author-empty">还没有采集作者，添加后即可在这里管理。</p>
      <form class="author-form" @submit.prevent="submit">
        <h3>添加作者</h3>
        <fieldset :disabled="disabled || atLimit"><div class="author-field"><label for="author-name">昵称</label><input id="author-name" v-model="name" maxlength="80" required placeholder="作者昵称" autocomplete="off" /></div><div class="author-field author-profile"><label for="author-profile">小红书主页链接</label><input id="author-profile" v-model="profileUrl" required type="url" placeholder="https://www.xiaohongshu.com/user/profile/…" autocomplete="off" /></div><button type="submit">{{ pending === 'add' ? '正在添加…' : '添加作者' }}</button></fieldset>
        <p class="subtle">打开作者个人主页，复制浏览器地址粘贴到这里。最多可添加 50 位作者。</p>
      </form>
      <p v-if="atLimit" class="notice">已达到 50 位作者上限，可先移除不需要的作者。</p>
      <p v-if="localError || error" class="notice author-error" role="alert">{{ localError || error }}</p>
    </template>
    <p v-else class="subtle">采集服务连接后可管理作者。</p>
  </section>
</template>
<style scoped>
.author-panel{scroll-margin-top:16px}.author-list{list-style:none;padding:0;margin:16px 0 0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.author-row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;min-width:0;padding:12px;border:1px solid var(--line);border-radius:8px;background:#fafcf9}.author-identity{display:flex;flex:1;min-width:0;flex-direction:column;gap:5px}.author-identity strong{font-size:13px;overflow-wrap:anywhere}.author-identity a{font-size:11px;color:var(--accent);text-decoration:none;align-self:flex-start}.author-identity a:hover{text-decoration:underline}.author-remove{font-size:12px;min-height:36px;padding:6px 10px}.author-confirm{flex-basis:100%;font-size:12px;border-top:1px solid var(--line);padding-top:9px}.author-confirm p{margin:0;overflow-wrap:anywhere}.author-confirm-buttons{display:flex;gap:8px;margin-top:8px}.author-confirm-buttons button{font-size:12px;min-height:36px;padding:6px 11px}.author-empty{font-size:13px;color:var(--muted);padding:18px 0 6px}.author-form{border-top:1px solid var(--line);margin-top:18px;padding-top:15px}.author-form h3{margin-bottom:10px}.author-form fieldset{border:0;padding:0;margin:0;min-width:0;display:flex;gap:10px;align-items:flex-end}.author-field{display:flex;flex-direction:column;gap:6px;min-width:0;flex:1}.author-field label{font-size:12px;color:#536e5e}.author-profile{flex:2}.author-field input{width:100%;font-size:13px}.author-form button{min-height:44px}.author-busy{margin-top:12px}.author-form fieldset:disabled{opacity:.6}.author-error{margin-top:12px}@media(max-width:700px){.author-list{grid-template-columns:minmax(0,1fr)}.author-form fieldset{flex-wrap:wrap}.author-field,.author-profile{flex-basis:100%}.author-field input{font-size:16px}.author-form button{width:100%}.author-row{padding:11px}.author-confirm-buttons button{min-height:42px}.author-remove{min-height:42px}}
</style>
