import type { Observation } from "./types.js";
import { normalizedTimestamp } from "./rules.js";
import { sources } from "./sources.js";
import type { NoteCapture, SourceAuthor } from "./types.js";

export function validateObservations(input: unknown, authors: readonly SourceAuthor[] = sources): Observation[] {
  if (!input || typeof input !== "object" || !("items" in input) || !Array.isArray(input.items)
    || input.items.length < 1 || input.items.length > 500) throw new Error("items must contain 1–500 reviewed observations.");
  return input.items.map((item: unknown, index: number) => {
    const fail = (field: string): never => { throw new Error(`items[${index}].${field} is invalid`); };
    if (!item || typeof item !== "object" || Array.isArray(item)) return fail("record");
    const record = item as Record<string, unknown>;
    for (const field of ["authorId", "noteId", "noteRevision", "fundCode", "fundName", "evidenceRef"] as const) {
      if (typeof record[field] !== "string" || !record[field].trim()) fail(field);
    }
    if (!authors.some((source) => source.id === record.authorId)) fail("authorId");
    if (!/^[a-f0-9]{24}$/i.test(String(record.noteId))) fail("noteId");
    if (!/^[a-f0-9]{64}$/i.test(String(record.noteRevision))) fail("noteRevision");
    if (!/^\d{6}$/.test(String(record.fundCode))) fail("fundCode");
    const enums: Record<string, string[]> = {
      channelScope: ["DIRECT", "DISTRIBUTOR", "PARTIAL", "UNSPECIFIED"],
      businessType: ["PURCHASE", "DCA", "UNSPECIFIED"],
      period: ["DAILY", "PER_ORDER", "UNSPECIFIED"],
      limitKind: ["LIMITED", "PAUSED", "UNAVAILABLE", "UNLIMITED", "UNKNOWN"],
      currency: ["CNY", "USD", "UNSPECIFIED"],
    };
    for (const [field, allowed] of Object.entries(enums)) if (!allowed.includes(String(record[field]))) fail(field);
    if (record.limitKind === "LIMITED") {
      if (!Number.isSafeInteger(record.amountMinor) || Number(record.amountMinor) < 0) fail("amountMinor");
    } else if (record.amountMinor !== null) fail("amountMinor");
    const date = String(record.observedForDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) fail("observedForDate");
    for (const field of ["sourcePublishedAt", "capturedAt"]) {
      if (typeof record[field] !== "string" || !normalizedTimestamp(record[field])) fail(field);
    }
    if (record.sourceUpdatedAt !== null
      && (typeof record.sourceUpdatedAt !== "string" || !normalizedTimestamp(record.sourceUpdatedAt))) fail("sourceUpdatedAt");
    if (record.sourceGroupId !== undefined && typeof record.sourceGroupId !== "string") fail("sourceGroupId");
    let evidence: URL;
    try { evidence = new URL(String(record.evidenceRef)); } catch { return fail("evidenceRef"); }
    if (evidence.protocol !== "https:" || !["www.xiaohongshu.com", "xhslink.cn"].includes(evidence.hostname)) fail("evidenceRef");
    return record as unknown as Observation;
  });
}

export async function submitReviewed(input: unknown, authors: readonly SourceAuthor[] = sources): Promise<{ status: number; result: unknown }> {
  const items = validateObservations(input, authors);
  return postInternal("/internal/v1/observations", { items });
}

export async function submitSnapshot(capture: NoteCapture, items: Observation[], authors: readonly SourceAuthor[] = sources): Promise<{ status: number; result: unknown }> {
  if (!authors.some(source => source.id === capture.authorId)) throw new Error("AUTHOR_NOT_CONFIGURED");
  if (items.length) validateObservations({ items }, authors);
  return postInternal("/internal/v1/note-snapshots", {
    authorId: capture.authorId, noteId: capture.noteId, noteRevision: capture.revision,
    sourcePublishedAt: capture.sourcePublishedAt, sourceUpdatedAt: capture.sourceUpdatedAt,
    capturedAt: capture.capturedAt, evidenceRef: capture.evidenceRef, items,
  });
}

export async function postInternal(path: string, body: unknown, method = "POST"): Promise<{ status: number; result: unknown }> {
  const key = process.env.NABAO_INTERNAL_KEY;
  if (!key?.trim()) throw new Error("NABAO_INTERNAL_KEY is not configured; nothing was submitted.");
  const base = new URL(process.env.NABAO_BACKEND_URL ?? "http://localhost:8080");
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "backend"].includes(base.hostname))) {
    throw new Error("Use HTTPS for remote submission; plaintext HTTP is only allowed for local development.");
  }
  const response = await fetch(new URL(path, base), {
    method,
    headers: { "Content-Type": "application/json", "X-Internal-Key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Observation submission failed: HTTP ${response.status}.`);
  const text = await response.text();
  return { status: response.status, result: text ? JSON.parse(text) as unknown : null };
}
