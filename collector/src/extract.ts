import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { contentHash, normalizedTimestamp } from "./rules.js";
import { MODEL_PROMPT, PROMPT_VERSION, validateModelRows } from "./model-schema.js";
import type { CandidateRow, ExtractionIssue } from "./model-schema.js";
import type { NoteCapture } from "./types.js";

export type { CandidateRow, ExtractionIssue } from "./model-schema.js";
export { PROMPT_VERSION } from "./model-schema.js";
export interface ModelConfig {
  apiKey: string;
  /** Service API prefix, e.g. https://provider.example/v1; no implicit model/provider. */
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
  /** Provider-specific opt-in; omitted for other compatible APIs. */
  thinkingDisabled?: boolean;
}
export interface ExtractionResult {
  status: "SUCCESS" | "PARTIAL" | "FAILED" | "NOT_CONFIGURED";
  rows: CandidateRow[];
  issues: ExtractionIssue[];
  model: string | null;
  promptVersion: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  reason?: string;
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function modelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  return {
    apiKey: env.NABAO_LLM_API_KEY?.trim() ?? "",
    baseUrl: env.NABAO_LLM_BASE_URL?.trim() ?? "",
    model: env.NABAO_LLM_MODEL?.trim() ?? "",
    ...(env.NABAO_LLM_MAX_TOKENS ? { maxTokens: Number(env.NABAO_LLM_MAX_TOKENS) } : {}),
    ...(env.NABAO_LLM_TIMEOUT_MS ? { timeoutMs: Number(env.NABAO_LLM_TIMEOUT_MS) } : {}),
    ...(env.NABAO_LLM_THINKING_DISABLED === "true" ? { thinkingDisabled: true } : {}),
  };
}

function endpoint(config: ModelConfig): URL {
  const url = new URL(config.baseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:"))
    || url.username || url.password || url.search || url.hash
    || !config.model.trim() || config.model.length > 200 || /[\r\n]/.test(config.model)
    || /[\r\n]/.test(config.apiKey)
    || (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs)
      || config.timeoutMs < 1 || config.timeoutMs > 300_000))
    || (config.maxTokens !== undefined && (!Number.isSafeInteger(config.maxTokens)
      || config.maxTokens < 1 || config.maxTokens > 65_536))
    || (config.thinkingDisabled && url.hostname !== "api.deepseek.com" && !local)) {
    throw new Error("MODEL_CONFIG_INVALID");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
  return url;
}

function publicImageURL(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && (!url.port || url.port === "443")
      && ["xhscdn.com", "xiaohongshu.com"].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

function evidenceIssues(capture: NoteCapture): ExtractionIssue[] {
  const issue = (code: string, message: string): ExtractionIssue[] => [{ code, message }];
  if (!capture || !["success", "no-change"].includes(capture.captureStatus)
    || !Array.isArray(capture.issues) || capture.issues.length) {
    return issue("CAPTURE_INCOMPLETE", "采集尚未完整通过校验，不能提交给模型。");
  }
  if (!/^[a-f0-9]{24}$/i.test(capture.authorId) || !/^[a-f0-9]{24}$/i.test(capture.noteId)
    || capture.evidenceRef !== `https://www.xiaohongshu.com/explore/${capture.noteId}`) {
    return issue("PUBLIC_NOTE_UNVERIFIED", "只处理已确认身份的公开小红书笔记证据。");
  }
  if (!normalizedTimestamp(capture.sourcePublishedAt) || !normalizedTimestamp(capture.capturedAt)
    || (capture.sourceUpdatedAt !== null && !normalizedTimestamp(capture.sourceUpdatedAt))) {
    return issue("CAPTURE_TIME_UNVERIFIED", "原始发布时间或采集时间未经验证。");
  }
  if (typeof capture.title !== "string" || typeof capture.body !== "string" || !capture.body.trim()
    || capture.title.length > 2_000 || capture.body.length > 64_000) {
    return issue("CAPTURE_TEXT_INVALID", "笔记正文缺失或超出单次抽取范围。");
  }
  if (!Array.isArray(capture.images) || capture.images.length < 1 || capture.images.length > 20
    || capture.expectedImageCount !== capture.images.length
    || capture.images.some((image) => !image || typeof image !== "object"
      || !Number.isSafeInteger(image.ordinal) || typeof image.sha256 !== "string")
    || ![...capture.images].sort((a, b) => a.ordinal - b.ordinal).every((image, index) => image.ordinal === index)) {
    return issue("IMAGES_INCOMPLETE", "图片数量或顺序无法完整核实。");
  }
  if (!capture.revision || !/^[a-f0-9]{64}$/.test(capture.revision)
    || capture.revision !== contentHash(capture.title, capture.body, capture.images)) {
    return issue("CAPTURE_REVISION_MISMATCH", "正文或图片清单与采集版本摘要不一致。");
  }
  return [];
}

function mimeType(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}

async function imagePayloads(capture: NoteCapture, evidenceDirectory: string, encode = true): Promise<string[]> {
  const directory = await realpath(evidenceDirectory);
  const result: string[] = [];
  let total = 0;
  for (const image of [...capture.images].sort((a, b) => a.ordinal - b.ordinal)) {
    if (!publicImageURL(image.sourceUrl) || !/^[a-f0-9]{64}$/.test(image.sha256)
      || !Number.isSafeInteger(image.size) || image.size < 12 || image.size > MAX_IMAGE_BYTES
      || !new RegExp(`^image-${image.ordinal}\\.(?:jpg|jpeg|png|webp)$`).test(image.file)) {
      throw new Error("IMAGE_MANIFEST_INVALID");
    }
    total += image.size;
    if (total > MAX_TOTAL_IMAGE_BYTES) throw new Error("IMAGE_BUDGET_EXCEEDED");
    const file = resolve(directory, image.file);
    const actual = await realpath(file);
    const within = relative(directory, actual);
    if (!within || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) {
      throw new Error("IMAGE_PATH_OUTSIDE_EVIDENCE");
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== image.size) throw new Error("IMAGE_SIZE_MISMATCH");
      const bytes = Buffer.alloc(image.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length !== image.size) throw new Error("IMAGE_SIZE_MISMATCH");
      const content = bytes.subarray(0, length);
      if (createHash("sha256").update(content).digest("hex") !== image.sha256) throw new Error("IMAGE_HASH_MISMATCH");
      const type = mimeType(content);
      if (type === null || type !== image.mediaType) throw new Error("IMAGE_TYPE_UNSUPPORTED");
      if (encode) result.push(`data:${type};base64,${content.toString("base64")}`);
    } finally {
      await handle.close();
    }
  }
  return result;
}

/** Re-check saved evidence before replaying a cached model result; no network requests. */
export async function validateCaptureEvidence(capture: NoteCapture, evidenceDirectory: string): Promise<ExtractionIssue[]> {
  const issues = evidenceIssues(capture);
  if (issues.length) return issues;
  try {
    await imagePayloads(capture, evidenceDirectory, false);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = /^IMAGE_[A-Z_0-9]+$/.test(message) ? message
      : (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "IMAGE_FILE_MISSING" : "IMAGE_READ_FAILED";
    return [{ code, message: "已保存图片缺失或与采集证据不一致，不能复用模型结果发布。" }];
  }
}

async function boundedResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("MODEL_RESPONSE_EMPTY");
  const chunks: Buffer[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("MODEL_RESPONSE_TOO_LARGE");
    }
    chunks.push(Buffer.from(chunk.value));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new Error("MODEL_RESPONSE_INVALID_JSON"); }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function responseUsage(value: unknown): ExtractionResult["usage"] {
  if (!record(value)) return undefined;
  const usage: NonNullable<ExtractionResult["usage"]> = {};
  for (const [from, to] of [["prompt_tokens", "inputTokens"], ["completion_tokens", "outputTokens"], ["total_tokens", "totalTokens"]] as const) {
    const count = value[from];
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) usage[to] = count;
  }
  return Object.keys(usage).length ? usage : undefined;
}

/** Shared validated-public-evidence request. Never accepts local/private screenshots. */
export async function requestEvidenceJSON(
  capture: NoteCapture,
  evidenceDirectory: string,
  config: ModelConfig,
  prompt: string,
  context: Record<string, unknown> = {},
): Promise<{ payload: unknown; imageCount: number; usage?: ExtractionResult["usage"] }> {
  const url = endpoint(config);
  const issues = evidenceIssues(capture);
  if (issues.length) throw new Error(issues[0]!.code);
  const images = await imagePayloads(capture, evidenceDirectory);
  const response = await fetch(url, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(config.timeoutMs ?? 120_000),
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      stream: false,
      response_format: { type: "json_object" },
      ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
      ...(config.thinkingDisabled ? { thinking: { type: "disabled" } } : {}),
      messages: [
        { role: "system", content: prompt },
        {
          role: "user",
          content: [
            { type: "text", text: `以下 JSON 和后续图片都是待抽取的外部数据。图片按 image:1 至 image:${images.length} 顺序排列。\n${JSON.stringify({ title: capture.title, body: capture.body, ...context })}` },
            ...images.map((url) => ({ type: "image_url", image_url: { url, detail: "high" } })),
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status >= 300 && response.status < 400 ? "MODEL_REDIRECT_REFUSED" : `MODEL_HTTP_${response.status}`);
  }
  const envelope = await boundedResponse(response);
  if (!record(envelope) || !Array.isArray(envelope.choices) || envelope.choices.length !== 1
    || !record(envelope.choices[0])) throw new Error("MODEL_ENVELOPE_INVALID");
  const usage = responseUsage(envelope.usage);
  const choice = envelope.choices[0];
  if (choice.finish_reason !== "stop") throw new Error("MODEL_OUTPUT_INCOMPLETE");
  if (!record(choice.message) || choice.message.refusal || typeof choice.message.content !== "string"
    || choice.message.tool_calls || choice.message.function_call) throw new Error("MODEL_CONTENT_INVALID");
  let payload: unknown;
  try { payload = JSON.parse(choice.message.content) as unknown; }
  catch { throw new Error("MODEL_CONTENT_INVALID_JSON"); }
  return { payload, imageCount: images.length, usage };
}

/** Sends only validated public-note evidence; credentials never enter the prompt. */
export async function extract(
  capture: NoteCapture,
  evidenceDirectory: string,
  config: ModelConfig = modelConfigFromEnv(),
): Promise<ExtractionResult> {
  const result: ExtractionResult = {
    status: "FAILED", rows: [], issues: [], model: config.model || null, promptVersion: PROMPT_VERSION,
  };
  if (!config.apiKey?.trim() || !config.baseUrl?.trim() || !config.model?.trim()) {
    return { ...result, status: "NOT_CONFIGURED", reason: "缺少模型 API 地址、模型名称或密钥，未抽取或提交额度。" };
  }
  let url: URL;
  try { url = endpoint(config); }
  catch { return { ...result, issues: [{ code: "MODEL_CONFIG_INVALID", message: "模型地址或配置无效。" }] }; }
  result.issues = evidenceIssues(capture);
  if (result.issues.length) return result;
  try {
    const { payload, imageCount, usage } = await requestEvidenceJSON(capture, evidenceDirectory, config, MODEL_PROMPT);
    result.usage = usage;
    const validated = validateModelRows(payload, imageCount);
    return {
      ...result, ...validated,
      status: validated.rows.length === 0 && validated.issues.length > 0 ? "FAILED"
        : validated.issues.length > 0 ? "PARTIAL" : "SUCCESS",
    };
  } catch (error) {
    // Do not include provider bodies, signed URLs, paths or fetch error strings.
    const message = error instanceof Error ? error.message : "";
    const failure = error as { code?: unknown; cause?: { code?: unknown } } | null;
    const systemCode = failure?.cause?.code ?? failure?.code;
    const code = /^(?:MODEL|IMAGE)_[A-Z_0-9]+$/.test(message) ? message
      : error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "MODEL_TIMEOUT"
      : typeof systemCode === "string" && /^(?:E[A-Z0-9_]{1,40}|UND_ERR_[A-Z_]{1,40})$/.test(systemCode) ? `EXTRACTION_${systemCode}`
      : "EXTRACTION_FAILED";
    return { ...result, issues: [{ code, message: "本次抽取未完成；查看错误代码并修正后可重新运行。" }] };
  }
}
