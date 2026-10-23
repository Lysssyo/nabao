import { parseHTML } from "linkedom";
import type { RawNotePage } from "./types.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectValue : null;

// The page embeds JSON with bare undefined values. Only replace tokens outside
// JSON strings; JSON.parse rejects calls, expressions, comments and other JS.
function parseState(source: string): unknown {
  let normalized = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (quoted) {
      normalized += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') {
      quoted = true;
      normalized += character;
    } else if (source.startsWith("undefined", index)
      && !/[\w$]/.test(source[index - 1] ?? "")
      && !/[\w$]/.test(source[index + 9] ?? "")) {
      normalized += "null";
      index += 8;
    } else {
      normalized += character;
    }
  }
  return JSON.parse(normalized);
}

function timestamp(value: unknown): string | null {
  // These page fields are epoch milliseconds. Reject seconds and human dates;
  // neither the note ID nor the current time supplies absent publication data.
  if (typeof value !== "number" || !Number.isSafeInteger(value)
    || value < 1_000_000_000_000 || value > 9_999_999_999_999) return null;
  return new Date(value).toISOString();
}

function imageUrl(value: unknown): string | null {
  const image = object(value);
  if (!image) return null;
  const variants = Array.isArray(image.infoList)
    ? image.infoList.map(object).filter((item) => item !== null) : [];
  const candidates = [
    image.urlDefault,
    image.url,
    ...variants.filter((item) => item.imageScene === "WB_DFT").map((item) => item.url),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    try {
      const url = new URL(candidate);
      if (["https:", "http:"].includes(url.protocol)) return candidate;
    } catch { /* Missing or malformed image URLs must remain missing. */ }
  }
  return null;
}

/**
 * Reads only static public note data from supplied HTML. It never evaluates
 * scripts or accesses a browser session. Unsupported shapes return null so the
 * caller can use DOM extraction and preserve its access-restriction checks.
 */
export function readStructuredNote(
  html: string, noteId: string, authorId: string,
): RawNotePage | null {
  const document = parseHTML(html).document;
  for (const script of document.querySelectorAll("script")) {
    const assignment = (script.textContent ?? "").match(
      /^\s*window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)\s*;?\s*$/,
    );
    if (!assignment?.[1]) continue;
    try {
      const state = object(parseState(assignment[1]));
      const map = object(object(state?.note)?.noteDetailMap);
      if (!map || !Object.hasOwn(map, noteId)) continue;
      const note = object(object(map[noteId])?.note);
      if (!note || note.noteId !== noteId || object(note.user)?.userId !== authorId
        || !Array.isArray(note.imageList)) continue;
      const imageCandidates = note.imageList.flatMap((item, ordinal) => {
        const url = imageUrl(item);
        return url ? [{ url, ordinal }] : [];
      });
      return {
        title: typeof note.title === "string" ? note.title : "",
        body: typeof note.desc === "string" ? note.desc : "",
        authorIds: [authorId],
        imageCandidates,
        expectedImageCount: note.imageList.length,
        sourcePublishedAt: timestamp(note.time),
        sourceUpdatedAt: timestamp(note.lastUpdateTime),
        accessRestricted: false,
        restrictionReason: null,
      };
    } catch { /* Not a supported static state; leave DOM fallback available. */ }
  }
  return null;
}

export function mergeNotePage(dom: RawNotePage, structured: RawNotePage | null): RawNotePage {
  if (dom.accessRestricted || !structured) return dom;
  // A rendered different author is not overridden by a cached/recommended note.
  if (dom.authorIds.length > 0 && !dom.authorIds.includes(structured.authorIds[0]!)) return dom;
  const conflictingCount = dom.expectedImageCount !== null
    && dom.expectedImageCount !== structured.expectedImageCount;
  const imageCandidates = structured.imageCandidates.map((candidate) => {
    // The rendered page upgrades CDN images to HTTPS. Prefer that observed
    // secure URL when it names the exact same image, keeping source ordering.
    const secure = dom.imageCandidates.find((item) => item.url.startsWith("https://")
      && item.url.replace(/^https:/, "") === candidate.url.replace(/^https?:/, ""));
    return secure ? { ...candidate, url: secure.url } : candidate;
  });
  return {
    ...structured,
    title: structured.title || dom.title,
    body: structured.body || dom.body,
    sourcePublishedAt: structured.sourcePublishedAt ?? dom.sourcePublishedAt,
    sourceUpdatedAt: structured.sourceUpdatedAt ?? dom.sourceUpdatedAt,
    expectedImageCount: conflictingCount ? null : structured.expectedImageCount,
    imageCandidates,
  };
}
