import { expect, test } from 'vitest';
import { authorProfile, normalizedAuthor } from '../src/domain/authors';
import { collectorModel } from '../src/domain/collector';
import { dashboardModel } from '../src/domain/table';
import type { CollectorStatus } from '../src/domain/types';
const id = 'abcdef0123456789abcdef01';
const profileUrl = `https://www.xiaohongshu.com/user/profile/${id}`;
const status = (): CollectorStatus => ({ available: true, busy: false, sources: [{ id, name: '作者', profileUrl }], run: null,
  session: { status: 'unchecked', checkedAt: null, message: '' }, schedule: { enabled: false, intervalMinutes: 360, nextRunAt: null },
  login: { status: 'idle', startedAt: null, expiresAt: null, verifiedAt: null, message: '', previewAvailable: false } });

test('profile validation accepts canonical XHS authors and rejects credentials, foreign hosts, short links and routes', () => {
  expect(normalizedAuthor({ name: '  作者  ', profileUrl: `${profileUrl.toUpperCase().replace('/USER/PROFILE/', '/user/profile/')}/?token=private#fragment` }))
    .toEqual({ name: '作者', profileUrl });
  for (const url of [`http://www.xiaohongshu.com/user/profile/${id}`, `https://xiaohongshu.com/user/profile/${id}`,
    `https://www.xiaohongshu.com.evil.test/user/profile/${id}`, `https://user@www.xiaohongshu.com/user/profile/${id}`,
    `https://www.xiaohongshu.com:444/user/profile/${id}`, 'https://xhslink.com/abc', 'javascript:alert(1)',
    `https://www.xiaohongshu.com/explore/${id}`]) expect(authorProfile(url)).toBeNull();
  expect(normalizedAuthor({ name: ' '.repeat(4), profileUrl })).toBeNull();
  expect(normalizedAuthor({ name: '字'.repeat(81), profileUrl })).toBeNull();
});

test('dynamic author status allows zero, rejects duplicates, unsafe URLs, mismatched IDs and more than fifty authors', () => {
  expect(collectorModel({ ...status(), sources: [] }).sources).toEqual([]);
  for (const sources of [[status().sources[0], status().sources[0]], [{ id, name: '作者', profileUrl: 'javascript:alert(1)' }],
    [{ id, name: '作者', profileUrl: profileUrl.replace(id, '123456789012345678901234') }],
    Array.from({ length: 51 }, (_, index) => ({ id: index.toString(16).padStart(24, '0'), name: '作者' }))]) {
    expect(() => collectorModel({ ...status(), sources })).toThrow('INVALID_RESPONSE');
  }
});

test('historical summary names and order are independent of current author configuration', () => {
  const sources = [{ authorId: id, name: '当轮昵称', status: 'partial', rowCount: 2 },
    { authorId: '123456789012345678901234', status: 'failed', rowCount: 0 }];
  const model = dashboardModel({ tableState: 'MISSING', summaryState: 'AVAILABLE', summary: { attemptedDate: '2026-10-25', status: 'partial', sources } });
  expect(model.summary?.sources.map(source => source.name)).toEqual(['当轮昵称', '123456789012345678901234']);
  expect(sources[1]).not.toHaveProperty('name');
});
