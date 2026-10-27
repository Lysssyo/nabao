import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { writeJson } from "./storage.js";
import { DAILY_FUND_CATALOG } from "./daily-fund-catalog.js";
import { VOTED_FIELDS, explainUncountedValue, type SourceTable, type FieldDecision } from "./daily-table-voting.js";

export const VOTE_RULE = "UNIQUE_PLURALITY_SINGLE_SOURCE_ALLOWED_PER_FIELD";
export interface AuditEntry {
  authorId: string; authorName: string; noteId: string; sourceUrl: string; sourceDate: string;
  capturedAt: string; fundCode: string; fundName: string; field: string; rawValue: string | null;
  normalizedValue: string | null; voteKey: string | null; notes: string[];
  ballotStatus: "COUNTED" | "SUPERSEDED" | "NO_VALUE" | "WITHDRAWN" | "OTHER_DATE";
  decisionStatus: string; adoptedValue: string | null; supportCount: number;
}
export interface AuditBatch {
  id: string; dataDate: string; recordedAt: string; rule: string; revision: string; publicationStatus: string;
  sources: { authorId: string; name: string; status: string }[]; entries: AuditEntry[];
}
export function createVoteAudit(inputs: SourceTable[], decisions: FieldDecision[], authors: { id: string; name: string }[],
  dataDate: string, revision: string, publicationStatus: string): AuditBatch {
  const names = new Map(authors.map(a => [a.id, a.name]));
  const byField = new Map(decisions.map(d => [`${d.fundCode}:${d.field}`, d]));
  const entries: AuditEntry[] = [];
  for (const input of inputs) {
    if (!names.has(input.authorId)) continue;
    const rows = [...input.table.rows];
    for (const fundCode of Object.keys(input.withdrawnFields ?? {})) {
      if (!rows.some(r => r.fundCode === fundCode)) {
        const fundName = DAILY_FUND_CATALOG.find(f => f.code === fundCode)?.name;
        if (fundName) rows.push({ fundCode, fundName, feeRate: null, distributorLimit: "", directLimit: "", trackingError: null, return1y: null });
      }
    }
    for (const row of rows) for (const field of VOTED_FIELDS) {
      const decision = byField.get(`${row.fundCode}:${field}`); if (!decision) continue;
      const otherDate = input.table.dataDate !== dataDate;
      const vote = otherDate ? undefined : decision.votes.find(v => v.authorId === input.authorId && v.noteId === input.capture.noteId);
      const withdrawn = input.withdrawnFields?.[row.fundCode]?.includes(field);
      const replaced = !vote && decision.votes.some(v => v.authorId === input.authorId);
      entries.push({ authorId: input.authorId, authorName: names.get(input.authorId)!, noteId: input.capture.noteId,
        sourceUrl: `https://www.xiaohongshu.com/explore/${input.capture.noteId}`, sourceDate: input.table.dataDate,
        capturedAt: input.capture.capturedAt, fundCode: row.fundCode,
        fundName: DAILY_FUND_CATALOG.find(f => f.code === row.fundCode)?.name ?? row.fundName,
        field, rawValue: row[field] ?? null, normalizedValue: vote?.value ?? null, voteKey: vote?.key ?? null,
        notes: vote?.notes ?? [...input.table.notes, ...(!otherDate && !withdrawn && !replaced ? [
          `计票说明：${explainUncountedValue(row[field] ?? null, field, input.table, row.fundCode, row.fundName,
            field === "directLimit" || field === "distributorLimit" ? input.unitContexts?.[row.fundCode]?.[field] : undefined)}`,
        ] : [])],
        ballotStatus: otherDate ? "OTHER_DATE" : withdrawn ? "WITHDRAWN" : vote ? "COUNTED" : replaced ? "SUPERSEDED" : "NO_VALUE",
        decisionStatus: decision.status, adoptedValue: decision.value, supportCount: decision.support });
    }
  }
  return { id: randomUUID(), dataDate, recordedAt: new Date().toISOString(), rule: VOTE_RULE, revision, publicationStatus,
    sources: authors.map(a => ({ authorId: a.id, name: a.name,
      status: inputs.some(i => i.authorId === a.id && i.table.dataDate === dataDate && i.table.rows.length) ? "HAS_TABLE" : "NO_TODAY_TABLE" })), entries };
}

/** Durable outbox: backend outages never lose a batch, and never block quota publication. */
export async function saveVoteAudit(dataDirectory: string, batch: AuditBatch): Promise<void> {
  const directory = join(dataDirectory, "vote-audit", "pending");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${batch.id}.json`), temporary = `${path}.tmp`;
  await writeJson(temporary, batch); await rename(temporary, path);
}
export async function flushVoteAudits(dataDirectory: string, fetchImpl = fetch): Promise<number> {
  const url = process.env.NABAO_BACKEND_URL?.trim(), key = process.env.NABAO_INTERNAL_KEY?.trim();
  if (!url || !key) return 0;
  const directory = join(dataDirectory, "vote-audit", "pending"), archive = join(dataDirectory, "vote-audit", "sent");
  let files: string[];
  try { files = (await readdir(directory)).filter(f => /^[0-9a-f-]{36}\.json$/.test(f)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  let sent = 0;
  for (const file of files) {
    try {
      const response = await fetchImpl(`${url.replace(/\/$/, "")}/internal/v1/vote-audits`, {
        method: "POST", headers: { "X-Internal-Key": key, "Content-Type": "application/json" },
        body: await readFile(join(directory, file), "utf8"), signal: AbortSignal.timeout(15_000), redirect: "error" });
      await response.body?.cancel();
      if (!response.ok) break;
      await mkdir(archive, { recursive: true, mode: 0o700 });
      await rename(join(directory, file), join(archive, file)); sent++;
    } catch { break; }
  }
  return sent;
}
