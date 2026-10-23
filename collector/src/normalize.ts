import type { CandidateRow, ExtractionIssue } from "./extract.js";
import { resolveFund, type Fund } from "./catalog.js";
import { normalizedTimestamp } from "./rules.js";
import { validateObservations } from "./submit.js";
import type { NoteCapture, Observation } from "./types.js";
import { createHash } from "node:crypto";
import { sources } from "./sources.js";

function evidenceLink(capture: NoteCapture): string {
  const known = sources.find((source) => source.id === capture.authorId)?.seedNotes
    ?.find((note) => note.noteId === capture.noteId)?.url;
  if (known) return known;
  if (capture.openUrl) {
    try {
      const url = new URL(capture.openUrl);
      if (url.protocol === "https:" && url.hostname === "www.xiaohongshu.com"
        && !url.username && !url.password && (!url.port || url.port === "443")
        && new RegExp(`^/(?:explore|discovery/item|user/profile/${capture.authorId})/${capture.noteId}/?$`).test(url.pathname)) {
        return url.toString();
      }
    } catch { /* Fall back to the immutable public note reference. */ }
  }
  return capture.evidenceRef;
}

export function amountMinor(raw: string | null): number | null {
  if (!raw) return null;
  const match = raw.trim().match(/^(?:[¥￥$]\s*)?(\d+(?:,\d{3})*)(?:\.(\d{1,2}))?\s*(万|亿)?\s*(?:元|人民币|CNY|RMB|美元|USD)?$/i);
  if (!match) return null;
  const multiplier = match[3] === "亿" ? 100_000_000n : match[3] === "万" ? 10_000n : 1n;
  const value = (BigInt(match[1]!.replace(/,/g, "")) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"))) * multiplier;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function rawCurrencies(raw: string | null): ("CNY" | "USD")[] {
  if (raw === null) return [];
  const result: ("CNY" | "USD")[] = [];
  if (/[¥￥]|人民币|CNY|RMB|(?<!美)元/i.test(raw)) result.push("CNY");
  if (/\$|美元|USD/i.test(raw)) result.push("USD");
  return result;
}

export function normalizeRows(rows: CandidateRow[], capture: NoteCapture, funds: Fund[]): {
  items: Observation[]; issues: ExtractionIssue[];
} {
  const issues: ExtractionIssue[] = [];
  const items: Observation[] = [];
  if (!capture.revision || !normalizedTimestamp(capture.sourcePublishedAt)) {
    return { items, issues: [{ code: "CAPTURE_METADATA_MISSING", message: "笔记版本或发布时间缺失。" }] };
  }
  const values = new Map<string, { value: string; item: Observation }>();
  const conflicts = new Set<string>();
  // Identical complete image evidence is a known shared source even when the
  // reposted title/body differs. Different watermarks are not guessed as copies.
  const sourceGroupId = capture.images.length
    ? `images:${createHash("sha256").update(JSON.stringify(capture.images.map((image) => image.sha256).sort())).digest("hex")}`
    : undefined;
  for (const [rowIndex, row] of rows.entries()) {
    const issue = (code: string, message: string) => issues.push({ code, message, rowIndex });
    const amountCurrencies = rawCurrencies(row.rawAmount);
    if (amountCurrencies.length > 1 || (amountCurrencies.length === 1 && row.currency !== "UNSPECIFIED"
      && amountCurrencies[0] !== row.currency)) {
      issue("CURRENCY_CONFLICT", "金额单位与币种字段不一致，不能自动换算或替换。"); continue;
    }
    const currency = row.currency === "UNSPECIFIED" && amountCurrencies.length === 1 ? amountCurrencies[0]! : row.currency;
    const fund = resolveFund(row.fundCode, row.fundName, funds, currency);
    if (!fund) { issue("FUND_UNRESOLVED", `无法唯一核对基金及份额：${row.fundName ?? row.fundCode ?? "未知"}`); continue; }
    if (!row.observedForDate) { issue("DATA_DATE_MISSING", "没有明确的额度数据日期。"); continue; }
    const amount = row.limitKind === "LIMITED" ? amountMinor(row.rawAmount) : null;
    if (row.limitKind === "LIMITED" && amount === null) { issue("AMOUNT_UNRESOLVED", "额度金额无法精确转换。"); continue; }
    if (row.limitKind !== "LIMITED" && row.rawAmount !== null) {
      issue("STATUS_AMOUNT_CONFLICT", "暂停、无和不限不能携带数字金额。"); continue;
    }
    const item: Observation = {
      authorId: capture.authorId, noteId: capture.noteId, noteRevision: capture.revision,
      fundCode: fund.code, fundName: fund.name, channelScope: row.channelScope,
      businessType: row.businessType, period: row.period, limitKind: row.limitKind,
      amountMinor: amount, currency, observedForDate: row.observedForDate,
      sourcePublishedAt: capture.sourcePublishedAt!, sourceUpdatedAt: capture.sourceUpdatedAt,
      capturedAt: capture.capturedAt, evidenceRef: evidenceLink(capture),
      ...(sourceGroupId ? { sourceGroupId } : {}),
    };
    try { validateObservations({ items: [item] }); }
    catch { issue("OBSERVATION_INVALID", "候选行未通过日期、范围或来源校验。"); continue; }
    const key = [item.fundCode, item.channelScope, item.businessType, item.period, item.currency, item.observedForDate].join("|");
    const value = `${item.limitKind}|${item.amountMinor}`;
    if (conflicts.has(key)) continue;
    if (values.has(key)) {
      if (values.get(key)!.value !== value) {
        issue("ROW_CONFLICT", "同一笔记的相同范围出现矛盾额度，该范围全部留待核对。");
        values.delete(key);
        conflicts.add(key);
      }
      continue;
    }
    values.set(key, { value, item });
  }
  items.push(...[...values.values()].map(({ item }) => item));
  return { items, issues };
}
