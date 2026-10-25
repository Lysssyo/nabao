import type { Dashboard, DashboardPayload, SourceStatus, TableSummary } from "./types";
import { authorIdValid, authorNameValid } from './authors';

const numberPattern = "(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.[0-9]{1,2})?";
const amountPattern = new RegExp(`^(?:人民币\\s*|[¥￥]\\s*)?(${numberPattern})\\s*(千|万)?\\s*元?(?:\\s*[/／]\\s*(?:日|天))?$`);
const maximumMinor = 9_007_199_254_740_991n;
const unsafeConditional = /美元|美金|港元|港币|USD|HKD|\$|[%％]|合并|共享|共用|合计|总计|累计|分别|代码|[→⇒~～至]|->|[-–—]/i;

function amountMinor(value: string): bigint | null {
  const match = amountPattern.exec(value);
  if (!match) return null;
  const [whole, fraction = ""] = match[1].replaceAll(",", "").split(".");
  const unit = match[2] === "万" ? 10_000n : match[2] === "千" ? 1_000n : 1n;
  const minor = (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"))) * unit;
  return minor <= maximumMinor ? minor : null;
}

/** Sort keys never replace the displayed source text or infer unconditional limits. */
export function quotaSortKey(raw: unknown): { bucket: number; amount: bigint | null } {
  const value = typeof raw === "string" ? raw.normalize("NFC").replaceAll("，", ",").replaceAll("．", ".").trim() : "";
  if (/^(?:不限额|不限|无限额)$/.test(value)) return { bucket: 0, amount: null };
  const amount = amountMinor(value);
  if (amount !== null) return { bucket: amount > 0n ? 1 : 3, amount };
  if (/^(?:暂停|暂停申购)$/.test(value)) return { bucket: 3, amount: null };
  if (/^(?:无|无代销|未销售|不可用)$/.test(value)) return { bucket: 4, amount: null };
  if (!value || /^(?:待更新|未知|—|-)$/.test(value)) return { bucket: 5, amount: null };
  // Rank one annotated amount only within its own bucket. Never guess ranges or shared limits.
  const tokens = [...value.matchAll(/[0-9]+(?:[,.][0-9]+)*/g)];
  let conditionalAmount: bigint | null = null;
  if (!unsafeConditional.test(value) && tokens.length === 1) {
    const token = tokens[0]!;
    const before = value[token.index! - 1] || "";
    const after = value[token.index! + token[0].length] || "";
    if (!/[.,]/.test(before) && !/[.,]/.test(after)) {
      const suffix = value.slice(token.index! + token[0].length).match(/^\s*(千|万)?\s*元?/)![0];
      conditionalAmount = amountMinor(token[0] + suffix);
    }
  }
  return { bucket: 2, amount: conditionalAmount };
}

export function sortRows<T extends { distributorLimit: string }>(rows: T[]): T[] {
  return rows.map((row, index) => ({ row, index, rank: quotaSortKey(row.distributorLimit) }))
    .sort((a, b) => {
      if (a.rank.bucket !== b.rank.bucket) return a.rank.bucket - b.rank.bucket;
      if (a.rank.bucket === 1 || a.rank.bucket === 2) {
        if (a.rank.amount === null && b.rank.amount !== null) return 1;
        if (a.rank.amount !== null && b.rank.amount === null) return -1;
        if (a.rank.amount !== null && b.rank.amount !== null && a.rank.amount !== b.rank.amount) return a.rank.amount > b.rank.amount ? -1 : 1;
      }
      return a.index - b.index;
    }).map(({ row }) => row);
}

export function displayField(value: unknown) { return value == null || String(value).trim() === "" ? "待更新" : String(value); }
export function displayTime(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return "未记录";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

const sourceErrors: Record<string, string> = {
  SOURCE_NOT_CAPTURED: "本轮尚未采集", SOURCE_ACCESS_RESTRICTED: "来源访问受限",
  SOURCE_SESSION_EXPIRED: "需要更新登录", SOURCE_CAPTURE_INCOMPLETE: "采集未完成",
  SOURCE_EXTRACTION_FAILED: "存在转录失败", SOURCE_NO_TODAY_TABLE: "未取得目标日期表",
  SOURCE_NOT_CONFIGURED: "未配置转录服务", SOURCE_UNKNOWN_ERROR: "未取得采集状态",
};
export function sourceDisplay(source: SourceStatus) {
  return {
    data: (source.rowCount ?? 0) > 0 ? `提供 ${source.rowCount} 行投票数据` : source.status === "running" ? "正在采集" : "本轮未提供投票数据",
    issue: sourceErrors[source.errorCode ?? ""] || (source.status === "failed" ? "采集或转录失败" : ""),
  };
}

const runErrors: Record<string, string> = {
  TABLE_NO_TODAY_POST: "本轮未取得目标日期投票数据", TABLE_ACCESS_RESTRICTED: "本轮存在来源访问受限",
  TABLE_SESSION_EXPIRED: "采集登录需要更新", TABLE_EXTRACTION_FAILED: "本轮存在采集或转录失败",
  TABLE_NO_QUORUM: "本轮未形成可发布的投票结果", TABLE_OLDER_RUN_SKIPPED: "已保留较新投票结果",
  SCAN_BUSY: "另一轮采集正在运行", TABLE_RUN_BUSY: "另一轮投票正在运行", TABLE_PUBLICATION_BUSY: "另一轮发布正在运行",
  TABLE_RUN_DATE_INVALID: "采集目标日期无效", TABLE_RUN_FAILED: "本轮运行失败", STATE_WRITE_FAILED: "运行状态保存失败",
};
export function runDisplay(summary: TableSummary) {
  if (runErrors[summary.errorCode ?? ""]) return runErrors[summary.errorCode ?? ""];
  return ({ running: "本轮采集中", stopped: "采集已停止", published: "投票结果已发布",
    unchanged: "投票结果未变", "no-change": "投票结果未变", partial: "未采用字段显示为待更新",
    incomplete: "本轮未形成可发布的投票结果", failed: "本轮运行失败" } as Record<string, string>)[summary.status] || "";
}

export const summaryNotices: Record<string, string> = {
  MISSING: "尚未收到采集状态。已发布的投票结果仍可查看。",
  INVALID: "采集状态不可读，暂不展示来源与统计。",
  INCONSISTENT: "投票结果与采集摘要版本不一致，请刷新。暂不展示来源与统计。",
  STALE: "采集状态已超过检查时限，请检查采集服务。",
};

/** Reject malformed payloads rather than leave an older authenticated view on screen. */
export function dashboardModel(input: unknown): Dashboard {
  const result = input as DashboardPayload;
  function invalid(): never { throw new Error("INVALID_RESPONSE"); }
  if (!result || !["AVAILABLE", "MISSING", "INVALID"].includes(result.tableState)
      || !["AVAILABLE", "MISSING", "INVALID", "INCONSISTENT", "STALE"].includes(result.summaryState)) invalid();
  let table: Dashboard["table"] = null;
  if (result.tableState === "AVAILABLE") {
    table = result.table ?? null;
    if (!table || !/^\d{4}-\d{2}-\d{2}$/.test(table.dataDate) || !Array.isArray(table.rows)
        || table.rows.length > 44 || !table.rows.every(row => row && /^[0-9]{6}$/.test(row.fundCode)
          && typeof row.fundName === "string" && typeof row.distributorLimit === "string" && typeof row.directLimit === "string"
          && [row.feeRate, row.trackingError, row.return1y].every(value => value == null || typeof value === "string"))
        || new Set(table.rows.map(row => row.fundCode)).size !== table.rows.length
        || table.notes != null && (!Array.isArray(table.notes) || !table.notes.every(note => typeof note === "string"))) invalid();
    table = { ...table, rows: sortRows(table.rows) };
  }
  let summary: Dashboard["summary"] = null;
  if (["AVAILABLE", "STALE"].includes(result.summaryState)) {
    summary = result.summary ?? null;
    if (!summary || !Array.isArray(summary.sources) || summary.sources.length > 50
        || new Set(summary.sources.map(source => source?.authorId)).size !== summary.sources.length
        || !summary.sources.every(source => source && authorIdValid(source.authorId)
          && (source.name == null || authorNameValid(source.name)) && typeof source.status === 'string'
          && (source.rowCount === null || Number.isInteger(source.rowCount) && source.rowCount >= 0 && source.rowCount <= 44))) invalid();
    if (summary.published && ![summary.published.adoptedFields, summary.published.pendingFields].every(value => Number.isInteger(value) && value >= 0)) invalid();
    // The summary is a snapshot of that run, independent of today's editable author list.
    summary = { ...summary, sources: summary.sources.map(source => ({ ...source, name: source.name?.trim() || source.authorId })) };
  }
  return { table, summary, notice: summaryNotices[result.summaryState] || "", tableState: result.tableState };
}
