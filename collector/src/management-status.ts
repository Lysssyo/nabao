import { createHash, randomUUID } from "node:crypto";
import { chmod, open, rename, rm } from "node:fs/promises";
import { sources } from "./sources.js";
import { writeJson } from "./storage.js";
import type { TableWatchStatus } from "./table-watch.js";
import type { SourceAuthor } from "./types.js";

export interface ManagementSource {
  authorId: string;
  name: string;
  status: "running" | "unknown" | "complete" | "partial" | "failed" | "no_new_post" | "restricted" | "session_expired";
  rowCount: number | null;
  errorCode: string | null;
}
export interface ManagementAttempt { attemptedDate: string; sources: ManagementSource[] }
const sourceErrors = new Set(["SOURCE_NOT_CAPTURED", "SOURCE_ACCESS_RESTRICTED", "SOURCE_SESSION_EXPIRED", "SOURCE_CAPTURE_INCOMPLETE",
  "SOURCE_EXTRACTION_FAILED", "SOURCE_NO_TODAY_TABLE", "SOURCE_PARTIAL_FIELDS", "SOURCE_NOT_CONFIGURED", "SOURCE_UNKNOWN_ERROR"]);
const sourceStatuses = new Set(["running", "unknown", "complete", "partial", "failed", "no_new_post", "restricted", "session_expired"]);
const runStatuses = new Set(["running", "stopped", "published", "unchanged", "no-change", "older_skipped", "no_new_post",
  "restricted", "session_expired", "partial", "incomplete", "failed"]);
const runErrors = new Set(["TABLE_NO_TODAY_POST", "TABLE_ACCESS_RESTRICTED", "TABLE_SESSION_EXPIRED", "TABLE_PARTIAL_FIELDS",
  "TABLE_EXTRACTION_FAILED", "TABLE_NO_QUORUM", "TABLE_OLDER_RUN_SKIPPED", "SCAN_BUSY", "TABLE_RUN_BUSY", "TABLE_RUN_DATE_INVALID",
  "TABLE_PUBLICATION_BUSY", "TABLE_RUN_FAILED", "STATE_WRITE_FAILED", "AUTHOR_CONFIG_BUSY", "AUTHORS_REQUIRED", "AUTHOR_CONFIG_INVALID"]);
const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validTime = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)
  && value.length <= 40 && Number.isFinite(Date.parse(value));

/** Convert private diagnostics to fixed codes. Raw strings, URLs, paths and note IDs never cross this boundary. */
export function summarizeSources(attempts: Record<string, unknown>[], captureIssues: { authorId: string; issues: string[] }[], attemptedDate: string,
  authors: readonly SourceAuthor[] = sources): ManagementAttempt {
  return { attemptedDate, sources: authors.map(({ id, name }) => {
    const captured = captureIssues.find((source) => source.authorId === id);
    const attemptsForSource = attempts.filter((attempt) => attempt.authorId === id);
    const issues = [...(captured?.issues ?? ["SOURCE_NOT_CAPTURED"]), ...attemptsForSource.flatMap((attempt) =>
      Array.isArray(attempt.issues) ? attempt.issues.filter((issue): issue is string => typeof issue === "string") : [])].join(" ");
    const rows = attemptsForSource.filter((attempt) => attempt.dataDate === attemptedDate && Number.isInteger(attempt.rows))
      .map((attempt) => Number(attempt.rows)).filter((count) => count >= 0 && count <= 44);
    const rowCount = rows.length ? Math.max(...rows) : null;
    let status: ManagementSource["status"];
    let errorCode: string | null;
    if (/LOGIN|SESSION_EXPIRED|AUTH_REQUIRED/.test(issues)) { status = "session_expired"; errorCode = "SOURCE_SESSION_EXPIRED"; }
    else if (/RESTRICT|CHALLENGE|300012|RISK|BLOCKED/.test(issues)) { status = "restricted"; errorCode = "SOURCE_ACCESS_RESTRICTED"; }
    else if (issues.includes("SOURCE_NOT_CAPTURED")) { status = "unknown"; errorCode = "SOURCE_NOT_CAPTURED"; }
    else if (attemptsForSource.some((attempt) => attempt.status === "NOT_CONFIGURED")) { status = "failed"; errorCode = "SOURCE_NOT_CONFIGURED"; }
    else if (attemptsForSource.some((attempt) => attempt.status === "FAILED")) { status = "failed"; errorCode = "SOURCE_EXTRACTION_FAILED"; }
    else if (captured?.issues.length) { status = "failed"; errorCode = "SOURCE_CAPTURE_INCOMPLETE"; }
    else if (rowCount === null || rowCount === 0) { status = "no_new_post"; errorCode = "SOURCE_NO_TODAY_TABLE"; }
    else if (issues || attemptsForSource.some((attempt) => attempt.status === "INCOMPLETE")) { status = "partial"; errorCode = "SOURCE_PARTIAL_FIELDS"; }
    else { status = "complete"; errorCode = null; }
    return { authorId: id, name, status, rowCount, errorCode };
  }) };
}

async function publishedSummary(tableFile: string) {
  try {
    const handle = await open(tableFile, "r");
    let bytes: Buffer;
    try {
      const buffer = Buffer.alloc(256 * 1024 + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length === 0 || length > 256 * 1024) return null;
      bytes = buffer.subarray(0, length);
    } finally { await handle.close(); }
    const table = JSON.parse(bytes.toString("utf8"));
    if (table.schemaVersion !== 1 || !validDate(table.dataDate) || !validTime(table.updatedAt)
      || !Array.isArray(table.rows) || table.rows.length < 1 || table.rows.length > 44) return null;
    let adoptedFields = 0;
    for (const row of table.rows) {
      for (const field of ["feeRate", "trackingError", "return1y"]) {
        if (row[field] !== null && typeof row[field] !== "string") return null;
        if (row[field] !== null) adoptedFields++;
      }
      for (const field of ["directLimit", "distributorLimit"]) {
        if (typeof row[field] !== "string") return null;
        if (row[field] !== "待更新") adoptedFields++;
      }
    }
    return { dataDate: table.dataDate, updatedAt: table.updatedAt, digest: createHash("sha256").update(bytes).digest("hex"),
      rowCount: table.rows.length, adoptedFields, pendingFields: table.rows.length * 5 - adoptedFields };
  } catch { return null; }
}

export async function writeManagementStatus(file: string, tableFile: string, status: TableWatchStatus, attempt?: ManagementAttempt,
  authors: readonly Pick<SourceAuthor, "id" | "name">[] = attempt?.sources.map(source => ({ id: source.authorId, name: source.name })) ?? sources): Promise<void> {
  if (!validTime(status.lastAttempt)) throw new Error("STATE_WRITE_FAILED");
  const attemptedDate = validDate(attempt?.attemptedDate) ? attempt.attemptedDate
    : new Date(Date.parse(status.lastAttempt) + 8 * 3600_000).toISOString().slice(0, 10);
  const published = await publishedSummary(tableFile);
  const summary = {
    schemaVersion: 1, lastAttempt: status.lastAttempt, lastSuccess: validTime(status.lastSuccess) ? status.lastSuccess : null,
    attemptedDate, status: runStatuses.has(status.status) ? status.status : "failed",
    errorCode: status.errorCode === null ? null : runErrors.has(status.errorCode) ? status.errorCode : "TABLE_RUN_FAILED", published,
    sources: authors.map(({ id, name }) => {
      const source = attempt?.sources.find((item) => item.authorId === id);
      return { authorId: id, name, status: source && sourceStatuses.has(source.status) ? source.status : status.status === "running" ? "running" : "unknown",
        rowCount: source && Number.isInteger(source.rowCount) && source.rowCount! >= 0 && source.rowCount! <= 44 ? source.rowCount : null,
        errorCode: source?.errorCode === null || !source && status.status === "running" ? null
          : source && sourceErrors.has(source.errorCode ?? "") ? source.errorCode : "SOURCE_UNKNOWN_ERROR" };
    }),
  };
  // This allowlisted summary is the only collector state shared with the backend's
  // different UID. Set its readable mode before the final atomic publication.
  const temporary = `${file}.${randomUUID()}.shared-tmp`;
  try {
    await writeJson(temporary, summary);
    await chmod(temporary, 0o644);
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
