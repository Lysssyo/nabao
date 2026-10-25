import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { scan } from "./scan.js";
import { compareCaptureRecency } from "./rules.js";
import { requireVotingAuthors, withAuthorLease, type AuthorLease } from "./author-store.js";
import { writeJson } from "./storage.js";
import { summarizeSources } from "./management-status.js";
import { acquireProcessLock } from "./process-lock.js";
import { DAILY_FUND_CATALOG } from "./daily-fund-catalog.js";
import { DAILY_FUND_SOURCE_ALIASES } from "./daily-fund-source-aliases.js";
import { DAILY_TABLE_PROMPT_VERSION, extractDailyTable, hasReusableDailyTableContent, publishDailyTable, PRIMARY_DAILY_FUND_CODES, type DailyTable, type DailyTableExtraction } from "./daily-table.js";
import { voteDailyTables, type SourceTable } from "./daily-table-voting.js";
import type { NoteCapture } from "./types.js";
import { validateCaptureEvidence } from "./extract.js";

// Kept for callers importing the former source identifier. All configured authors now vote equally.
export const PRIMARY_TABLE_AUTHOR = "5ddec93c0000000001009aa1";
// Source-name reviews affect which rows are admissible. Revalidate cached raw
// transcriptions when those reviews change instead of freezing an old subset.
const VALIDATION_VERSION = `daily-source-validation-v4:${createHash("sha256")
  .update(JSON.stringify({ catalog: DAILY_FUND_CATALOG, aliases: DAILY_FUND_SOURCE_ALIASES })).digest("hex")}`;
export type DailyTableRunStatus = "published" | "unchanged" | "older_skipped" | "partial" | "no_new_post" | "restricted" | "session_expired" | "failed";
export const DAILY_TABLE_ERROR_CODES = ["TABLE_NO_TODAY_POST", "TABLE_ACCESS_RESTRICTED", "TABLE_SESSION_EXPIRED", "TABLE_PARTIAL_FIELDS",
  "TABLE_EXTRACTION_FAILED", "TABLE_NO_QUORUM", "TABLE_OLDER_RUN_SKIPPED"] as const;
interface CaptureReport { results: { authorId: string; notes: NoteCapture[]; issues: string[]; status?: string; discoveryComplete?: boolean }[] }
interface RunOptions {
  /** Explicit date is for replaying captured evidence; normal collection always uses today's Shanghai date. */
  dataDate?: string;
  extract?: typeof extractDailyTable;
  stateDirectory?: string;
  dataDirectory?: string;
  authorLease?: AuthorLease;
}

async function readOptional<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function savePrivate(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeJson(temporary, value); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
function verifiedDay(note: NoteCapture): string | null {
  const values = [note.sourcePublishedAt, note.sourceUpdatedAt].filter((value): value is string => value !== null && Number.isFinite(Date.parse(value)));
  if (!values.length) return null;
  return new Date(Math.max(...values.map(Date.parse)) + 8 * 3600_000).toISOString().slice(0, 10);
}
function quotaTopic(note: NoteCapture): boolean {
  const text = `${note.title} ${note.body}`;
  return /纳斯达克|纳指/.test(text) && /限额|额度|限购|停购|申购|撤回|更正/.test(text);
}

/** The public file is a single voted display table; evidence, author votes and failures stay private. */
export async function dailyTableFromReport(reportFile: string, outputDirectory: string, options: RunOptions = {}) {
  const dataDirectory = resolve(options.dataDirectory?.trim() || process.env.NABAO_DATA_DIR?.trim()
    || (options.stateDirectory?.trim() ? dirname(resolve(options.stateDirectory)) : dirname(resolve(outputDirectory))));
  return withAuthorLease(dataDirectory, lease => dailyTableFromReportWithAuthors(reportFile, outputDirectory, options, lease), options.authorLease);
}
async function dailyTableFromReportWithAuthors(reportFile: string, outputDirectory: string, options: RunOptions, lease: AuthorLease) {
  requireVotingAuthors(lease.config);
  const sources = lease.config.authors;
  const report = JSON.parse(await readFile(reportFile, "utf8")) as CaptureReport;
  const root = dirname(resolve(reportFile));
  const dataDate = options.dataDate ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataDate) || new Date(`${dataDate}T00:00:00Z`).toISOString().slice(0, 10) !== dataDate) throw new Error("TABLE_RUN_DATE_INVALID");
  await mkdir(outputDirectory, { recursive: true });
  const stateDirectory = resolve(options.stateDirectory?.trim() || process.env.NABAO_TABLE_STATE_DIR?.trim()
    || join(process.env.NABAO_DATA_DIR?.trim() || dirname(resolve(outputDirectory)), "table-state"));
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const lockPath = join(stateDirectory, ".daily-table-run.lock");
  const lock = await acquireProcessLock(lockPath, "TABLE_RUN_BUSY");
  try {
    const attempts: Record<string, unknown>[] = [];
    const statePath = join(stateDirectory, `daily-source-tables-${dataDate}.json`);
    const saved = await readOptional<SourceTable[]>(statePath) ?? [];
    const allowedAuthors = new Set(sources.map((source) => source.id));
    const observations = new Map(saved.filter((input) => input.table.dataDate === dataDate && allowedAuthors.has(input.authorId))
      .map((input) => [`${input.authorId}:${input.capture.noteId}`, input]));
    const extract = options.extract ?? extractDailyTable;
    for (const source of sources) {
      const candidates = (report.results.find((item) => item.authorId === source.id)?.notes ?? [])
        .filter((note) => {
          const sourceDay = verifiedDay(note);
          return ["success", "no-change"].includes(note.captureStatus)
            && /^[a-f0-9]{24}$/.test(note.noteId) && note.authorId === source.id
            // A post may publish or revise an older table. Its verified time only
            // bounds the table date; the extracted table must match dataDate below.
            && sourceDay !== null && sourceDay >= dataDate
            // Existing posts may keep their quota table in images after the caption changes.
            && (quotaTopic(note) || observations.has(`${source.id}:${note.noteId}`));
        })
        .sort(compareCaptureRecency);
      for (const note of candidates) {
        const key = `${source.id}:${note.noteId}`;
        const previous = observations.get(key);
        const recency = previous ? compareCaptureRecency(note, previous.capture) : -1;
        if (previous && (recency > 0 || (recency === 0 && Date.parse(note.capturedAt) < Date.parse(previous.capture.capturedAt)))) {
          attempts.push({ authorId: source.id, noteId: note.noteId, status: "OLDER_CAPTURE_SKIPPED" }); continue;
        }
        let result: DailyTableExtraction;
        try {
          if (previous && previous.validationVersion === VALIDATION_VERSION && note.revision === previous.capture.revision && note.sourceUpdatedAt === previous.capture.sourceUpdatedAt
            && note.sourcePublishedAt === previous.capture.sourcePublishedAt
            && hasReusableDailyTableContent(previous.table, PRIMARY_DAILY_FUND_CODES, previous.withdrawnFields)
            && (await validateCaptureEvidence(note, join(root, source.id, note.noteId))).length === 0) {
            // Older state omitted this outcome. Keep it conservative until an
            // extraction verifies completeness; row count alone cannot prove it.
            result = { status: previous.validationStatus === "COMPLETE" ? "COMPLETE" : "INCOMPLETE",
              table: previous.table, issues: [], promptVersion: "saved-validated-extraction", cacheHit: true,
              withdrawnFields: previous.withdrawnFields, unitContexts: previous.unitContexts };
          } else {
            result = await extract(note, join(root, source.id, note.noteId), source.name, undefined, DAILY_FUND_CATALOG, PRIMARY_DAILY_FUND_CODES,
              { requireUnitContext: source.id === "633116cc000000002303dcaa" });
          }
        } catch {
          // A single unexpected extractor failure must not discard other authors' work.
          // Exception messages may contain credentials or signed URLs; keep a stable code only.
          result = { status: "FAILED", table: null, issues: ["TABLE_EXTRACTION_EXCEPTION"], promptVersion: DAILY_TABLE_PROMPT_VERSION };
        }
        const useful = hasReusableDailyTableContent(result.table, PRIMARY_DAILY_FUND_CODES, result.withdrawnFields);
        const unusableToday = result.table?.dataDate === dataDate && !useful;
        attempts.push({ authorId: source.id, noteId: note.noteId, title: note.title, publishedAt: note.sourcePublishedAt,
          updatedAt: note.sourceUpdatedAt, status: unusableToday ? "FAILED" : result.status, dataDate: result.table?.dataDate, rows: result.table?.rows.length ?? 0,
          issues: unusableToday ? [...result.issues, "TABLE_NO_USABLE_FIELDS"] : result.issues, cacheHit: result.cacheHit ?? false });
        if (result.table && result.table.dataDate === dataDate) {
          observations.set(key, { authorId: source.id, capture: note, table: result.table, withdrawnFields: result.withdrawnFields,
            unitContexts: result.unitContexts, ...(useful ? { validationVersion: VALIDATION_VERSION,
              validationStatus: result.status === "COMPLETE" && result.issues.length === 0 ? "COMPLETE" as const : "INCOMPLETE" as const } : {}) });
        } else if (previous && note.revision !== previous.capture.revision) {
          // A changed note that no longer yields today's evidence cannot keep voting with its previous revision.
          observations.set(key, { authorId: source.id, capture: note,
            table: { ...previous.table, rows: [], notes: [] } });
        }
      }
    }
    const inputs = [...observations.values()];
    const voted = voteDailyTables(inputs, dataDate, sources.map((source) => source.id));
    voted.publication.authorConfig = { revision: lease.config.revision, authorIds: sources.map(source => source.id) };
    voted.publication.revision = createHash("sha256").update(JSON.stringify({ vote: voted.publication.revision, authorConfig: voted.publication.authorConfig })).digest("hex");
    await savePrivate(statePath, inputs);
    const publication = voted.table ? await publishDailyTable(voted.table, outputDirectory, PRIMARY_DAILY_FUND_CODES, voted.publication) : null;
    const latest = await readOptional<DailyTable>(join(outputDirectory, "latest.json"));
    const captureIssues = sources.map((source) => {
      const captured = report.results.find((item) => item.authorId === source.id);
      return { authorId: source.id, issues: captured
        ? [...new Set([...captured.issues, ...captured.notes.flatMap((note) => note.issues),
          ...(captured.discoveryComplete === false || (captured.status && !["success", "no-change"].includes(captured.status))
            || captured.notes.some((note) => !["success", "no-change"].includes(note.captureStatus)) ? ["SOURCE_CAPTURE_INCOMPLETE"] : [])])]
        : ["SOURCE_NOT_CAPTURED"] };
    });
    const allIssues = captureIssues.flatMap((item) => item.issues).join(" ");
    const restricted = /RESTRICT|CHALLENGE|300012|RISK|BLOCKED/.test(allIssues);
    const sessionExpired = /LOGIN|SESSION_EXPIRED|AUTH_REQUIRED/.test(allIssues);
    const failedAttempts = attempts.some((attempt) => ["FAILED", "NOT_CONFIGURED"].includes(String(attempt.status)));
    let status: DailyTableRunStatus;
    let errorCode: typeof DAILY_TABLE_ERROR_CODES[number] | null = null;
    if (publication?.status === "OLDER_SKIPPED") { status = "older_skipped"; errorCode = "TABLE_OLDER_RUN_SKIPPED"; }
    else if (sessionExpired) { status = "session_expired"; errorCode = "TABLE_SESSION_EXPIRED"; }
    else if (restricted) { status = "restricted"; errorCode = "TABLE_ACCESS_RESTRICTED"; }
    else if (failedAttempts || captureIssues.some((item) => item.issues.length)) { status = "failed"; errorCode = "TABLE_EXTRACTION_FAILED"; }
    else if (voted.table) {
      status = voted.pendingFields ? "partial" : publication?.status === "UNCHANGED" ? "unchanged" : "published";
      if (voted.pendingFields) errorCode = "TABLE_PARTIAL_FIELDS";
    } else if (inputs.length) { status = "partial"; errorCode = "TABLE_NO_QUORUM"; }
    else { status = "no_new_post"; errorCode = "TABLE_NO_TODAY_POST"; }
    const result = { status, errorCode, dataDate: latest?.dataDate ?? null, attemptedDate: dataDate, rowCount: latest?.rows.length ?? 0,
      adoptedFields: voted.adoptedFields, pendingFields: voted.pendingFields, publication, attempts,
      voting: { rule: "UNIQUE_PLURALITY_MIN_TWO_AUTHORS_PER_FIELD", revision: voted.publication.revision, decisions: voted.decisions }, captureIssues };
    const resultFile = join(root, "daily-table-report.json");
    await writeJson(resultFile, result);
    return { status, errorCode, dataDate: result.dataDate, attemptedDate: dataDate, rowCount: result.rowCount,
      adoptedFields: voted.adoptedFields, pendingFields: voted.pendingFields, publication, reportFile: resultFile,
      management: summarizeSources(attempts, captureIssues, dataDate, sources) };
  } finally { await lock.release(); }
}

export async function updateDailyTable(options: { maxNotes: number; headless: boolean; dataDirectory: string; outputDirectory: string; authorLease?: AuthorLease }) {
  return withAuthorLease(options.dataDirectory, async authorLease => {
    requireVotingAuthors(authorLease.config);
    const captured = await scan({ ...options, captureOnly: true, authorLease });
    return dailyTableFromReport(captured.reportFile, resolve(options.outputDirectory), {
      dataDirectory: options.dataDirectory, authorLease,
      stateDirectory: process.env.NABAO_TABLE_STATE_DIR?.trim() || resolve(options.dataDirectory, "table-state"),
    });
  }, options.authorLease);
}
