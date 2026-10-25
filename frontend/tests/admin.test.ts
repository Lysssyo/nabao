import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import AdminPage from '../src/pages/AdminPage.vue';
import { createAdminApi } from '../src/api/admin';
import { AUTHORS } from './fixtures';
import type { CollectorStatus, DashboardPayload } from '../src/domain/types';
function table(): DashboardPayload {
  return { tableState: 'AVAILABLE', summaryState: 'AVAILABLE', table: { dataDate: '2026-10-23', notes: ['额度单位：元/日'], rows: [
    { fundCode: '040046', fundName: '纳斯达克<script>unsafe</script>', feeRate: '0.8%', distributorLimit: '100', directLimit: '待更新', trackingError: null, return1y: null },
  ] }, summary: { attemptedDate: '2026-10-24', lastAttempt: '2026-10-24T01:00:00Z', status: 'partial', errorCode: 'TABLE_PARTIAL_FIELDS', published: { adoptedFields: 2, pendingFields: 3 }, sources: AUTHORS.map(({ id, name }) => ({ authorId: id, name, status: 'partial', rowCount: 41, errorCode: 'SOURCE_PARTIAL_FIELDS' })) } };
}
function collector(): CollectorStatus {
  return { available: true, busy: false, session: { status: 'unchecked', checkedAt: null, message: '检查或登录你的小红书账号' }, run: null,
    schedule: { enabled: true, intervalMinutes: 360, nextRunAt: '2026-10-25T12:00:00Z' }, login: { status: 'idle', startedAt: null, expiresAt: null, verifiedAt: null, message: '', previewAvailable: false }, sources: AUTHORS };
}
function waiting(): CollectorStatus { const data = collector(); data.busy = true; data.login = { ...data.login, status: 'waiting', startedAt: '2026-10-25T00:00:00Z', expiresAt: '2026-10-25T00:10:00Z', message: '请扫码', previewAvailable: true }; return data; }
function running(): CollectorStatus { const data = collector(); data.busy = true; data.run = { id: 'run-1', trigger: 'manual', status: 'running', startedAt: '2026-10-25T00:00:00Z', finishedAt: null, result: null, errorCode: null, message: '正在采集五位作者' }; return data; }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const wrappers: VueWrapper[] = [];
function page(handler: (path: string, init: RequestInit) => Promise<Response> = async path => json(path.endsWith('table-status') ? table() : collector())) {
  const fetcher = vi.fn((path: string | URL | Request, init?: RequestInit) => handler(String(path), init ?? {}));
  const wrapper = mount(AdminPage, { props: { api: createAdminApi(fetcher as typeof fetch) } }); wrappers.push(wrapper);
  return { wrapper, fetcher, connect: async (key = 'test-management-key') => {
    await wrapper.get('#internal-key').setValue(key); await wrapper.get('form').trigger('submit'); await flushPromises();
  } };
}
const button = (wrapper: VueWrapper, text: string) => wrapper.findAll('button').find(item => item.text() === text)!;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:login-preview'); static revokeObjectURL = vi.fn(); }); });
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

test('Vue renders voted values, source counts and safe text without legacy controls', async () => {
  const { wrapper, fetcher, connect } = page(); await connect();
  expect(wrapper.findAll('tbody tr')).toHaveLength(1); expect(wrapper.get('.fund-cell').text()).toContain('<script>unsafe</script>');
  expect(wrapper.findAll('script')).toHaveLength(0); expect(wrapper.text()).not.toMatch(/历史任务|旧额度|旧来源|核验通过|部分数据可用|test-management-key/);
  expect(wrapper.get('.vote-metrics').text()).toContain('2 项已采用'); expect(wrapper.findAll('.source-item')).toHaveLength(5);
  expect(wrapper.findAll('.source-issue')).toHaveLength(0); expect(wrapper.get('.voting-rules').attributes('open')).toBeUndefined();
  expect(wrapper.text()).toContain('每 6 小时自动检查');
  expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual(['/internal/v1/table-status', '/internal/v1/collector']);
  for (const [, init] of fetcher.mock.calls) { expect(init?.headers).toEqual({ 'X-Internal-Key': 'test-management-key' }); expect(init?.cache).toBe('no-store'); expect(init?.credentials).toBe('omit'); }
});

test('table sorts the original quota strings, with sticky first-column markup and scroll region', async () => {
  const data = table(); data.table!.rows = ['待更新', '100*', '5千', '10', '不限额', '1万', '暂停'].map((distributorLimit, index) => ({ ...data.table!.rows[0], fundCode: String(100000 + index), distributorLimit }));
  const { wrapper, connect } = page(async path => json(path.endsWith('table-status') ? data : collector())); await connect();
  expect(wrapper.findAll('tbody tr').map(row => row.attributes('data-fund-code'))).toEqual(['100004', '100005', '100002', '100003', '100001', '100006', '100000']);
  expect(wrapper.get('[aria-sort]').attributes('aria-sort')).toBe('descending'); expect(wrapper.get('.conditional-limit').text()).toBe('100*');
  expect(wrapper.get('[role="region"]').attributes('tabindex')).toBe('0');
});

test('refresh reads results while immediate collection posts exactly once and disables repeat clicks', async () => {
  const pending = deferred<Response>();
  const { wrapper, fetcher, connect } = page(async (path, init) => path.endsWith('/runs') ? pending.promise : json(path.endsWith('table-status') ? table() : collector()));
  await connect(); await button(wrapper, '刷新结果').trigger('click'); await flushPromises();
  expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  await wrapper.get('.collect-button').trigger('click'); await flushPromises();
  await wrapper.get('.collect-button').trigger('click');
  expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith('/runs'))).toHaveLength(1);
  const post = fetcher.mock.calls.find(([path]) => String(path).endsWith('/runs'))!; expect(post[1]?.method).toBe('POST');
  expect(wrapper.get('.collect-button').attributes('disabled')).toBeDefined(); pending.resolve(json(running(), 202)); await flushPromises();
  expect(wrapper.text()).toContain('正在采集五位作者');
});

test('a completed collection automatically refreshes the table without claiming a newer date', async () => {
  let state = collector(), reads = 0;
  const { wrapper, connect } = page(async (path, init) => {
    if (path.endsWith('table-status')) { reads++; return json(table()); }
    if (path.endsWith('/runs')) { state = running(); return json(state, 202); }
    return json(state);
  }); await connect(); await wrapper.get('.collect-button').trigger('click'); await flushPromises();
  state = { ...state, busy: false, run: { ...state.run!, status: 'completed', finishedAt: '2026-10-25T00:01:00Z', result: 'no_new_post', message: '检查完成，未发现当日新表，保留现有投票结果。' } };
  await vi.advanceTimersByTimeAsync(4000); await flushPromises();
  expect(reads).toBe(2); expect(wrapper.text()).toContain('未发现当日新表'); expect(wrapper.text()).toContain('数据日期 2026-10-23');
});

test('polling never overlaps, including when requests take longer than the polling interval', async () => {
  const pending = deferred<Response>(); let reads = 0;
  const { connect, fetcher } = page(async path => {
    if (path.endsWith('table-status')) return json(table());
    reads++; return reads === 2 ? pending.promise : json(running());
  }); await connect(); await vi.advanceTimersByTimeAsync(4000); await vi.advanceTimersByTimeAsync(20000);
  expect(reads).toBe(2); pending.resolve(json(running())); await flushPromises(); await vi.advanceTimersByTimeAsync(4000); expect(reads).toBe(3);
  expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith('/runs'))).toHaveLength(0);
});

test('login preview uses authenticated blob requests, completion conflict keeps the login open', async () => {
  const { wrapper, fetcher, connect } = page(async (path, init) => {
    if (path.endsWith('/login/preview')) return new Response(new Blob(['image']), { headers: { 'Content-Type': 'image/png' } });
    if (path.endsWith('/login/complete')) return json({ detail: 'private server text' }, 409);
    if (path.endsWith('/login')) return json(waiting(), 202);
    return json(path.endsWith('table-status') ? table() : collector());
  }); await connect(); await button(wrapper, '登录小红书').trigger('click'); await flushPromises();
  expect(wrapper.get('.account-panel img').attributes('src')).toBe('blob:login-preview'); expect(wrapper.get('.collect-button').attributes('disabled')).toBeDefined();
  expect(fetcher.mock.calls.find(([path]) => String(path).endsWith('/preview'))?.[1]?.headers).toEqual({ 'X-Internal-Key': 'test-management-key' });
  await button(wrapper, '已完成登录').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('尚未确认登录成功'); expect(wrapper.find('.account-panel img').exists()).toBe(true); expect(wrapper.text()).not.toContain('private server text');
});

test('visible-browser fallback shows the actual page and manual instructions without claiming a QR exists', async () => {
  const manual = waiting(); manual.login.status = 'waiting_browser'; manual.login.message = '请在专用 Chrome 中完成登录。';
  const { wrapper, connect, fetcher } = page(async path => path.endsWith('/preview')
    ? new Response(new Blob(['page']), { headers: { 'Content-Type': 'image/png' } })
    : json(path.endsWith('table-status') ? table() : manual));
  await connect();
  expect(wrapper.get('.login-instructions').text()).toContain('尚未识别到可用二维码');
  expect(wrapper.text()).not.toContain('扫码后确认登录');
  expect(wrapper.get('.account-panel img').attributes('alt')).toBe('采集专用 Chrome 的当前页面');
  expect(wrapper.get('.collect-button').attributes('disabled')).toBeDefined();
  expect(button(wrapper, '已完成登录').attributes('disabled')).toBeUndefined();
  await vi.advanceTimersByTimeAsync(4000);
  expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});

test.each([
  ['starting', '正在开启登录'], ['waiting', '等待扫码'], ['waiting_browser', '等待确认'],
] as const)('active %s login displays the current step while preserving a prior restriction and collection pause', async (loginStatus, label) => {
  const state = waiting();
  state.login.status = loginStatus; state.login.previewAvailable = false;
  state.session = { status: 'restricted', checkedAt: '2026-10-25T00:00:00Z', message: '上次访问受限' };
  state.schedule = { ...state.schedule, enabled: false, nextRunAt: null };
  const { wrapper, connect, fetcher } = page(async path => json(path.endsWith('table-status') ? table() : state));
  await connect();
  const pill = wrapper.get('.account-panel .state-pill');
  expect(pill.text()).toBe(label); expect(pill.classes()).not.toContain('failed'); expect(pill.classes()).not.toContain('positive');
  expect(wrapper.get('.collection-panel .notice').text()).toContain('当前登录未完成，采集暂停');
  expect(wrapper.get('.collection-panel .notice').text()).not.toContain('访问受限');
  expect(wrapper.get('.collect-button').attributes('disabled')).toBeDefined();
  expect(state.session.status).toBe('restricted'); expect(state.schedule.enabled).toBe(false);
  await vi.advanceTimersByTimeAsync(4000);
  expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});

test('verified login clears preview, and cancel preserves the authenticated session returned by the server', async () => {
  for (const complete of [true, false]) {
    const done = collector(); done.session.status = 'authenticated'; done.login.status = complete ? 'authenticated' : 'cancelled';
    const { wrapper, connect, fetcher } = page(async (path, init) => {
      if (path.endsWith('/preview')) return new Response(new Blob(['image']), { headers: { 'Content-Type': 'image/png' } });
      if (path.endsWith('/complete') || init.method === 'DELETE') return json(done);
      if (path.endsWith('/login')) return json(waiting(), 202);
      return json(path.endsWith('table-status') ? table() : collector());
    }); await connect(); await button(wrapper, '登录小红书').trigger('click'); await flushPromises();
    await button(wrapper, complete ? '已完成登录' : '取消登录').trigger('click'); await flushPromises();
    expect(wrapper.find('.account-panel img').exists()).toBe(false); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:login-preview'); expect(wrapper.text()).toContain('已登录');
    if (!complete) expect(fetcher.mock.calls.find(([, init]) => init?.method === 'DELETE')).toBeDefined(); wrapper.unmount();
  }
});

test('checking a saved session performs the dedicated check action and shows its real result', async () => {
  const checking = collector(); checking.busy = true; checking.session.status = 'checking';
  const { wrapper, connect, fetcher } = page(async path => json(path.endsWith('table-status') ? table() : path.endsWith('/check') ? checking : collector()));
  await connect(); await button(wrapper, '检查登录状态').trigger('click'); await flushPromises();
  expect(fetcher.mock.calls.find(([path]) => String(path).endsWith('/session/check'))?.[1]?.method).toBe('POST');
  expect(wrapper.text()).toContain('正在检查登录'); expect(wrapper.get('.collect-button').attributes('disabled')).toBeDefined();
});

test('collector unavailable leaves voted table visible but cannot trigger a collection', async () => {
  const { wrapper, connect } = page(async path => path.endsWith('table-status') ? json(table()) : json({}, 503)); await connect();
  expect(wrapper.find('table').exists()).toBe(true); expect(wrapper.text()).toContain('采集服务未连接'); expect(wrapper.get('.collect-button').attributes('disabled')).toBeDefined();
});

test('network, unauthorized, and malformed successful responses clear old private data and credentials', async () => {
  for (const mode of ['network', 'unauthorized', 'malformed']) {
    let fail = false;
    const { wrapper, connect, fetcher } = page(async path => {
      if (fail) { if (mode === 'network') throw new Error('secret internal path'); return mode === 'unauthorized' ? json({}, 401) : json({ available: true }); }
      return json(path.endsWith('table-status') ? table() : collector());
    }); await connect(); fail = true; await button(wrapper, '刷新结果').trigger('click'); await flushPromises();
    expect(wrapper.find('table').exists()).toBe(false); expect(wrapper.find('#internal-key').exists()).toBe(true); expect(wrapper.text()).not.toMatch(/secret internal path|040046|test-management-key/);
    const requests = fetcher.mock.calls.length; await vi.advanceTimersByTimeAsync(30000); expect(fetcher.mock.calls.length).toBe(requests); wrapper.unmount();
  }
});

test('disconnect aborts old requests and late results cannot restore private data', async () => {
  const pending = deferred<Response>(); let count = 0;
  const { wrapper, connect, fetcher } = page(async path => { if (++count > 2) return pending.promise; return json(path.endsWith('table-status') ? table() : collector()); });
  await connect(); await button(wrapper, '刷新结果').trigger('click'); await flushPromises(); await button(wrapper, '断开连接').trigger('click');
  expect(fetcher.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true); pending.resolve(json(table())); await flushPromises();
  expect(wrapper.find('table').exists()).toBe(false); expect(wrapper.find('#internal-key').exists()).toBe(true);
});

test('pagehide removes preview, private values, credentials and future polling', async () => {
  const { wrapper, connect, fetcher } = page(async path => path.endsWith('/preview') ? new Response(new Blob(['image']), { headers: { 'Content-Type': 'image/png' } }) : json(path.endsWith('table-status') ? table() : waiting()));
  await connect(); expect(wrapper.find('.account-panel img').exists()).toBe(true); window.dispatchEvent(new Event('pagehide')); await flushPromises();
  expect(wrapper.find('.account-panel img').exists()).toBe(false); expect(wrapper.find('table').exists()).toBe(false); expect(URL.revokeObjectURL).toHaveBeenCalled();
  const count = fetcher.mock.calls.length; await vi.advanceTimersByTimeAsync(30000); expect(fetcher.mock.calls.length).toBe(count);
});

test('an old response cannot overwrite a newer authenticated connection', async () => {
  const pending = deferred<Response>();
  const { wrapper, fetcher, connect } = page(async (path, init) => {
    if ((init.headers as Record<string, string>)['X-Internal-Key'] === 'old-key') return pending.promise;
    const latest = table(); latest.table!.rows[0].fundName = '最新连接结果'; return json(path.endsWith('table-status') ? latest : collector());
  });
  await wrapper.get('#internal-key').setValue('old-key'); await wrapper.get('form').trigger('submit');
  await button(wrapper, '断开连接').trigger('click'); await connect('new-key'); pending.resolve(json(table())); await flushPromises();
  expect(wrapper.text()).toContain('最新连接结果'); expect(wrapper.text()).not.toContain('unsafe'); expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
});

test('inconsistent summary is withheld while the published voted table remains visible', async () => {
  const data = table(); data.summaryState = 'INCONSISTENT';
  const { wrapper, connect } = page(async path => json(path.endsWith('table-status') ? data : collector())); await connect();
  expect(wrapper.find('table').exists()).toBe(true); expect(wrapper.findAll('.source-item')).toHaveLength(0); expect(wrapper.find('.vote-metrics').exists()).toBe(false); expect(wrapper.text()).toContain('版本不一致');
});

test('a stalled fetch or JSON body times out, aborts work, and ignores late private results', async () => {
  for (const bodyStalls of [false, true]) {
    const pending = deferred<unknown>(); let count = 0;
    const { wrapper, connect, fetcher } = page(async path => {
      if (++count <= 2) return json(path.endsWith('table-status') ? table() : collector());
      if (bodyStalls) return { ok: true, status: 200, json: () => pending.promise } as Response;
      return pending.promise as Promise<Response>;
    }); await connect(); await button(wrapper, '刷新结果').trigger('click'); await flushPromises();
    await vi.advanceTimersByTimeAsync(25000); await flushPromises();
    expect(wrapper.find('table').exists()).toBe(false); expect(wrapper.text()).toContain('服务响应超时');
    expect(fetcher.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
    pending.resolve(bodyStalls ? table() : json(table())); await flushPromises();
    expect(wrapper.find('table').exists()).toBe(false); wrapper.unmount();
  }
});

test('an invalid preview is never displayed as HTML or a remote URL', async () => {
  const { wrapper, connect } = page(async path => path.endsWith('/preview') ? new Response('<script>private</script>', { headers: { 'Content-Type': 'text/html' } }) : json(path.endsWith('table-status') ? table() : waiting()));
  await connect(); expect(wrapper.find('.account-panel img').exists()).toBe(false); expect(wrapper.text()).not.toContain('<script>private');
  expect(wrapper.text()).toContain('登录页面正在准备');
});

test('login completion allows the backend validation deadline and never retries the mutation', async () => {
  const pending = deferred<Response>();
  const { wrapper, connect, fetcher } = page(async path => {
    if (path.endsWith('/complete')) return pending.promise;
    if (path.endsWith('/preview')) return new Response(new Blob(['image']), { headers: { 'Content-Type': 'image/png' } });
    return json(path.endsWith('table-status') ? table() : waiting());
  }); await connect(); await button(wrapper, '已完成登录').trigger('click'); await flushPromises();
  await vi.advanceTimersByTimeAsync(60000); expect(wrapper.text()).toContain('正在验证'); expect(wrapper.find('table').exists()).toBe(true);
  await vi.advanceTimersByTimeAsync(5000); await flushPromises(); expect(wrapper.text()).toContain('服务响应超时');
  expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith('/complete'))).toHaveLength(1);
  pending.resolve(json(collector())); await flushPromises(); expect(wrapper.find('table').exists()).toBe(false);
});

test('restricted access shows the failure page once, blocks collection and never offers QR completion', async () => {
  const restricted = collector(); restricted.session.status = 'restricted'; restricted.session.message = '小红书访问受限，未生成登录二维码。';
  restricted.login = { ...restricted.login, status: 'restricted', startedAt: '2026-10-25T00:00:00Z', message: restricted.session.message, previewAvailable: true };
  const { wrapper, connect, fetcher } = page(async path => path.endsWith('/preview') ? new Response(new Blob(['restricted-page']), { headers: { 'Content-Type': 'image/png' } }) : json(path.endsWith('table-status') ? table() : restricted));
  await connect(); expect(wrapper.text()).toContain('访问受限'); expect(wrapper.text()).toContain('未生成登录二维码');
  expect(wrapper.text()).not.toMatch(/扫码|已完成登录|取消登录/); expect(wrapper.get('.account-panel img').attributes('alt')).toBe('小红书访问受限页面');
  expect(wrapper.get('.collect-button').attributes('disabled')).toBeDefined(); expect(button(wrapper, '恢复登录').attributes('disabled')).toBeUndefined();
  expect(wrapper.get('.restriction-details').attributes('open')).toBeUndefined();
  await vi.advanceTimersByTimeAsync(45000); await flushPromises();
  expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith('/preview'))).toHaveLength(1);
  expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});

test('a failed recheck stays visible beside the existing restriction and never restarts login automatically', async () => {
  const state = collector(); state.session = { status: 'failed', checkedAt: '2026-10-25T00:02:00Z', message: '会话检查失败，请检查网络。' };
  state.schedule = { ...state.schedule, enabled: false, nextRunAt: null };
  state.login = { ...state.login, status: 'restricted', message: '先前访问受限', previewAvailable: false };
  const { wrapper, connect, fetcher } = page(async path => json(path.endsWith('table-status') ? table() : state));
  await connect();
  expect(wrapper.get('.account-message').text()).toContain('会话检查失败');
  expect(wrapper.get('.account-recovery').text()).toContain('自动采集已暂停');
  expect(wrapper.get('.collect-button').attributes('disabled')).toBeDefined();
  await vi.advanceTimersByTimeAsync(30000);
  expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});

test('a restriction returned by a login action does not retain an earlier QR or claim success', async () => {
  const restricted = collector(); restricted.session.status = 'restricted'; restricted.session.message = '访问受限，未生成登录二维码。';
  restricted.login = { ...restricted.login, status: 'restricted', startedAt: '2026-10-25T00:00:00Z', previewAvailable: true, message: restricted.session.message };
  const { wrapper, connect, fetcher } = page(async (path, init) => {
    if (path.endsWith('/preview')) return new Response(new Blob(['failure']), { headers: { 'Content-Type': 'image/png' } });
    return json(path.endsWith('table-status') ? table() : path.endsWith('/login') ? restricted : collector());
  }); await connect(); await button(wrapper, '登录小红书').trigger('click'); await flushPromises();
  expect(wrapper.get('.account-panel img').attributes('alt')).toBe('小红书访问受限页面'); expect(wrapper.text()).not.toMatch(/扫码后确认|已完成登录|登录已验证并保存/);
  expect(wrapper.get('.collect-button').attributes('disabled')).toBeDefined();
  expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith('/login'))).toHaveLength(1);
});

const sixthAuthor = { id: 'abcdef0123456789abcdef01', name: '新增作者', profileUrl: 'https://www.xiaohongshu.com/user/profile/abcdef0123456789abcdef01' };
async function fillAuthor(wrapper: VueWrapper, name = sixthAuthor.name, url = sixthAuthor.profileUrl) {
  await wrapper.get('#author-name').setValue(name); await wrapper.get('#author-profile').setValue(url);
}

test('authors can be added and removed without starting collection or changing the previous run snapshot', async () => {
  let state = collector();
  const { wrapper, connect, fetcher } = page(async (path, init) => {
    if (path.endsWith('/authors') && init.method === 'POST') {
      const input = JSON.parse(String(init.body)); state = { ...state, sources: [...state.sources, { id: sixthAuthor.id, ...input }] }; return json(state);
    }
    if (path.endsWith(`/authors/${AUTHORS[0].id}`) && init.method === 'DELETE') {
      state = { ...state, sources: state.sources.filter(source => source.id !== AUTHORS[0].id) }; return json(state);
    }
    return json(path.endsWith('table-status') ? table() : state);
  });
  await connect();
  expect(wrapper.findAll('.author-row')).toHaveLength(5);
  await fillAuthor(wrapper, '  新增作者  ', `${sixthAuthor.profileUrl.toUpperCase().replace('HTTPS://WWW.XIAOHONGSHU.COM/USER/PROFILE/', 'https://www.xiaohongshu.com/user/profile/')}?xsec_token=discard#profile`);
  await wrapper.get('.author-form').trigger('submit'); await flushPromises();
  expect(wrapper.findAll('.author-row')).toHaveLength(6); expect(wrapper.get('.collection-panel .subtle').text()).toContain('6 位作者');
  const post = fetcher.mock.calls.find(([path]) => String(path).endsWith('/authors'))!;
  expect(post[1]?.headers).toEqual({ 'X-Internal-Key': 'test-management-key', 'Content-Type': 'application/json' });
  expect(JSON.parse(String(post[1]?.body))).toEqual({ name: sixthAuthor.name, profileUrl: sixthAuthor.profileUrl });
  expect((wrapper.get('#author-name').element as HTMLInputElement).value).toBe('');
  const original = wrapper.get(`.author-row[data-author-id="${AUTHORS[0].id}"]`);
  await original.get('button').trigger('click'); await flushPromises();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
  await button(wrapper, '取消').trigger('click'); await original.get('button').trigger('click');
  await button(wrapper, '确认移除').trigger('click'); await flushPromises();
  expect(wrapper.findAll('.author-row')).toHaveLength(5); expect(wrapper.find(`.author-row[data-author-id="${AUTHORS[0].id}"]`).exists()).toBe(false);
  expect(wrapper.get('.source-details').text()).toContain(AUTHORS[0].name);
  expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith('/runs'))).toHaveLength(0);
  expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith('table-status'))).toHaveLength(1);
});

test.each([0, 1])('%i configured authors still allow maintenance but require two before collection', async count => {
  let state = { ...collector(), sources: AUTHORS.slice(0, count) };
  const { wrapper, connect, fetcher } = page(async (path, init) => {
    if (init.method === 'DELETE') { state = { ...state, sources: [] }; return json(state); }
    return json(path.endsWith('table-status') ? table() : state);
  }); await connect();
  expect(wrapper.text()).toContain('至少添加两位作者才能采集'); expect(wrapper.get('.collect-button').attributes('disabled')).toBeDefined();
  expect(wrapper.get('.author-form fieldset').attributes('disabled')).toBeUndefined();
  if (count) {
    await wrapper.get('.author-row button').trigger('click'); await button(wrapper, '确认移除').trigger('click'); await flushPromises();
    expect(wrapper.findAll('.author-row')).toHaveLength(0);
  }
  await wrapper.get('.collect-button').trigger('click');
  expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith('/runs'))).toHaveLength(0);
});

test.each([400, 404, 409])('author mutation %i errors retain the form, connection and list without automatic retry', async code => {
  const { wrapper, connect, fetcher } = page(async (path, init) => init.method === 'POST'
    ? json({ detail: '<script>private server text</script>' }, code) : json(path.endsWith('table-status') ? table() : collector()));
  await connect(); await fillAuthor(wrapper); await wrapper.get('.author-form').trigger('submit'); await flushPromises();
  expect(wrapper.find('.author-error').exists()).toBe(true); expect(wrapper.find('table').exists()).toBe(true);
  expect((wrapper.get('#author-name').element as HTMLInputElement).value).toBe(sixthAuthor.name);
  expect(wrapper.findAll('.author-row')).toHaveLength(5); expect(wrapper.text()).not.toContain('private server text');
  await vi.advanceTimersByTimeAsync(30000);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

test('author editing is disabled during collection, login and session checks', async () => {
  const checking = collector(); checking.busy = true; checking.session.status = 'checking';
  for (const state of [running(), waiting(), checking]) {
    const { wrapper, connect, fetcher } = page(async path => json(path.endsWith('table-status') ? table() : state)); await connect();
    expect(wrapper.get('.author-form fieldset').attributes('disabled')).toBeDefined();
    expect(wrapper.get('.author-row button').attributes('disabled')).toBeDefined();
    await fillAuthor(wrapper); await wrapper.get('.author-form').trigger('submit'); await flushPromises();
    expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true); wrapper.unmount();
  }
});

test('an author mutation waits for a status read, blocks repeated mutations, and late results cannot restore a disconnected view', async () => {
  const pendingRead = deferred<Response>(), pendingWrite = deferred<Response>(); let reads = 0;
  const { wrapper, connect, fetcher } = page(async (path, init) => {
    if (path.endsWith('table-status')) return json(table());
    if (init.method === 'POST') return pendingWrite.promise;
    return ++reads === 2 ? pendingRead.promise : json(collector());
  }); await connect(); await vi.advanceTimersByTimeAsync(15000); await fillAuthor(wrapper); await wrapper.get('.author-form').trigger('submit'); await flushPromises();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  pendingRead.resolve(json(collector())); await flushPromises();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  await wrapper.get('.author-form').trigger('submit'); await wrapper.get('.collect-button').trigger('click'); await vi.advanceTimersByTimeAsync(30000);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method !== 'GET')).toHaveLength(1);
  await button(wrapper, '断开连接').trigger('click'); pendingWrite.resolve(json({ ...collector(), sources: [...AUTHORS, sixthAuthor] })); await flushPromises();
  expect(wrapper.find('.author-panel').exists()).toBe(false); expect(wrapper.text()).not.toContain(sixthAuthor.name);
});

test('a newly busy status discovered before saving authors prevents the mutation', async () => {
  const pending = deferred<Response>(); let reads = 0;
  const { wrapper, connect, fetcher } = page(async path => path.endsWith('table-status') ? json(table()) : ++reads === 1 ? json(collector()) : pending.promise);
  await connect(); await vi.advanceTimersByTimeAsync(15000); await fillAuthor(wrapper); await wrapper.get('.author-form').trigger('submit');
  pending.resolve(json(running())); await flushPromises();
  expect(wrapper.get('.author-error').text()).toContain('等待完成'); expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});

test('dynamic run snapshots preserve six historical author names and author links cannot inject active content', async () => {
  const data = table(); data.summary!.sources.push({ authorId: sixthAuthor.id, name: '历史<script>名称</script>', status: 'partial', rowCount: 2 });
  const state = collector(); state.sources = [{ ...sixthAuthor, name: '当前<img src=x onerror=alert(1)>' }];
  const { wrapper, connect } = page(async path => json(path.endsWith('table-status') ? data : state)); await connect();
  expect(wrapper.findAll('.source-item')).toHaveLength(6); expect(wrapper.get('.source-details').text()).toContain('历史<script>名称</script>');
  expect(wrapper.get('.author-identity').text()).toContain('当前<img src=x onerror=alert(1)>');
  expect(wrapper.get('.author-identity a').attributes('href')).toBe(sixthAuthor.profileUrl);
  expect(wrapper.findAll('script, .source-details img, .author-panel img')).toHaveLength(0);
});

test('invalid author links are rejected locally and authorization failures clear private author data', async () => {
  const { wrapper, connect, fetcher } = page(async (path, init) => init.method === 'POST' ? json({}, 401) : json(path.endsWith('table-status') ? table() : collector()));
  await connect(); await fillAuthor(wrapper, '作者', 'https://www.xiaohongshu.com.evil.example/user/profile/abcdef0123456789abcdef01');
  await wrapper.get('.author-form').trigger('submit'); await flushPromises();
  expect(wrapper.get('.author-error').text()).toContain('作者主页链接'); expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  await fillAuthor(wrapper); await wrapper.get('.author-form').trigger('submit'); await flushPromises();
  expect(wrapper.find('.author-panel').exists()).toBe(false); expect(wrapper.find('#internal-key').exists()).toBe(true);
  expect(wrapper.text()).not.toContain(sixthAuthor.name);
});
