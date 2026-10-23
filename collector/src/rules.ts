import { createHash } from "node:crypto";
import type { DiscoveredNote, ImageEvidence, NoteCapture, ProfileNoteCard, RawNotePage } from "./types.js";

export function discoverNotes(links: string[], maxNotes: number): DiscoveredNote[] {
  const notes = new Map<string, DiscoveredNote>();
  for (const link of links) {
    let url: URL;
    try { url = new URL(link, "https://www.xiaohongshu.com"); } catch { continue; }
    if (url.protocol !== "https:" || url.hostname !== "www.xiaohongshu.com") continue;
    const id = url.pathname.match(/^\/(?:explore|discovery\/item|user\/profile\/[a-f0-9]{24})\/([a-f0-9]{24})\/?$/i)?.[1];
    if (!id) continue;
    const existing = notes.get(id);
    if (existing && (new URL(existing.url).searchParams.has("xsec_token") || !url.searchParams.has("xsec_token"))) continue;
    // Preserve observed signature parameters for navigation; canonical URL is used
    // for logs and evidence references, never as a replacement access signature.
    notes.set(id, { noteId: id, url: url.toString(), canonicalUrl: `https://www.xiaohongshu.com/explore/${id}` });
  }
  return [...notes.values()].slice(0, maxNotes);
}

export function discoveryResult(profile: {
  links: string[]; cards?: ProfileNoteCard[]; noteCardCount: number; accessRestricted: boolean; restrictionReason: string | null;
}, maxNotes: number): { status: "success" | "partial" | "blocked"; notes: DiscoveredNote[]; issue: string | null } {
  const allNotes = discoverNotes(profile.links, Number.MAX_SAFE_INTEGER);
  const metadata = new Map<string, ProfileNoteCard>();
  for (const card of profile.cards ?? []) {
    for (const note of discoverNotes(card.links, Number.MAX_SAFE_INTEGER)) metadata.set(note.noteId, card);
  }
  const notes = allNotes.map((note) => {
    const card = metadata.get(note.noteId);
    return card ? { ...note, title: card.title, pinned: card.pinned } : note;
  }).sort((a, b) => discoveryPriority(a) - discoveryPriority(b)).slice(0, maxNotes);
  if (profile.accessRestricted) return { status: "blocked", notes: [], issue: profile.restrictionReason ?? "ACCESS_RESTRICTED" };
  if (notes.length === 0) return {
    status: "blocked", notes: [],
    issue: profile.noteCardCount > 0 ? "NOTE_LINKS_UNAVAILABLE" : "PROFILE_CONTENT_UNVERIFIED",
  };
  if (notes.length < Math.min(profile.noteCardCount, maxNotes)) {
    return { status: "partial", notes, issue: "NOTE_LINKS_INCOMPLETE" };
  }
  return { status: "success", notes, issue: null };
}

function discoveryPriority(note: DiscoveredNote): number {
  const title = note.title ?? "";
  const nasdaq = /纳指|纳斯达克/i.test(title);
  const quota = /额度|限额|限购|停购|暂停申购|恢复申购|放宽|收紧|松绑|关门|开门/.test(title);
  // Profile order is merely a bounded discovery hint. A pinned summary may be
  // old; fund-limit news takes priority over unrelated posts. Real timestamps
  // from each detail page decide recency after capture, never note IDs/titles.
  return (nasdaq && quota ? 0 : quota ? 2 : 4) + (note.pinned ? 1 : 0);
}

export function compareCaptureRecency(a: NoteCapture, b: NoteCapture): number {
  const time = (capture: NoteCapture): number => Math.max(
    ...[capture.sourcePublishedAt, capture.sourceUpdatedAt].map((value) => {
      const normalized = normalizedTimestamp(value);
      return normalized ? Date.parse(normalized) : Number.NEGATIVE_INFINITY;
    }),
  );
  const left = time(a);
  const right = time(b);
  return left === right ? 0 : left > right ? -1 : 1;
}

export function normalizedTimestamp(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const day = value.slice(0, 10);
  const midnight = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== day) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

export function imageIdentity(url: string): string {
  const value = new URL(url);
  // Signed query strings and fragment changes do not add another slide. The final
  // revision hash uses downloaded bytes, not this URL key.
  return `${value.hostname.toLowerCase()}${value.pathname}`;
}

export function imageCandidates(raw: RawNotePage): { url: string; ordinal: number }[] {
  const seen = new Set<string>();
  const candidates: { url: string; ordinal: number }[] = [];
  for (const candidate of raw.imageCandidates) {
    let identity: string;
    try { identity = candidate.ordinal === null ? imageIdentity(candidate.url) : `slide:${candidate.ordinal}`; }
    catch { continue; }
    if (seen.has(identity)) continue;
    seen.add(identity);
    candidates.push({ url: candidate.url, ordinal: candidate.ordinal ?? candidates.length });
  }
  return candidates.sort((a, b) => a.ordinal - b.ordinal);
}

export function captureIssues(raw: RawNotePage, expectedAuthor: string, images: ImageEvidence[]): string[] {
  const issues: string[] = [];
  if (raw.accessRestricted) issues.push(raw.restrictionReason ?? "ACCESS_RESTRICTED");
  if (!raw.body.trim()) issues.push("NOTE_BODY_MISSING");
  if (!raw.authorIds.includes(expectedAuthor)) issues.push("AUTHOR_UNVERIFIED");
  if (raw.expectedImageCount === null) issues.push("IMAGE_COUNT_UNVERIFIED");
  else if (images.length !== raw.expectedImageCount
    || ![...images].sort((a, b) => a.ordinal - b.ordinal).every((image, index) => image.ordinal === index)) {
    issues.push("IMAGES_INCOMPLETE");
  }
  if (!normalizedTimestamp(raw.sourcePublishedAt)) issues.push("PUBLICATION_TIME_UNVERIFIED");
  if (raw.sourceUpdatedAt !== null && !normalizedTimestamp(raw.sourceUpdatedAt)) issues.push("MODIFICATION_TIME_UNVERIFIED");
  return issues;
}

export function contentHash(title: string, body: string, images: ImageEvidence[]): string {
  const normalize = (value: string) => value.normalize("NFC").replace(/\r\n/g, "\n").trim();
  return createHash("sha256").update(JSON.stringify({
    title: normalize(title),
    body: normalize(body),
    images: [...images].sort((a, b) => a.ordinal - b.ordinal).map((image) => ({ ordinal: image.ordinal, sha256: image.sha256 })),
  })).digest("hex");
}
