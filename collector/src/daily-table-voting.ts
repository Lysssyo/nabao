import { createHash } from "node:crypto";
import { DAILY_FUND_CATALOG } from "./daily-fund-catalog.js";
import { PRIMARY_DAILY_FUND_CODES, type DailyTable, type DailyTableRow } from "./daily-table.js";
import type { NoteCapture } from "./types.js";

export const VOTED_FIELDS = ["feeRate", "distributorLimit", "directLimit", "trackingError", "return1y"] as const;
export type VotedField = typeof VOTED_FIELDS[number];
export type LimitField = "distributorLimit" | "directLimit";
export interface CellUnitContext { text: string; imageOrdinal: number; imageSha256: string }
export type UnitContexts = Record<string, Partial<Record<LimitField, CellUnitContext>>>;
export interface SourceTable {
  authorId: string; capture: NoteCapture; table: DailyTable;
  withdrawnFields?: Record<string, VotedField[]>;
  validationVersion?: string;
  unitContexts?: UnitContexts;
}
export interface SourceWatermark {
  authorId: string; noteId: string; sourcePublishedAt: string; sourceUpdatedAt: string | null;
  capturedAt: string; revision: string;
}
export interface VotePublication {
  format: 1; dataDate: string; revision: string; watermarks: SourceWatermark[];
}
interface FieldVote {
  authorId: string; noteId: string; value: string; key: string; notes: string[];
  sourceTime: number; capturedTime: number; evidenceRef: string;
  unitContext?: CellUnitContext;
}
export interface FieldDecision {
  fundCode: string; field: VotedField; status: "ADOPTED" | "TIE" | "INSUFFICIENT";
  value: string | null; votes: FieldVote[]; support: number;
}

const isLimit = (field: VotedField) => field === "directLimit" || field === "distributorLimit";
const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/g, "");
const sourceTime = (capture: NoteCapture) => Math.max(...[capture.sourcePublishedAt, capture.sourceUpdatedAt]
  .map((value) => value ? Date.parse(value) : Number.NEGATIVE_INFINITY));

function noteParts(notes: string[]): string[] {
  return notes.flatMap((note) => note.split(/[；;。]|(?=[*†‡])/)).map((note) => note.trim()).filter(Boolean);
}

/** Footnotes are part of the value's meaning, never decoration that may be stripped for a match. */
function fieldMeaning(value: string, field: VotedField, table: DailyTable, fundCode: string, fundName: string,
  unitContext?: CellUnitContext): { key: string; notes: string[]; value: string } | null {
  const text = normalize(value).replace(/(?:保持不变|维持不变|不变)$/, "").replace(/^(?:仍为|维持)/, "");
  if (!text || /^(?:未明确|待更新|未知|不详|暂无(?:数据|信息)?|无数据|待确认|待核实|未公布|未提供|未标注|未注明|缺失|看不清|[-—–‐‑‒―−_]+|N\/A)$/i.test(text)) return null;
  const parts = noteParts(table.notes).filter((note) => {
    const codes: string[] = note.match(/(?<!\d)\d{6}(?!\d)/g) ?? [];
    if (codes.length && !codes.includes(fundCode)) return false;
    const companies = note.match(/华安|广发|大成|南方|天弘|华泰柏瑞|宝盈|招商|万家|建信|摩根|华夏|博时|嘉实|国泰|易方达|汇添富/g) ?? [];
    if (companies.length && !companies.some((company) => fundName.includes(company))) return false;
    if (field === "directLimit" && /代销/.test(note) && !/直销/.test(note)) return false;
    if (field === "distributorLimit" && /直销/.test(note) && !/代销/.test(note)) return false;
    return true;
  });
  const markers = [...new Set(text.match(/[*†‡]/g) ?? [])];
  const footnotes = markers.flatMap((marker) => parts.filter((note) => note.startsWith(marker)));
  // An unexplained symbol is not a reliable amount/metric.
  if (markers.some((marker) => !footnotes.some((note) => note.startsWith(marker)))) return null;
  const companies = /华安|广发|大成|南方|天弘|华泰柏瑞|宝盈|招商|万家|建信|摩根|华夏|博时|嘉实|国泰|易方达|汇添富/g;
  const businessNotes = isLimit(field) ? parts.filter((note) => {
    if (/^[*†‡]/.test(note) || !/合并(?:限额|上限|计算)|共享额度|共用额度|单账户|单户|每人|每户|单笔|部分渠道/.test(note)) return false;
    const named = note.match(companies) ?? [];
    if (named.length && !named.some((company) => fundName.includes(company))) return false;
    if (field === "directLimit" && /代销/.test(note) && !/直销/.test(note)) return false;
    if (field === "distributorLimit" && /直销/.test(note) && !/代销/.test(note)) return false;
    return true;
  }) : [];
  const meaningNotes = [...footnotes, ...businessNotes];
  const qualifications = meaningNotes.map(normalize).sort();
  if (isLimit(field)) {
    const unitNotes = parts.filter((note) => /(?:额度|限额|单位).*(?:元[\/／]日|元[\/／]天|(?:单日|每日|每交易日).*元|元.*(?:单日|每日|每交易日))/.test(note));
    const cellDaily = unitContext && /单日|每日|每(?:个)?交易日/.test(unitContext.text) && /元/.test(unitContext.text);
    const explicitDaily = /元(?:[\/／](?:日|天)|每天|每日)[*†‡]*$/.test(text);
    const numeric = /^(\d+(?:\.\d+)?)\s*(?:元(?:[\/／](?:日|天)|每天|每日)?)?([*†‡]*)$/.exec(text);
    if (numeric) {
      const currency = /美元|USD/.test(parts.join(" ")) ? "UNSPECIFIED" : /元/.test(text) || unitNotes.length || cellDaily ? "CNY" : "UNSPECIFIED";
      const period = explicitDaily || unitNotes.length || cellDaily ? "DAILY" : "UNSPECIFIED";
      const number = Number(numeric[1]);
      if (!Number.isFinite(number)) return null;
      const notes = [...meaningNotes, ...(period === "DAILY" ? ["额度单位：元/日"] : []), ...(cellDaily ? [unitContext!.text] : [])];
      return { key: JSON.stringify(["AMOUNT", number, currency, period, qualifications]), notes,
        value: `${number}${numeric[2]}` };
    }
    // "无", "暂停", "0", "部分渠道" and merged channel cells remain distinct.
    return { key: JSON.stringify(["TEXT", text, qualifications]), notes: meaningNotes, value: value.trim() };
  }
  const relevant = parts.filter((note) => /数据(?:截至|截止|日期)/.test(note) || (field === "return1y" ? /收益|近一年|净值/.test(note)
    : field === "trackingError" ? /误差|跟踪/.test(note) : /费率|费用/.test(note)));
  const dates = relevant.flatMap((note) => [...note.matchAll(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/g)]
    .map((match) => `${match[1]}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`));
  for (const note of relevant) {
    const withoutFullDates = note.replace(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/g, "");
    for (const match of withoutFullDates.matchAll(/(?<!\d)(\d{1,2})[/.月-](\d{1,2})日?(?!\d)/g)) {
      const date = `${table.dataDate.slice(0, 4)}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
      if (date <= table.dataDate && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date) dates.push(date);
    }
  }
  // A reporting day and an explicit performance cutoff are different scopes, even if their dates happen to match.
  const cutoffNotes = relevant.filter((note) => /截至|截止|数据日期|净值日期/.test(note));
  const dateScope = dates.length ? ["AS_OF_DATE", ...new Set(dates)].sort()
    : cutoffNotes.length ? ["AS_OF_UNRESOLVED", ...cutoffNotes.map(normalize).sort()] : ["AS_REPORTED_ON", table.dataDate];
  const match = /^([+-]?\d+(?:\.\d+)?)%([*†‡]*)$/.exec(text);
  if (!match) return null;
  const notes = [...footnotes, ...cutoffNotes];
  return { key: JSON.stringify(["PERCENT", Number(match[1]), dateScope, qualifications]),
    notes, value: `${Number(match[1])}%${match[2]}` };
}

function latestVote(a: FieldVote, b: FieldVote): number {
  return b.sourceTime - a.sourceTime || b.capturedTime - a.capturedTime || a.noteId.localeCompare(b.noteId);
}

/** Every author gets one latest valid same-day vote per field, including when they publish several notes. */
export function voteDailyTables(inputs: SourceTable[], dataDate: string, allowedAuthorIds: readonly string[]) {
  const allowed = new Set(allowedAuthorIds);
  const valid = inputs.filter((input) => allowed.has(input.authorId) && input.capture.authorId === input.authorId
    && input.table.dataDate === dataDate && ["success", "no-change"].includes(input.capture.captureStatus)
    && input.capture.sourcePublishedAt && input.capture.revision && Number.isFinite(sourceTime(input.capture)))
    .sort((a, b) => sourceTime(b.capture) - sourceTime(a.capture) || Date.parse(b.capture.capturedAt) - Date.parse(a.capture.capturedAt));
  const byNote = new Map<string, SourceTable>();
  for (const input of valid) if (!byNote.has(`${input.authorId}:${input.capture.noteId}`)) byNote.set(`${input.authorId}:${input.capture.noteId}`, input);
  const accepted = [...byNote.values()];
  const decisions: FieldDecision[] = [];
  const usedNotes = new Set<string>();
  const usedSources = new Set<string>();
  const rows: DailyTableRow[] = PRIMARY_DAILY_FUND_CODES.map((fundCode) => {
    const fundName = DAILY_FUND_CATALOG.find((fund) => fund.code === fundCode)?.name;
    if (!fundName) throw new Error("TABLE_FUND_CATALOG_INCOMPLETE");
    const row: DailyTableRow = { fundCode, fundName, feeRate: null, distributorLimit: "待更新", directLimit: "待更新", trackingError: null, return1y: null };
    for (const field of VOTED_FIELDS) {
      const votes: FieldVote[] = [];
      for (const input of accepted) {
        const value = input.table.rows.find((entry) => entry.fundCode === fundCode)?.[field];
        if (input.withdrawnFields?.[fundCode]?.includes(field)) {
          votes.push({ authorId: input.authorId, noteId: input.capture.noteId, value: "", key: "WITHDRAWN", notes: [],
            sourceTime: sourceTime(input.capture), capturedTime: Date.parse(input.capture.capturedAt), evidenceRef: input.capture.evidenceRef });
          continue;
        }
        if (value === null || value === undefined) continue;
        const unitContext = isLimit(field) ? input.unitContexts?.[fundCode]?.[field as LimitField] : undefined;
        const meaning = fieldMeaning(value, field, input.table, fundCode, fundName, unitContext);
        if (!meaning) continue;
        votes.push({ authorId: input.authorId, noteId: input.capture.noteId, value: meaning.value,
          key: meaning.key, notes: meaning.notes, sourceTime: sourceTime(input.capture),
          capturedTime: Date.parse(input.capture.capturedAt), evidenceRef: input.capture.evidenceRef,
          ...(unitContext ? { unitContext } : {}) });
      }
      votes.sort(latestVote);
      const authorVotes = [...new Set(votes.map((vote) => vote.authorId))].flatMap((author) => {
        const sameAuthor = votes.filter((vote) => vote.authorId === author);
        const latest = sameAuthor[0]!;
        if (latest.key === "WITHDRAWN") return [];
        // Equal verified timestamps from different posts give no reliable ordering for contradicting values.
        if (sameAuthor.some((vote) => vote.noteId !== latest.noteId && vote.sourceTime === latest.sourceTime && vote.key !== latest.key)) return [];
        return [latest];
      });
      const groups = new Map<string, FieldVote[]>();
      for (const vote of authorVotes) groups.set(vote.key, [...(groups.get(vote.key) ?? []), vote]);
      const ranked = [...groups.values()].sort((a, b) => b.length - a.length);
      const best = ranked[0] ?? [];
      const tied = ranked.length > 1 && ranked[1]!.length === best.length;
      const adopted = best.length >= 2 && !tied;
      decisions.push({ fundCode, field, status: adopted ? "ADOPTED" : tied ? "TIE" : "INSUFFICIENT",
        value: adopted ? best[0]!.value : null, votes: authorVotes, support: best.length });
      if (adopted) {
        row[field] = best[0]!.value;
        for (const winner of best) {
          winner.notes.forEach((note) => usedNotes.add(`${fundCode} ${field === "directLimit" ? "直销" : field === "distributorLimit" ? "代销" : field === "return1y" ? "近一年" : field === "trackingError" ? "跟踪误差" : "费率"}：${note}`));
          usedSources.add(winner.evidenceRef);
        }
      }
    }
    return row;
  });
  const adoptedFields = decisions.filter((item) => item.status === "ADOPTED").length;
  const source = [...accepted].filter((item) => usedSources.has(item.capture.evidenceRef))
    .sort((a, b) => sourceTime(b.capture) - sourceTime(a.capture) || a.capture.noteId.localeCompare(b.capture.noteId))[0];
  // Keep the public contract small: combine same business note across affected fund/field labels.
  const notesByMeaning = new Map<string, string[]>();
  for (const note of usedNotes) {
    const [label, ...description] = note.split("：");
    const meaning = description.join("：");
    notesByMeaning.set(meaning, [...(notesByMeaning.get(meaning) ?? []), label!]);
  }
  const notes = [...notesByMeaning].map(([meaning, labels]) => `${[...new Set(labels)].join("、")}：${meaning}`);
  if (notes.length > 30 || notes.some((note) => note.length > 2_000)) throw new Error("TABLE_VOTED_NOTES_TOO_LARGE");
  const table: DailyTable | null = source && adoptedFields ? {
    schemaVersion: 1, dataDate, updatedAt: new Date().toISOString(),
    source: { name: "公开额度汇总", url: source.capture.evidenceRef, publishedAt: source.capture.sourcePublishedAt! }, rows, notes,
  } : null;
  const watermarks = [...new Map(accepted.map((input) => [`${input.authorId}:${input.capture.noteId}`, input])).values()]
    .map(({ authorId, capture }) => ({ authorId, noteId: capture.noteId, sourcePublishedAt: capture.sourcePublishedAt!,
      sourceUpdatedAt: capture.sourceUpdatedAt, capturedAt: capture.capturedAt, revision: capture.revision! }))
    .sort((a, b) => a.authorId.localeCompare(b.authorId) || a.noteId.localeCompare(b.noteId));
  const revision = createHash("sha256").update(JSON.stringify({ dataDate, watermarks: watermarks.map(({ capturedAt, ...source }) => source), rows, notes })).digest("hex");
  const publication: VotePublication = { format: 1, dataDate, revision, watermarks };
  return { table, decisions, publication, adoptedFields, pendingFields: decisions.length - adoptedFields };
}

/** A run may add observations, but may not remove or regress source evidence already used today. */
export function olderPublication(next: VotePublication, current: VotePublication): boolean {
  if (next.dataDate !== current.dataDate) return next.dataDate < current.dataDate;
  for (const old of current.watermarks) {
    const same = next.watermarks.find((item) => item.authorId === old.authorId && item.noteId === old.noteId);
    const time = (item: SourceWatermark) => Math.max(Date.parse(item.sourcePublishedAt), item.sourceUpdatedAt ? Date.parse(item.sourceUpdatedAt) : 0);
    if (same) {
      if (time(same) < time(old) || (time(same) === time(old) && same.revision !== old.revision
        && Date.parse(same.capturedAt) <= Date.parse(old.capturedAt))) return true;
    } else if (!next.watermarks.some((item) => item.authorId === old.authorId && time(item) > time(old))) return true;
  }
  return false;
}
