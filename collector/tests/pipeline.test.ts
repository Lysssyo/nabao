import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processCapture } from "../src/pipeline.js";
import { contentHash } from "../src/rules.js";
import { PROMPT_VERSION, type CandidateRow } from "../src/extract.js";
import type { NoteCapture } from "../src/types.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+sRe8AAAAASUVORK5CYII=", "base64");
const row: CandidateRow = {
  fundCode: "016452", fundName: "南方纳斯达克100指数(QDII)A",
  channelScope: "DISTRIBUTOR", businessType: "UNSPECIFIED", period: "UNSPECIFIED",
  limitKind: "LIMITED", rawAmount: "10元", currency: "CNY", observedForDate: "2026-10-20",
  evidenceLocation: "image:1,row:3",
  evidenceText: "2026-10-20 016452 南方纳斯达克100指数(QDII)A 代销10元",
};
const environmentKeys = [
  "NABAO_LLM_BASE_URL", "NABAO_LLM_API_KEY", "NABAO_LLM_MODEL", "NABAO_LLM_TIMEOUT_MS",
  "NABAO_LLM_MAX_TOKENS", "NABAO_LLM_THINKING_DISABLED", "NABAO_INTERNAL_KEY", "NABAO_BACKEND_URL",
];

async function setup(t: TestContext, options: {
  failSubmissions?: number; rows?: CandidateRow[]; modelIssues?: string[]; modelStatus?: number;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "nabao-pipeline-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "image-0.png"), png);
  await writeFile(join(directory, "fund-catalog.json"), JSON.stringify({
    source: "https://fund.eastmoney.com/js/fundcode_search.js", fetchedAt: new Date().toISOString(),
    funds: [{ code: "016452", name: "南方纳斯达克100指数发起(QDII)A" }],
  }));
  const capture: NoteCapture = {
    noteId: "aaaaaaaaaaaaaaaaaaaaaaaa", authorId: "6168030000000000020278b5",
    evidenceRef: "https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa",
    capturedAt: "2026-10-20T02:00:00Z", sourcePublishedAt: "2026-10-20T01:00:00Z", sourceUpdatedAt: null,
    title: "公开额度表", body: "2026-10-20 额度见配图", expectedImageCount: 1, captureStatus: "success",
    images: [{
      ordinal: 0, file: "image-0.png", sourceUrl: "https://test.xhscdn.com/image.png", mediaType: "image/png",
      sha256: createHash("sha256").update(png).digest("hex"), size: png.length,
    }],
    revision: null, issues: [],
  };
  capture.revision = contentHash(capture.title, capture.body, capture.images);
  const calls: { model: Record<string, any>[]; submissions: Record<string, any>[] } = { model: [], submissions: [] };
  const stored = new Map<string, unknown>();
  let remainingFailures = options.failSubmissions ?? 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, any>;
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/chat/completions") {
      calls.model.push(payload);
      if (options.modelStatus) { res.writeHead(options.modelStatus); res.end('{"error":"model failure"}'); return; }
      res.end(JSON.stringify({
        choices: [{
          finish_reason: "stop", message: {
            role: "assistant", content: JSON.stringify({ rows: options.rows ?? [row], issues: options.modelIssues ?? [] }),
          },
        }],
      }));
    } else if (req.url === "/internal/v1/note-snapshots") {
      calls.submissions.push(payload);
      assert.equal(req.headers["x-internal-key"], "test-internal-key");
      if (remainingFailures-- > 0) { res.writeHead(503); res.end('{"error":"temporary"}'); return; }
      // Models the backend's already-tested snapshot idempotency contract.
      const id = `${payload.authorId}/${payload.noteId}/${payload.noteRevision}`;
      const duplicate = stored.has(id);
      stored.set(id, payload);
      res.end(JSON.stringify({ status: duplicate ? "duplicate" : "published" }));
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const savedEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  for (const key of environmentKeys) delete process.env[key];
  Object.assign(process.env, {
    NABAO_LLM_BASE_URL: `${origin}/v1`, NABAO_LLM_MODEL: "mock-only-vision", NABAO_LLM_API_KEY: "mock-only-key",
    NABAO_BACKEND_URL: origin, NABAO_INTERNAL_KEY: "test-internal-key",
  });
  t.after(() => {
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, origin, "This test must never contact a model, XHS, or other external service.");
    return realFetch(input, init);
  });
  return { capture, directory, calls, stored };
}

test("complete replay extracts real request payload, normalizes metadata and publishes one snapshot", async (t) => {
  const { capture, directory, calls } = await setup(t);
  const result = await processCapture(capture, directory, directory);
  assert.equal(result.status, "published");
  assert.equal(result.stage, "submission");
  assert.equal(result.observationCount, 1);
  assert.deepEqual(result.issues, []);
  assert.equal(calls.model.length, 1);
  assert.equal(calls.submissions.length, 1);
  assert.equal(calls.model[0]!.messages[1].content.length, 2);
  const submission = calls.submissions[0]!;
  assert.match(submission.noteRevision, /^[a-f0-9]{64}$/);
  assert.notEqual(submission.noteRevision, capture.revision);
  assert.equal(submission.items[0].noteRevision, submission.noteRevision);
  assert.equal(submission.capturedAt, capture.capturedAt);
  assert.equal(submission.sourcePublishedAt, capture.sourcePublishedAt);
  assert.equal(submission.items[0].fundCode, "016452");
  assert.equal(submission.items[0].amountMinor, 1000);
  assert.equal(submission.items[0].businessType, "UNSPECIFIED");
  const persisted = JSON.parse(await readFile(join(directory, "processing.json"), "utf8"));
  assert.equal(persisted.status, "published");
});

test("backend failure retries cached extraction without another model call or changing source times", async (t) => {
  const { capture, directory, calls, stored } = await setup(t, { failSubmissions: 1 });
  const failed = await processCapture(capture, directory, directory);
  assert.equal(failed.status, "failed");
  assert.equal(failed.stage, "submission");
  const retry = await processCapture(capture, directory, directory);
  assert.equal(retry.status, "published");
  const duplicate = await processCapture(capture, directory, directory);
  assert.equal(duplicate.status, "published");
  assert.equal(calls.model.length, 1);
  assert.equal(calls.submissions.length, 3);
  assert.equal(stored.size, 1);
  assert.deepEqual(calls.submissions[1], calls.submissions[0]);
  assert.deepEqual(calls.submissions[2], calls.submissions[0]);
});

test("blocked and partial captures never invoke a model or publish even with a success cache", async (t) => {
  const { capture, directory, calls } = await setup(t);
  await writeFile(join(directory, "extraction.json"), JSON.stringify({
    revision: capture.revision, result: {
      status: "SUCCESS", rows: [row], issues: [], model: "mock-only-vision", promptVersion: PROMPT_VERSION,
    },
  }));
  for (const status of ["partial", "blocked"] as const) {
    const result = await processCapture({ ...capture, captureStatus: status, issues: ["IMAGES_INCOMPLETE"] }, directory, directory);
    assert.equal(result.status, "partial");
    assert.equal(result.stage, "capture");
  }
  assert.equal(calls.model.length, 0);
  assert.equal(calls.submissions.length, 0);
});

test("a missing image with success flags still fails extraction and cannot replace a snapshot", async (t) => {
  const { capture, directory, calls } = await setup(t);
  await rm(join(directory, "image-0.png"));
  const result = await processCapture(capture, directory, directory);
  assert.notEqual(result.status, "published");
  assert.equal(calls.model.length, 0);
  assert.equal(calls.submissions.length, 0);
});

test("a cached success cannot publish when a saved image disappeared", async (t) => {
  const { capture, directory, calls } = await setup(t);
  await writeFile(join(directory, "extraction.json"), JSON.stringify({
    revision: capture.revision, result: {
      status: "SUCCESS", rows: [row], issues: [], model: "mock-only-vision", promptVersion: PROMPT_VERSION,
    },
  }));
  await rm(join(directory, "image-0.png"));
  const result = await processCapture(capture, directory, directory);
  assert.equal(result.stage, "capture");
  assert.equal(result.published, undefined);
  assert.ok(result.issues.includes("IMAGE_FILE_MISSING"));
  assert.equal(calls.model.length, 0);
  assert.equal(calls.submissions.length, 0);
});

test("cached partial candidates cannot publish after image bytes change", async (t) => {
  const { capture, directory, calls } = await setup(t);
  const cache = {
    revision: capture.revision, result: {
      status: "PARTIAL", rows: [row], issues: [{ code: "MODEL_REVIEW_REQUIRED", message: "币种未知" }],
      model: "mock-only-vision", promptVersion: PROMPT_VERSION,
    },
  };
  await writeFile(join(directory, "extraction.json"), JSON.stringify(cache));
  const modified = Buffer.from(png);
  modified[modified.length - 1] = modified[modified.length - 1]! ^ 1;
  await writeFile(join(directory, "image-0.png"), modified);
  const result = await processCapture(capture, directory, directory);
  assert.equal(result.stage, "capture");
  assert.equal(result.published, undefined);
  assert.ok(result.issues.includes("IMAGE_HASH_MISMATCH"));
  assert.equal(calls.model.length, 0);
  assert.equal(calls.submissions.length, 0);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "extraction.json"), "utf8")), cache);
});

test("a changed capture body cannot reuse a success cache with its old revision", async (t) => {
  const { capture, directory, calls } = await setup(t);
  await writeFile(join(directory, "extraction.json"), JSON.stringify({
    revision: capture.revision, result: {
      status: "SUCCESS", rows: [row], issues: [], model: "mock-only-vision", promptVersion: PROMPT_VERSION,
    },
  }));
  const result = await processCapture({ ...capture, body: "changed after capture" }, directory, directory);
  assert.equal(result.stage, "capture");
  assert.equal(result.published, undefined);
  assert.ok(result.issues.includes("CAPTURE_METADATA_INVALID"));
  assert.equal(calls.model.length, 0);
  assert.equal(calls.submissions.length, 0);
});

test("source warnings remain partial while verified candidates may be published", async (t) => {
  const uncertain = await setup(t, { modelIssues: ["部分单元格无法读取"] });
  const first = await processCapture(uncertain.capture, uncertain.directory, uncertain.directory);
  assert.equal(first.stage, "submission");
  assert.equal(first.status, "partial");
  assert.equal(first.published, true);
  assert.equal(uncertain.calls.submissions.length, 1);
});

test("unresolvable identities are excluded without blocking unrelated verified rows", async (t) => {
  const { capture, directory, calls } = await setup(t, { rows: [
    row, { ...row, fundCode: null, fundName: "未知基金A" },
  ] });
  const result = await processCapture(capture, directory, directory);
  assert.equal(result.stage, "submission");
  assert.equal(result.status, "partial");
  assert.ok(result.issues.includes("FUND_UNRESOLVED"));
  assert.equal(result.published, true);
  assert.equal(calls.submissions.length, 1);
  assert.equal(calls.submissions[0]!.items.length, 1);
});

test("prompt changes invalidate the extraction cache without altering captured timestamps", async (t) => {
  const { capture, directory, calls } = await setup(t);
  await writeFile(join(directory, "extraction.json"), JSON.stringify({
    revision: capture.revision, result: {
      status: "SUCCESS", rows: [], issues: [], model: "mock-only-vision", promptVersion: "previous-prompt-version",
    },
  }));
  const result = await processCapture(capture, directory, directory);
  assert.equal(result.status, "published");
  assert.equal(calls.model.length, 1);
  assert.equal(calls.submissions[0]!.items.length, 1);
  assert.equal(calls.submissions[0]!.capturedAt, capture.capturedAt);
});

test("an explicitly empty complete table publishes an empty replacement snapshot", async (t) => {
  const { capture, directory, calls } = await setup(t, { rows: [] });
  const result = await processCapture(capture, directory, directory);
  assert.equal(result.status, "published");
  assert.equal(result.observationCount, 0);
  assert.equal(calls.submissions.length, 1);
  assert.deepEqual(calls.submissions[0]!.items, []);
  assert.notEqual(calls.submissions[0]!.noteRevision, capture.revision);
});

test("an all-unresolved or uncertain empty table cannot withdraw prior observations", async (t) => {
  const { capture, directory, calls } = await setup(t, { rows: [{ ...row, fundCode: null, fundName: "未知基金A" }] });
  assert.equal((await processCapture(capture, directory, directory)).published, undefined);
  assert.equal(calls.submissions.length, 0);
});

test("a corrected extraction gets a distinct immutable publication revision", async (t) => {
  const { capture, directory, calls, stored } = await setup(t);
  await processCapture(capture, directory, directory);
  const cache = JSON.parse(await readFile(join(directory, "extraction.json"), "utf8"));
  cache.result.rows[0].rawAmount = "20元";
  await writeFile(join(directory, "extraction.json"), JSON.stringify(cache));
  await processCapture(capture, directory, directory);
  assert.equal(calls.model.length, 1);
  assert.equal(calls.submissions.length, 2);
  assert.notEqual(calls.submissions[0]!.noteRevision, calls.submissions[1]!.noteRevision);
  assert.equal(calls.submissions[1]!.items[0].amountMinor, 2000);
  assert.equal(stored.size, 2);
});

test("provider failure is persisted as a failure and never becomes an empty replacement", async (t) => {
  const { capture, directory, calls } = await setup(t, { modelStatus: 503 });
  const result = await processCapture(capture, directory, directory);
  assert.notEqual(result.status, "published");
  assert.equal(result.stage, "extraction");
  assert.ok(result.issues.includes("MODEL_HTTP_503"));
  assert.equal(calls.submissions.length, 0);
  const cached = JSON.parse(await readFile(join(directory, "extraction.json"), "utf8"));
  assert.equal(cached.result.status, "FAILED");
});
