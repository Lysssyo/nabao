export interface FundRow {
  fundCode: string; fundName: string; distributorLimit: string; directLimit: string;
  feeRate: string | null; trackingError: string | null; return1y: string | null;
}
export interface DailyTable { dataDate: string; updatedAt?: string; notes?: string[]; rows: FundRow[] }
export interface SourceStatus { authorId: string; name?: string; status: string; rowCount: number | null; errorCode?: string | null }
export interface TableSummary {
  attemptedDate: string; lastAttempt?: string; lastSuccess?: string; status: string; errorCode?: string | null;
  published?: { adoptedFields: number; pendingFields: number } | null; sources: SourceStatus[];
}
export interface DashboardPayload {
  tableState: 'AVAILABLE' | 'MISSING' | 'INVALID'; summaryState: 'AVAILABLE' | 'MISSING' | 'INVALID' | 'INCONSISTENT' | 'STALE';
  table?: DailyTable | null; summary?: TableSummary | null;
}
export interface Dashboard { table: DailyTable | null; summary: TableSummary | null; notice: string; tableState: DashboardPayload['tableState'] }
export interface CollectorRun {
  id: string; trigger: 'manual' | 'scheduled'; status: 'running' | 'completed' | 'failed' | 'interrupted';
  startedAt: string; finishedAt: string | null; result: string | null; message: string; errorCode: string | null;
}
export interface CollectorStatus {
  available: boolean; busy: boolean;
  session: { status: 'unchecked' | 'checking' | 'authenticated' | 'expired' | 'restricted' | 'failed'; checkedAt: string | null; message: string };
  run: CollectorRun | null;
  schedule: { enabled: boolean; intervalMinutes: number; nextRunAt: string | null };
  login: { status: 'idle' | 'starting' | 'waiting' | 'waiting_browser' | 'authenticated' | 'expired' | 'restricted' | 'cancelled' | 'failed'; startedAt: string | null; expiresAt: string | null; verifiedAt: string | null; message: string; previewAvailable: boolean };
  sources: CollectorAuthor[];
}
export interface CollectorAuthor { id: string; name: string; profileUrl?: string }
export interface AuthorInput { name: string; profileUrl: string }
export type CollectorAction = 'run' | 'login' | 'complete' | 'cancel' | 'check';
