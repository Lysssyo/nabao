import type { AuthorInput, CollectorAction } from '../domain/types';
export type ApiCode = 'ABORTED' | 'TIMEOUT' | 'NETWORK' | 'UNAUTHORIZED' | 'UNAVAILABLE' | 'BUSY' | 'INVALID_INPUT' | 'NOT_FOUND' | 'INVALID_RESPONSE' | 'HTTP_FAILURE';
export class AdminApiError extends Error {
  constructor(public code: ApiCode) { super(code); }
}
const paths: Record<CollectorAction, [string, string]> = {
  run: ['/runs', 'POST'], login: ['/login', 'POST'], complete: ['/login/complete', 'POST'],
  cancel: ['/login', 'DELETE'], check: ['/session/check', 'POST'],
};
export function createAdminApi(fetchImpl: typeof fetch = globalThis.fetch) {
  async function request(path: string, key: string, signal: AbortSignal, method = 'GET', body?: AuthorInput) {
    let response: Response;
    try {
      response = await fetchImpl(path, { method, headers: { 'X-Internal-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        credentials: 'omit', cache: 'no-store', signal, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch (error) { throw new AdminApiError(signal.aborted || (error as Error)?.name === 'AbortError' ? 'ABORTED' : 'NETWORK'); }
    if (!response.ok) throw new AdminApiError(response.status === 401 || response.status === 403 ? 'UNAUTHORIZED'
      : response.status === 409 ? 'BUSY' : response.status === 400 ? 'INVALID_INPUT' : response.status === 404 ? 'NOT_FOUND'
        : response.status === 503 ? 'UNAVAILABLE' : 'HTTP_FAILURE');
    return response;
  }
  async function bounded<T>(signal: AbortSignal, operation: (innerSignal: AbortSignal) => Promise<T>, timeoutMs = 25_000): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    try {
      const deadline = new Promise<never>((_, reject) => {
        cancel = () => { controller.abort(); reject(new AdminApiError('ABORTED')); };
        signal.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(() => { controller.abort(); reject(new AdminApiError('TIMEOUT')); }, timeoutMs);
        if (signal.aborted) cancel();
      });
      return await Promise.race([operation(controller.signal), deadline]);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
  }
  async function json(path: string, key: string, signal: AbortSignal, method = 'GET', body?: AuthorInput): Promise<unknown> {
    return bounded(signal, async innerSignal => {
      const response = await request(path, key, innerSignal, method, body);
      try { return await response.json(); } catch { throw new AdminApiError('INVALID_RESPONSE'); }
    }, method === 'GET' ? 25_000 : 65_000);
  }
  return {
    auditBatches: (key: string, signal: AbortSignal) => json('/internal/v1/vote-audits', key, signal),
    auditFunds: (id: string, key: string, signal: AbortSignal) => json(`/internal/v1/vote-audits/${encodeURIComponent(id)}/funds`, key, signal),
    auditEntries: (id: string, authorId: string, field: string, page: number, key: string, signal: AbortSignal, fundCode = '') => {
      const query = new URLSearchParams({ page: String(page) });
      if (authorId) query.set('authorId', authorId);
      if (field) query.set('field', field);
      if (fundCode) query.set('fundCode', fundCode);
      return json(`/internal/v1/vote-audits/${encodeURIComponent(id)}?${query}`, key, signal);
    },
    dashboard: (key: string, signal: AbortSignal) => json('/internal/v1/table-status', key, signal),
    collector: (key: string, signal: AbortSignal) => json('/internal/v1/collector', key, signal),
    action: (action: CollectorAction, key: string, signal: AbortSignal) => {
      const [path, method] = paths[action]; return json(`/internal/v1/collector${path}`, key, signal, method);
    },
    addAuthor: (input: AuthorInput, key: string, signal: AbortSignal) => json('/internal/v1/collector/authors', key, signal, 'POST', input),
    removeAuthor: (id: string, key: string, signal: AbortSignal) => json(`/internal/v1/collector/authors/${encodeURIComponent(id)}`, key, signal, 'DELETE'),
    async preview(key: string, signal: AbortSignal) {
      return bounded(signal, async innerSignal => {
        const response = await request('/internal/v1/collector/login/preview', key, innerSignal);
        if (response.headers.get('Content-Type')?.split(';')[0] !== 'image/png') throw new AdminApiError('INVALID_RESPONSE');
        const blob = await response.blob();
        if (blob.size > 8 * 1024 * 1024) throw new AdminApiError('INVALID_RESPONSE');
        return blob;
      });
    },
  };
}
export type AdminApi = ReturnType<typeof createAdminApi>;
