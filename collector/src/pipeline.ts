import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { extract, PROMPT_VERSION, validateCaptureEvidence, type ExtractionResult } from "./extract.js";
import { loadFundCatalog } from "./catalog.js";
import { normalizeRows } from "./normalize.js";
import { submitSnapshot } from "./submit.js";
import { writeJson } from "./storage.js";
import type { NoteCapture } from "./types.js";
import { contentHash, normalizedTimestamp } from "./rules.js";
import { createHash } from "node:crypto";

export interface ProcessingResult {
  status: "published" | "partial" | "failed";
  stage: "capture" | "extraction" | "normalization" | "submission";
  observationCount: number;
  issues: string[];
  published?: boolean;
}

/** One note is the retry boundary; a complete response can publish its verified subset. */
export async function processCapture(capture: NoteCapture, directory: string, dataDirectory: string): Promise<ProcessingResult> {
  const result: ProcessingResult = { status: "partial", stage: "capture", observationCount: 0, issues: [] };
  if (!capture.revision || !["success", "no-change"].includes(capture.captureStatus) || capture.issues.length) {
    result.issues.push("CAPTURE_INCOMPLETE");
    return result;
  }
  if (capture.revision !== contentHash(capture.title, capture.body, capture.images)
    || capture.expectedImageCount !== capture.images.length
    || !normalizedTimestamp(capture.sourcePublishedAt) || !normalizedTimestamp(capture.capturedAt)) {
    result.issues.push("CAPTURE_METADATA_INVALID");
    return result;
  }
  result.stage = "extraction";
  let extraction: ExtractionResult | undefined;
  try {
    const cached = JSON.parse(await readFile(join(directory, "extraction.json"), "utf8"));
    if (cached.revision === capture.revision && ["SUCCESS", "PARTIAL"].includes(cached.result?.status)
      && cached.result.promptVersion === PROMPT_VERSION
      && cached.result.model === process.env.NABAO_LLM_MODEL) extraction = cached.result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  if (extraction) {
    const evidenceProblems = await validateCaptureEvidence(capture, directory);
    if (evidenceProblems.length) {
      result.stage = "capture";
      result.issues.push(...evidenceProblems.map((issue) => issue.code));
      await writeJson(join(directory, "processing.json"), result);
      return result;
    }
  }
  extraction ??= await extract(capture, directory);
  await writeJson(join(directory, "extraction.json"), { revision: capture.revision, result: extraction });
  if (!["SUCCESS", "PARTIAL"].includes(extraction.status)
    || (extraction.status === "PARTIAL" && extraction.rows.length === 0)) {
    result.issues.push(`EXTRACTION_${extraction.status}`, ...extraction.issues.map((item) => item.code));
    await writeJson(join(directory, "processing.json"), result);
    return result;
  }
  result.issues.push(...extraction.issues.map((item) => item.code));
  result.stage = "normalization";
  try {
    const catalog = await loadFundCatalog(dataDirectory);
    const normalized = normalizeRows(extraction.rows, capture, catalog.funds);
    result.observationCount = normalized.items.length;
    await writeJson(join(directory, "normalized.json"), normalized);
    result.issues.push(...normalized.issues.map((item) => item.code));
    result.issues = [...new Set(result.issues)];
    // A complete source/model response may contain uncertain rows. Publish only
    // the verified subset, exclude uncertain votes, and retain a partial report.
    // No failure or all-unresolved response is allowed to become an empty snapshot.
    if (normalized.items.length || (extraction.rows.length === 0 && result.issues.length === 0)) {
      result.stage = "submission";
      const semanticRows = normalized.items.map(({ noteRevision: _revision, capturedAt: _capturedAt, ...item }) => item)
        .map((item) => JSON.stringify(item)).sort();
      const publicationRevision = createHash("sha256").update(JSON.stringify({
        sourceRevision: capture.revision, promptVersion: extraction.promptVersion, model: extraction.model,
        sourcePublishedAt: capture.sourcePublishedAt, sourceUpdatedAt: capture.sourceUpdatedAt,
        rows: semanticRows,
      })).digest("hex");
      const publication = {
        sourceRevision: capture.revision, publicationRevision,
        promptVersion: extraction.promptVersion, model: extraction.model,
        verifiedCount: normalized.items.length, unresolvedCount: normalized.issues.length,
      };
      await writeJson(join(directory, "publication.json"), publication);
      const response = await submitSnapshot({ ...capture, revision: publicationRevision },
        normalized.items.map((item) => ({ ...item, noteRevision: publicationRevision })));
      await writeJson(join(directory, "submission.json"), response);
      result.published = true;
      result.status = result.issues.length ? "partial" : "published";
    }
  } catch (error) {
    result.status = "failed";
    const message = error instanceof Error ? error.message : "";
    result.issues.push(/^[A-Z_0-9]+$/.test(message) ? message : `${result.stage.toUpperCase()}_FAILED`);
  }
  await writeJson(join(directory, "processing.json"), result);
  return result;
}
