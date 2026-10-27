export const AUDIT_FIELDS: Record<string, string> = { feeRate: '费率', distributorLimit: '代销额度', directLimit: '直销额度', trackingError: '跟踪误差', return1y: '近一年表现' };
export interface AuditSource { authorId: string; name: string; status: string }
export interface AuditSummary { id: string; dataDate: string; recordedAt: string; rule: string; publicationStatus: string; sources: AuditSource[]; entryCount: number }
export interface AuditEntry { authorId: string; authorName: string; noteId: string; sourceUrl: string; sourceDate: string; capturedAt: string;
  fundCode: string; fundName: string; field: string; rawValue: string | null; normalizedValue: string | null;
  voteKey: string | null; notes: string[]; ballotStatus: string; decisionStatus: string; adoptedValue: string | null; supportCount: number }
export interface AuditPage { batch: AuditSummary; total: number; page: number; pageSize: number; entries: AuditEntry[] }
export function auditBallotLabel(entry: AuditEntry): string {
  if (entry.ballotStatus === 'NO_VALUE') return entry.notes.find(n => n.startsWith('计票说明：'))?.slice(5) ?? '未形成有效票';
  return ({ COUNTED: '已计票', SUPERSEDED: '同作者新记录替代', NO_VALUE: '未形成有效票', WITHDRAWN: '作者撤回', OTHER_DATE: '非本轮日期，未计票' })[entry.ballotStatus] ?? entry.ballotStatus;
}
export function auditDecisionLabel(entry: AuditEntry): string {
  if (entry.decisionStatus === 'ADOPTED') return `${entry.adoptedValue ?? ''}（${entry.supportCount} 票）`;
  return entry.decisionStatus === 'TIE' ? '最高票并列' : '无有效票';
}

export interface AuditFund { fundCode: string; fundName: string }
export interface ComparisonCell { author: AuditSource; entry: AuditEntry | null; history: AuditEntry[]; winner: boolean; label: string }
export interface ComparisonRow { field: string; label: string; adoptedValue: string | null; support: number; status: string; tally: string; cells: ComparisonCell[] }
/** Present persisted decisions. Never re-run voting or replace missing votes with another date. */
export function compareFundVotes(entries: AuditEntry[], sources: AuditSource[], fundCode: string): ComparisonRow[] {
  const fund = entries.filter(e => e.fundCode === fundCode);
  return Object.entries(AUDIT_FIELDS).map(([field,label]) => {
    const fieldEntries = fund.filter(e => e.field === field);
    const decision = fieldEntries.find(e => e.ballotStatus === 'COUNTED') ?? fieldEntries[0];
    const cells = sources.map(author => {
      const history = fieldEntries.filter(e => e.authorId === author.authorId)
        .sort((a,b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
      const entry = history.find(e => e.ballotStatus === 'COUNTED') ?? history.find(e => e.ballotStatus === 'WITHDRAWN') ?? history.find(e => e.ballotStatus === 'NO_VALUE') ?? history[0] ?? null;
      return { author, entry, history, winner: false, label: entry ? auditBallotLabel(entry) : author.status === 'NO_TODAY_TABLE' ? '无当日表' : '未提供此字段' };
    });
    const groups = new Map<string, Set<string>>();
    for (const cell of cells) {
      const entry = cell.entry;
      if (entry?.ballotStatus === 'COUNTED' && entry.voteKey) {
        const authors = groups.get(entry.voteKey) ?? new Set<string>(); authors.add(entry.authorId); groups.set(entry.voteKey, authors);
      }
    }
    const ranked = [...groups].sort((a,b) => b[1].size-a[1].size);
    const winningKey = decision?.decisionStatus === 'ADOPTED' && ranked[0] && (!ranked[1] || ranked[0][1].size > ranked[1][1].size) ? ranked[0][0] : null;
    cells.forEach(cell => { cell.winner = Boolean(cell.entry?.ballotStatus === 'COUNTED' && winningKey && cell.entry.voteKey === winningKey); });
    return { field,label,adoptedValue:decision?.adoptedValue ?? null,support:decision?.supportCount ?? 0,
      status:decision?.decisionStatus ?? 'INSUFFICIENT',tally:ranked.map(([,v])=>v.size).join(' : '),cells };
  });
}
