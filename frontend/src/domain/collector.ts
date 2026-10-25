import type { CollectorStatus } from './types';
import { authorIdValid, authorNameValid, authorProfile } from './authors';
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const optionalDate = (value: unknown) => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value));
const oneOf = (value: unknown, values: string[]) => typeof value === 'string' && values.includes(value);
export function collectorModel(value: unknown): CollectorStatus {
  if (!record(value) || typeof value.available !== 'boolean' || typeof value.busy !== 'boolean'
      || !record(value.session) || !oneOf(value.session.status, ['unchecked', 'checking', 'authenticated', 'expired', 'restricted', 'failed'])
      || !optionalDate(value.session.checkedAt) || typeof value.session.message !== 'string'
      || !record(value.schedule) || typeof value.schedule.enabled !== 'boolean'
      || typeof value.schedule.intervalMinutes !== 'number' || value.schedule.intervalMinutes <= 0
      || !optionalDate(value.schedule.nextRunAt)
      || !record(value.login) || !oneOf(value.login.status, ['idle', 'starting', 'waiting', 'waiting_browser', 'authenticated', 'expired', 'restricted', 'cancelled', 'failed'])
      || !['startedAt', 'expiresAt', 'verifiedAt'].every(key => optionalDate((value.login as Record<string, unknown>)[key]))
      || typeof value.login.message !== 'string' || typeof value.login.previewAvailable !== 'boolean'
      || !Array.isArray(value.sources) || value.sources.length > 50
      || !value.sources.every(source => record(source) && authorIdValid(source.id) && authorNameValid(source.name)
        && (source.profileUrl === undefined || typeof source.profileUrl === 'string' && authorProfile(source.profileUrl)?.id === source.id))
      || new Set(value.sources.map(source => source.id)).size !== value.sources.length) throw new Error('INVALID_RESPONSE');
  if (value.run !== null && (!record(value.run) || typeof value.run.id !== 'string'
      || !oneOf(value.run.status, ['running', 'completed', 'failed', 'interrupted'])
      || !oneOf(value.run.trigger, ['manual', 'scheduled']) || typeof value.run.message !== 'string'
      || typeof value.run.startedAt !== 'string' || !optionalDate(value.run.startedAt) || !optionalDate(value.run.finishedAt)
      || !(value.run.result === null || typeof value.run.result === 'string')
      || !(value.run.errorCode === null || typeof value.run.errorCode === 'string'))) throw new Error('INVALID_RESPONSE');
  return value as unknown as CollectorStatus;
}
export const activeLogin = (status: CollectorStatus | null) => ['starting', 'waiting', 'waiting_browser'].includes(status?.login.status ?? '');
export const sessionLabel = (status: CollectorStatus['session']['status']) => ({
  unchecked: '尚未检查', checking: '正在检查登录', authenticated: '已登录', expired: '登录已失效', restricted: '访问受限', failed: '登录检查失败',
})[status];
export const runLabel = (status: CollectorStatus['run']) => status ? ({ running: '采集中', completed: '本轮已完成', failed: '采集失败', interrupted: '采集中断' })[status.status] : '等待首次采集';
export function scheduleLabel(status: CollectorStatus['schedule']) {
  if (!status.enabled) return '定时更新未开启';
  const interval = status.intervalMinutes % 60 === 0 ? `${status.intervalMinutes / 60} 小时` : `${status.intervalMinutes} 分钟`;
  return `每 ${interval}自动检查`;
}
