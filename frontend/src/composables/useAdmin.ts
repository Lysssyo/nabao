import { computed, onBeforeUnmount, ref, shallowRef } from 'vue';
import { createAdminApi, AdminApiError, type AdminApi } from '../api/admin';
import { dashboardModel } from '../domain/table';
import { activeLogin, collectorModel } from '../domain/collector';
import { authorIdValid, normalizedAuthor } from '../domain/authors';
import type { AuthorInput, CollectorAction, CollectorStatus, Dashboard } from '../domain/types';
const failureMessages: Record<string, string> = {
  UNAUTHORIZED: '管理密钥不正确或没有访问权限，请重新连接。',
  INVALID_RESPONSE: '服务返回的数据格式不完整，请重新连接。',
  TIMEOUT: '服务响应超时，请重新连接后检查当前任务状态。',
  NETWORK: '无法连接服务，请检查网络后重新连接。',
  UNAVAILABLE: '服务暂未就绪，请检查采集服务配置。',
  HTTP_FAILURE: '服务暂时无法完成请求，请稍后重新连接。',
};
export function useAdmin(api: AdminApi = createAdminApi()) {
  const connected = ref(false), loading = ref(false), action = ref<CollectorAction | null>(null);
  const dashboard = shallowRef<Dashboard | null>(null), collector = shallowRef<CollectorStatus | null>(null);
  const message = ref('管理密钥仅保存在当前页面内存中。'), collectorError = ref(''), actionError = ref('');
  const previewUrl = ref(''), previewError = ref('');
  const authorAction = ref<string | null>(null), authorError = ref(''), authorSaved = ref(0);
  let previewIdentity = '';
  let key = '', generation = 0, pollTimer: ReturnType<typeof setTimeout> | undefined;
  let reading: Promise<void> | null = null;
  const requests = new Set<AbortController>();
  const clearPreview = () => { if (previewUrl.value) URL.revokeObjectURL(previewUrl.value); previewUrl.value = ''; previewError.value = ''; previewIdentity = ''; };
  const stopTimer = () => { clearTimeout(pollTimer); pollTimer = undefined; };
  function disconnect() {
    generation++; key = ''; stopTimer(); requests.forEach(request => request.abort()); requests.clear(); reading = null;
    connected.value = false; loading.value = false; action.value = null; dashboard.value = null; collector.value = null;
    authorAction.value = null; authorError.value = ''; authorSaved.value = 0;
    collectorError.value = ''; actionError.value = ''; clearPreview(); message.value = '管理密钥仅保存在当前页面内存中。';
  }
  function fail(error: unknown) {
    const code = error instanceof AdminApiError ? error.code : (error as Error)?.message;
    disconnect(); message.value = failureMessages[code] || failureMessages.HTTP_FAILURE;
  }
  async function call<T>(operation: (key: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(); requests.add(controller);
    try { return await operation(key, controller.signal); } finally { requests.delete(controller); }
  }
  function schedule() {
    stopTimer(); if (!connected.value) return;
    pollTimer = setTimeout(() => { void refresh(false); }, collector.value?.busy || activeLogin(collector.value) ? 4_000 : 15_000);
  }
  async function loadPreview(selected: number) {
    const restricted = collector.value?.login.status === 'restricted';
    if ((!activeLogin(collector.value) && !restricted) || !collector.value?.login.previewAvailable) { clearPreview(); return; }
    const identity = `${collector.value.login.status}:${collector.value.login.startedAt ?? ''}`;
    if (restricted && previewIdentity === identity) return;
    try {
      const blob = await call(api.preview); if (selected !== generation) return;
      clearPreview(); previewUrl.value = URL.createObjectURL(blob); previewIdentity = identity;
    } catch (error) {
      if (selected !== generation) return;
      if (error instanceof AdminApiError && error.code === 'UNAUTHORIZED') throw error;
      clearPreview(); previewError.value = restricted ? '无法显示访问受限页面，请以上方状态为准。' : '登录页面正在准备，请稍候；也可在专用浏览器中继续登录。';
      if (restricted) previewIdentity = identity;
    }
  }
  async function read(all: boolean, selected: number) {
    loading.value = all; stopTimer();
    try {
      const previousRun = collector.value?.run;
      if (all) {
        const result = await call(api.dashboard); if (selected !== generation) return;
        dashboard.value = dashboardModel(result);
      }
      let current: CollectorStatus;
      try { current = collectorModel(await call(api.collector)); }
      catch (error) {
        if (selected !== generation) return;
        if (error instanceof AdminApiError && error.code === 'UNAVAILABLE') {
          collector.value = null; clearPreview(); collectorError.value = '采集服务未连接，已发布的额度仍可查看。'; return;
        }
        throw error;
      }
      if (selected !== generation) return;
      collector.value = current; collectorError.value = '';
      if (!all && current.run && current.run.status !== 'running'
          && (previousRun?.id !== current.run.id || previousRun?.status !== current.run.status)) {
        const result = await call(api.dashboard); if (selected !== generation) return;
        dashboard.value = dashboardModel(result); message.value = '已加载本轮采集后的投票结果。';
      } else if (all) message.value = '已加载投票结果。';
      await loadPreview(selected);
    } catch (error) { if (selected === generation) fail(error); }
    finally { if (selected === generation) { loading.value = false; schedule(); } }
  }
  function refresh(all = true): Promise<void> {
    if (!connected.value || action.value || authorAction.value) return Promise.resolve();
    if (reading) return reading;
    const selected = generation;
    const work = read(all, selected); reading = work;
    void work.finally(() => { if (reading === work) reading = null; }); return work;
  }
  async function connect(value: string) {
    disconnect(); if (!value.trim()) return;
    key = value; connected.value = true; await refresh();
  }
  async function perform(kind: CollectorAction) {
    if (!connected.value || action.value || authorAction.value || kind !== 'cancel' && kind !== 'complete' && collector.value?.busy
        || kind === 'run' && (collector.value?.sources.length ?? 0) < 2) return;
    const selected = generation; action.value = kind; actionError.value = ''; stopTimer();
    // Mutations never overlap with an in-flight status/preview read.
    await reading; if (selected !== generation) return;
    try {
      const result = collectorModel(await call((currentKey, signal) => api.action(kind, currentKey, signal)));
      if (selected !== generation) return;
      collector.value = result; collectorError.value = '';
      if (kind === 'run') message.value = '采集已开始，完成后会自动更新投票结果。';
      if (kind === 'complete' && result.session.status === 'authenticated') message.value = '小红书登录已验证并保存。';
      if (!activeLogin(result) && result.login.status !== 'restricted') clearPreview();
      else await loadPreview(selected);
    } catch (error) {
      if (selected !== generation) return;
      if (error instanceof AdminApiError && error.code === 'BUSY') {
        actionError.value = kind === 'complete' ? '尚未确认登录成功，请完成扫码或页面验证后重试。' : '当前已有任务在运行，请等待完成后重试。';
      } else if (error instanceof AdminApiError && error.code === 'UNAVAILABLE') {
        collectorError.value = '采集服务未连接，请检查服务配置后刷新。'; clearPreview();
      } else fail(error);
    } finally {
      if (selected === generation) { action.value = null; schedule(); }
    }
  }
  async function changeAuthor(kind: 'add' | 'remove', input: AuthorInput | string) {
    if (!connected.value || action.value || authorAction.value || !collector.value?.available || collector.value.busy || activeLogin(collector.value)) return;
    const normalized = typeof input === 'string' ? input : normalizedAuthor(input);
    if (!normalized || typeof normalized === 'string' && !authorIdValid(normalized)) {
      authorError.value = '请填写 1–80 字昵称和有效的小红书作者主页链接。'; return;
    }
    const selected = generation; authorAction.value = kind === 'add' ? 'add' : String(normalized); authorError.value = ''; stopTimer();
    await reading; if (selected !== generation) return;
    try {
      // A status read may have discovered a run after the user clicked. Never edit its author snapshot.
      if (!collector.value?.available || collector.value.busy || activeLogin(collector.value)) {
        authorError.value = '当前有采集或登录任务，请等待完成后修改作者。'; return;
      }
      stopTimer();
      const result = collectorModel(await call((currentKey, signal) => typeof normalized === 'string'
        ? api.removeAuthor(normalized, currentKey, signal) : api.addAuthor(normalized, currentKey, signal)));
      if (selected !== generation) return;
      collector.value = result; collectorError.value = '';
      if (kind === 'add') authorSaved.value++;
      message.value = kind === 'add' ? '作者已添加，下次采集会使用新的作者列表。' : '作者已移除，已发布额度和历史采集记录保留。';
    } catch (error) {
      if (selected !== generation) return;
      const code = error instanceof AdminApiError ? error.code : '';
      const messages: Record<string, string> = {
        INVALID_INPUT: '昵称或主页链接无效，请检查后重试。',
        NOT_FOUND: '该作者已不存在，请刷新列表后重试。',
        BUSY: kind === 'add' ? '该作者已在列表中，或当前有任务正在执行，请检查后重试。' : '当前有任务正在执行，请等待完成后再移除。',
        UNAVAILABLE: '作者配置暂时无法保存，请稍后重试。',
      };
      if (messages[code]) authorError.value = messages[code];
      else fail(error);
    } finally {
      if (selected === generation) { authorAction.value = null; schedule(); }
    }
  }
  const addAuthor = (input: AuthorInput) => changeAuthor('add', input);
  const removeAuthor = (id: string) => changeAuthor('remove', id);
  const busy = computed(() => loading.value || action.value !== null || authorAction.value !== null || collector.value?.busy === true);
  const canRun = computed(() => connected.value && Boolean(collector.value?.available) && !busy.value && !activeLogin(collector.value)
    && (collector.value?.sources.length ?? 0) >= 2
    && !['expired', 'restricted', 'failed', 'checking'].includes(collector.value?.session.status ?? ''));
  const onPageHide = () => disconnect();
  window.addEventListener('pagehide', onPageHide);
  onBeforeUnmount(() => { disconnect(); window.removeEventListener('pagehide', onPageHide); });
  return { connected, loading, action, dashboard, collector, message, collectorError, actionError, previewUrl, previewError,
    busy, canRun, connect, disconnect, refresh, perform, authorAction, authorError, authorSaved, addAuthor, removeAuthor };
}
