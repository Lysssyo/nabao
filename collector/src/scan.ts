import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { parseHTML } from "linkedom";
import { readNotePage, readProfilePage } from "./dom.js";
import { mergeNotePage, readStructuredNote } from "./structured-note.js";
import { captureIssues, compareCaptureRecency, contentHash, discoveryResult, imageCandidates, normalizedTimestamp } from "./rules.js";
import { loadAuthorConfig, requireVotingAuthors, withAuthorLease, type AuthorLease } from "./author-store.js";
import { processCapture, type ProcessingResult } from "./pipeline.js";
import { PROMPT_VERSION } from "./extract.js";
import { openDedicatedSession, sessionDirectory } from "./browser-session.js";
import { postInternal } from "./submit.js";
import { loadState, writeJson } from "./storage.js";
import { acquireProcessLock } from "./process-lock.js";
import type { ImageEvidence, NoteCapture, RawNotePage, RunStatus } from "./types.js";

export interface ScanOptions {
  sourceId?: string;
  maxNotes: number;
  headless: boolean;
  dataDirectory: string;
  knownNotesOnly?: boolean;
  captureOnly?: boolean;
  authorLease?: AuthorLease;
}
interface SourceResult {
  authorId: string;
  status: RunStatus;
  transport: "http" | "browser" | null;
  discoveredCount: number;
  issues: string[];
  notes: NoteCapture[];
  processing: ProcessingResult[];
  discoveryComplete: boolean;
}

function allowedPublicURL(value: string, image = false): URL {
  const url = new URL(value);
  const validHost = image
    ? ["xhscdn.com", "xiaohongshu.com"].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
    : ["www.xiaohongshu.com", "xiaohongshu.com", "xhslink.cn"].includes(url.hostname);
  if (url.protocol !== "https:" || !validHost || url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("PUBLIC_URL_NOT_ALLOWED");
  }
  return url;
}

async function publicBytes(value: string, image = false): Promise<{ bytes: Buffer; contentType: string }> {
  const initial = allowedPublicURL(value, image);
  let url = initial;
  for (let redirect = 0; redirect <= 3; redirect++) {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
      headers: { Accept: image ? "image/*" : "text/html" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("REDIRECT_WITHOUT_LOCATION");
      url = allowedPublicURL(new URL(location, url).toString(), image);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP_${response.status}`);
    }
    const maxBytes = image ? 20 * 1024 * 1024 : 8 * 1024 * 1024;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("EMPTY_RESPONSE");
    const buffers: Buffer[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error("RESPONSE_TOO_LARGE"); }
      buffers.push(Buffer.from(chunk.value));
    }
    return { bytes: Buffer.concat(buffers), contentType: response.headers.get("content-type") ?? "" };
  }
  throw new Error("TOO_MANY_REDIRECTS");
}

async function htmlDocument(url: string): Promise<{ document: Document; html: string }> {
  const response = await publicBytes(url);
  if (!response.contentType.includes("text/html")) throw new Error("HTML_EXPECTED");
  const html = response.bytes.toString("utf8");
  return { document: parseHTML(html).document as unknown as Document, html };
}

function imageFormat(bytes: Buffer): { extension: string; mediaType: string } | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { extension: "jpg", mediaType: "image/jpeg" };
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: "png", mediaType: "image/png" };
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return { extension: "webp", mediaType: "image/webp" };
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return { extension: "gif", mediaType: "image/gif" };
  if (bytes.subarray(4, 8).toString() === "ftyp" && /^(avif|avis)$/.test(bytes.subarray(8, 12).toString())) return { extension: "avif", mediaType: "image/avif" };
  return null;
}

async function saveImages(raw: RawNotePage, directory: string): Promise<{ images: ImageEvidence[]; issues: string[] }> {
  const candidates = imageCandidates(raw);
  const images: ImageEvidence[] = [];
  const issues: string[] = [];
  if (candidates.length > 20 || (raw.expectedImageCount ?? 0) > 20) issues.push("IMAGE_BOUND_EXCEEDED");
  for (const candidate of candidates.slice(0, 20)) {
    try {
      const { bytes } = await publicBytes(candidate.url, true);
      const format = imageFormat(bytes);
      if (!format) throw new Error("NOT_A_SUPPORTED_IMAGE");
      const file = `image-${candidate.ordinal}.${format.extension}`;
      await writeFile(join(directory, file), bytes, { mode: 0o600 });
      images.push({ ordinal: candidate.ordinal, sourceUrl: candidate.url, file,
        sha256: createHash("sha256").update(bytes).digest("hex"), mediaType: format.mediaType, size: bytes.length });
    } catch (error) {
      issues.push(`IMAGE_${candidate.ordinal}_${safeError(error)}`);
    }
  }
  return { images, issues };
}

function safeError(error: unknown): string {
  // Do not print signed URLs, model keys, cookies, or response bodies.
  const value = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  return /^[A-Z_0-9]+$/.test(value) ? value : "READ_FAILED";
}

async function closeNormalLoginPrompt(page: Page): Promise<void> {
  const restricted = await page.getByText(/请完成安全验证|拖动滑块|访问过于频繁|访问受限|网络环境存在风险|IP存在风险|安全限制/).count();
  if (restricted > 0) return;
  for (const selector of [".login-container .close-wrapper", '.login-container button[aria-label="关闭"]', ".login-container .close-icon"]) {
    const button = page.locator(selector).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 2000 });
      break;
    }
  }
}

export async function scan(options: ScanOptions): Promise<{ status: RunStatus; reportFile: string; sourceCount: number }> {
  return withAuthorLease(options.dataDirectory, lease => scanWithAuthors(options, lease), options.authorLease);
}
async function scanWithAuthors(options: ScanOptions, lease: AuthorLease): Promise<{ status: RunStatus; reportFile: string; sourceCount: number }> {
  requireVotingAuthors(lease.config);
  const sources = lease.config.authors;
  const selected = options.sourceId ? sources.filter((source) => source.id === options.sourceId) : sources;
  if (selected.length === 0) throw new Error("Unknown source ID.");
  if (!Number.isInteger(options.maxNotes) || options.maxNotes < 1 || options.maxNotes > 20) throw new Error("maxNotes must be 1–20.");
  const data = resolve(options.dataDirectory);
  await mkdir(data, { recursive: true, mode: 0o700 });
  const lock = await acquireProcessLock(join(data, "scan.lock"), "SCAN_BUSY");
  let browser: Browser | undefined;
  let browserContext: BrowserContext | undefined;
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const runDirectory = join(data, "runs", runId);
  try {
    const state = await loadState(data);
    const getPage = async (url: string): Promise<Page> => {
      allowedPublicURL(url);
      if (!browserContext) {
        if (sessionDirectory()) browserContext = await openDedicatedSession(options.headless);
        else {
          browser ??= await chromium.launch({ headless: options.headless });
          browserContext = await browser.newContext({
            locale: "zh-CN", timezoneId: "Asia/Shanghai",
            ...(process.env.NABAO_BROWSER_STORAGE_STATE ? { storageState: resolve(process.env.NABAO_BROWSER_STORAGE_STATE) } : {}),
          });
        }
      }
      const page = await browserContext.newPage();
      page.setDefaultTimeout(5000);
      // Reuse only our explicitly configured dedicated session, never a daily
      // browser profile, remote debugger, or external cookie export.
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
        await closeNormalLoginPrompt(page);
        return page;
      } catch (error) { await page.close(); throw error; }
    };
    const results: SourceResult[] = [];
    for (const source of selected) {
      const result: SourceResult = { authorId: source.id, status: "partial", transport: null, discoveredCount: 0, issues: [], notes: [], processing: [], discoveryComplete: false };
      const sourceDirectory = join(runDirectory, source.id);
      await mkdir(sourceDirectory, { recursive: true });
      results.push(result);
      let profile: ReturnType<typeof readProfilePage> | undefined;
      if (!options.knownNotesOnly) {
      try {
        const response = await htmlDocument(source.profileUrl);
        profile = readProfilePage(response.document);
        await writeFile(join(sourceDirectory, "profile.http.html"), response.html, { mode: 0o600 });
        if (discoveryResult(profile, options.maxNotes).status === "success") result.transport = "http";
        else profile = undefined;
      } catch { /* Normal HTML requests can return login pages; try normal rendering. */ }
      if (!profile) {
        // One browser attempt after HTTP fallback. An actual access wall is not retried.
        let page: Page | undefined;
        try {
          page = await getPage(source.profileUrl);
          profile = await page.evaluate(readProfilePage, undefined);
          result.transport = "browser";
          await writeFile(join(sourceDirectory, "profile.browser.html"), await page.content(), { mode: 0o600 });
        } catch (error) { result.issues.push(safeError(error)); }
        finally { await page?.close(); }
      }
      if (!profile) { result.status = "blocked"; continue; }
      const discovery = discoveryResult(profile, options.maxNotes);
      const notes = discovery.notes;
      result.discoveryComplete = discovery.status === "success";
      result.discoveredCount = notes.length;
      if (discovery.issue) result.issues.push(discovery.issue);
      if (discovery.status === "blocked") {
        result.status = "blocked";
        continue;
      }
      }
      const notes = options.knownNotesOnly ? (source.seedNotes ?? []).slice(0, options.maxNotes)
        : discoveryResult(profile!, options.maxNotes).notes;
      if (options.knownNotesOnly) result.discoveredCount = 0;
      for (const note of notes) {
        const directory = join(sourceDirectory, note.noteId);
        await mkdir(directory, { recursive: true });
        let raw: RawNotePage | undefined;
        let downloaded: Awaited<ReturnType<typeof saveImages>> = { images: [], issues: [] };
        let transport: "http" | "browser" | null = null;
        try {
          const response = await htmlDocument(note.url);
          const candidate = mergeNotePage(readNotePage(response.document),
            readStructuredNote(response.html, note.noteId, source.id));
          await writeFile(join(directory, "note.http.html"), response.html, { mode: 0o600 });
          if (!candidate.accessRestricted && candidate.body && candidate.authorIds.includes(source.id)
            && candidate.expectedImageCount !== null && normalizedTimestamp(candidate.sourcePublishedAt)) {
            downloaded = await saveImages(candidate, directory);
            if (captureIssues(candidate, source.id, downloaded.images).length === 0 && downloaded.issues.length === 0) {
              raw = candidate;
              transport = "http";
            }
          }
        } catch { /* Render the public page if static content is incomplete. */ }
        if (!raw) {
          let page: Page | undefined;
          try {
            page = await getPage(note.url);
            const html = await page.content();
            raw = mergeNotePage(await page.evaluate(readNotePage, undefined),
              readStructuredNote(html, note.noteId, source.id));
            // Read mounted carousel slides. If normal next controls are available,
            // advance at most the declared number of images to load lazy pictures.
            const allCandidates = [...raw.imageCandidates];
            if (!raw.accessRestricted && raw.expectedImageCount !== null
              && imageCandidates(raw).length < raw.expectedImageCount) {
              for (let slide = 1; slide < Math.min(raw.expectedImageCount, 20); slide++) {
                const next = page.locator('.media-container .swiper-button-next, .note-slider .swiper-button-next, .media-container button[aria-label="下一张"]').first();
                if (!await next.isVisible().catch(() => false) || await next.getAttribute("aria-disabled") === "true") break;
                await next.click();
                await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
                const current = mergeNotePage(await page.evaluate(readNotePage, undefined),
                  readStructuredNote(await page.content(), note.noteId, source.id));
                allCandidates.push(...current.imageCandidates);
              }
              raw.imageCandidates = allCandidates;
            }
            transport = "browser";
            await writeFile(join(directory, "note.browser.html"), await page.content(), { mode: 0o600 });
            downloaded = raw.accessRestricted ? { images: [], issues: [] } : await saveImages(raw, directory);
          } catch (error) {
            downloaded.issues.push(safeError(error));
          } finally { await page?.close(); }
        }
        const issues = raw ? [...captureIssues(raw, source.id, downloaded.images), ...downloaded.issues] : ["NOTE_UNREADABLE", ...downloaded.issues];
        const complete = raw !== undefined && issues.length === 0;
        const revision = complete && raw ? contentHash(raw.title, raw.body, downloaded.images) : null;
        const capture: NoteCapture = {
          noteId: note.noteId, authorId: source.id, evidenceRef: note.canonicalUrl,
          openUrl: source.seedNotes?.find((item) => item.noteId === note.noteId)?.url ?? note.url,
          capturedAt: new Date().toISOString(), title: raw?.title ?? "", body: raw?.body ?? "",
          sourcePublishedAt: normalizedTimestamp(raw?.sourcePublishedAt ?? null),
          sourceUpdatedAt: normalizedTimestamp(raw?.sourceUpdatedAt ?? null),
          expectedImageCount: raw?.expectedImageCount ?? null, images: downloaded.images, revision,
          captureStatus: raw?.accessRestricted ? "blocked" : !complete ? "partial"
            : state.notes[note.noteId]?.revision === revision ? "no-change" : "success",
          issues,
        };
        await writeJson(join(directory, "capture.json"), { ...capture, transport });
        result.notes.push(capture);
      }
      // A profile's first card is not necessarily its newest note. Only verified
      // detail-page publication/edit metadata establishes captured-note order.
      result.notes.sort(compareCaptureRecency);
      for (const capture of result.notes) {
        const directory = join(sourceDirectory, capture.noteId);
        const revision = capture.revision;
        const previous = state.notes[capture.noteId];
        const alreadyPublished = revision && previous?.publishedRevision === revision
          && previous?.publishedPromptVersion === PROMPT_VERSION && previous?.publishedModel === process.env.NABAO_LLM_MODEL;
        const processingDirectory = !options.captureOnly && revision && previous?.revision === revision
          ? resolve(data, previous.evidenceDirectory) : directory;
        const processing: ProcessingResult | undefined = options.captureOnly ? undefined : alreadyPublished
          ? { status: "published", stage: "submission", observationCount: 0, issues: [] }
          : await processCapture(capture, processingDirectory, data, sources);
        if (processing) result.processing.push(processing);
        if (revision) {
          state.notes[capture.noteId] = {
            ...(options.captureOnly ? previous : {}),
            revision, capturedAt: capture.capturedAt, evidenceDirectory: relative(data, processingDirectory),
            ...(processing?.status === "published" ? {
              publishedRevision: revision, publishedPromptVersion: PROMPT_VERSION, publishedModel: process.env.NABAO_LLM_MODEL,
            } : {}),
          };
        }
        await writeJson(join(data, "state.json"), state);
      }
      const completed = options.captureOnly
        ? result.notes.every((item) => item.captureStatus === "success" || item.captureStatus === "no-change")
        : result.processing.every((item) => item.status === "published");
      result.status = result.notes.length > 0 && completed
        ? result.notes.every((item) => item.captureStatus === "no-change") ? "no-change" : "success"
        : result.notes.length > 0 && result.notes.every((item) => item.captureStatus === "blocked") ? "blocked" : "partial";
      if (!options.knownNotesOnly && !result.discoveryComplete && result.status !== "blocked") result.status = "partial";
    }
    await writeJson(join(data, "state.json"), state);
    const status: RunStatus = results.every((result) => result.status === "blocked") ? "blocked"
      : results.every((result) => result.status === "no-change") ? "no-change"
      : results.every((result) => ["success", "no-change"].includes(result.status)) ? "success" : "partial";
    const reportFile = join(runDirectory, "report.json");
    const report = {
      runId, startedAt, finishedAt: new Date().toISOString(), status,
      automaticDiscoveryValidated: !options.knownNotesOnly && results.every((item) => item.discoveryComplete),
      discoveryMode: options.knownNotesOnly ? "configured-notes" : "author-profile",
      ...(options.captureOnly ? { captureOnly: true } : {}),
      scope: { maxNotesPerAuthor: options.maxNotes, sourceIds: selected.map((source) => source.id) },
      results,
    };
    await writeJson(reportFile, report);
    if (!options.captureOnly && process.env.NABAO_INTERNAL_KEY) {
      try {
        await postInternal(`/internal/v1/runs/${runId}`, {
          ...report,
          results: results.map(({ discoveryComplete: _discoveryComplete, ...result }) => ({
            ...result, notes: result.notes.map(({ noteId, revision, captureStatus, issues }) => ({ noteId, revision, captureStatus, issues })),
          })),
        }, "PUT");
      } catch {
        await writeJson(join(runDirectory, "report-upload.json"), { status: "failed", issue: "REPORT_UPLOAD_FAILED" });
      }
    }
    return { status, reportFile, sourceCount: results.length };
  } finally {
    try { await browserContext?.close(); await browser?.close(); }
    finally { await lock.release(); }
  }
}

export async function doctor(): Promise<Record<string, unknown>> {
  let browserInstalled = true;
  try { await access(chromium.executablePath()); } catch { browserInstalled = false; }
  return {
    node: process.version,
    nodeSupported: Number(process.versions.node.split(".")[0]) >= 22,
    browserInstalled,
    browserPath: chromium.executablePath(),
    model: process.env.NABAO_LLM_API_KEY && process.env.NABAO_LLM_BASE_URL && process.env.NABAO_LLM_MODEL
      ? process.env.NABAO_LLM_MODEL : "NOT_CONFIGURED",
    browserSession: sessionDirectory() ? "dedicated-profile"
      : process.env.NABAO_BROWSER_STORAGE_STATE ? "configured-session-file" : "anonymous",
    internalKeyConfigured: Boolean(process.env.NABAO_INTERNAL_KEY?.trim()),
    backendUrl: process.env.NABAO_BACKEND_URL ?? "http://localhost:8080",
    dataDirectory: resolve(process.env.NABAO_DATA_DIR ?? "data"),
    sources: (await loadAuthorConfig(resolve(process.env.NABAO_DATA_DIR ?? "data"))).authors.map(({ id, name, profileUrl }) => ({ id, name, profileUrl })),
    automaticDiscovery: "NOT_CHECKED_BY_DOCTOR",
    message: "doctor 只检查本地配置，不访问小红书、模型服务或提交候选值。",
  };
}
