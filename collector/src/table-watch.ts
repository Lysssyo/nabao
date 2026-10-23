import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { writeJson } from "./storage.js";
import { DAILY_TABLE_ERROR_CODES } from "./daily-table-run.js";

export interface TableRunResult {
  status: string;
  dataDate?: string | null;
  errorCode?: string | null;
  publication?: { status: string } | null;
}
export interface TableWatchStatus {
  lastAttempt: string;
  lastSuccess: string | null;
  dataDate: string | null;
  status: string;
  errorCode: string | null;
}

const success = new Set(["published", "unchanged", "no-change"]);
const safeStatuses = new Set([...success, "older_skipped", "no_new_post", "restricted", "session_expired", "partial", "incomplete", "failed"]);
const safeCodes = new Set([...DAILY_TABLE_ERROR_CODES, "TABLE_RUN_BUSY", "TABLE_RUN_DATE_INVALID",
  "TABLE_PUBLICATION_BUSY", "TABLE_RUN_FAILED", "STATE_WRITE_FAILED"]);
function safeCode(value: unknown): string | null { return typeof value === "string" && safeCodes.has(value) ? value : null; }
function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

/** One attempt at a time; failures retain the last good data and use the normal low-frequency interval. */
export async function runTableWatch(options: {
  run: () => Promise<TableRunResult>;
  statusFile: string;
  intervalMs: number;
  signal: AbortSignal;
  once?: boolean;
  onResult?: (result: TableRunResult) => void;
  onAlert?: (status: TableWatchStatus) => void;
}): Promise<TableWatchStatus | null> {
  let previous: TableWatchStatus | null = null;
  try {
    const saved = JSON.parse(await readFile(options.statusFile, "utf8")) as TableWatchStatus;
    if (saved.lastSuccess === null || typeof saved.lastSuccess === "string"
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(saved.lastSuccess)
      && Number.isFinite(Date.parse(saved.lastSuccess))) previous = saved;
  } catch { /* A status file is observability only, never the source of published data. */ }
  let last = previous;
  const persist = async (status: TableWatchStatus) => {
    try { await writeJson(options.statusFile, status); }
    catch { options.onAlert?.({ ...status, status: "failed", errorCode: "STATE_WRITE_FAILED" }); }
  };
  while (!options.signal.aborted) {
    const attemptedAt = new Date().toISOString();
    last = { lastAttempt: attemptedAt, lastSuccess: previous?.lastSuccess ?? null,
      dataDate: validDate(previous?.dataDate) ? previous.dataDate : null, status: "running", errorCode: null };
    await persist(last);
    if (options.signal.aborted) { last = { ...last, status: "stopped" }; await persist(last); break; }
    try {
      const result = await options.run();
      last = { ...last, status: safeStatuses.has(result.status) ? result.status : "incomplete",
        dataDate: validDate(result.dataDate) ? result.dataDate : last.dataDate,
        lastSuccess: success.has(result.status) || result.publication?.status === "PUBLISHED"
          || result.status === "partial" && result.publication?.status === "UNCHANGED"
          ? new Date().toISOString() : last.lastSuccess,
        errorCode: safeCode(result.errorCode) };
      if (!success.has(last.status) && !last.errorCode) {
        last.errorCode = last.status === "session_expired" ? "TABLE_SESSION_EXPIRED"
          : last.status === "restricted" ? "TABLE_ACCESS_RESTRICTED"
          : last.status === "no_new_post" ? "TABLE_NO_TODAY_POST"
          : last.status === "older_skipped" ? "TABLE_OLDER_RUN_SKIPPED" : "TABLE_RUN_FAILED";
      }
      options.onResult?.(result);
    } catch (error) {
      // Exceptions can include signed URLs, cookies or model credentials. Never serialize them.
      last = { ...last, status: "failed", errorCode: safeCode(error instanceof Error ? error.message : null) ?? "TABLE_RUN_FAILED" };
    }
    await persist(last);
    if (!success.has(last.status)) options.onAlert?.(last);
    previous = last;
    if (options.once || options.signal.aborted) break;
    try { await delay(options.intervalMs, undefined, { signal: options.signal }); }
    catch (error) { if (!options.signal.aborted) throw error; }
  }
  return last;
}

export function tableRunSucceeded(status: string): boolean { return success.has(status); }
