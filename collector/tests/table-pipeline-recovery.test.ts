import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { DAILY_FUND_CATALOG } from "../src/daily-fund-catalog.js";
import { dailyTableFromReport, updateDailyTable } from "../src/daily-table-run.js";
import { PRIMARY_DAILY_FUND_CODES, type DailyTable } from "../src/daily-table.js";
import type { SourceTable } from "../src/daily-table-voting.js";
import { sources } from "../src/sources.js";

test("five-author table pipeline publishes, reuses evidence and recovers from a capture failure offline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nabao-table-pipeline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = join(root, "private-data");
  const outputDirectory = join(root, "public-tables");
  const dataDate = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  t.mock.method(Date, "now", () => Date.parse(`${dataDate}T02:00:00Z`));
  const publishedAt = `${dataDate}T09:00:00+08:00`;
  const apiKey = "fixture-private-api-key";
  const modelRequests: string[] = [];
  const requestErrors: unknown[] = [];
  const modelPayload = {
    dataDateText: dataDate, dateContext: `${dataDate}纳指额度一览`, pageDates: [dataDate], notes: [`收益截至${dataDate}`],
    rows: DAILY_FUND_CATALOG.map(({ code, name }) => ({
      fundCode: code, fundName: name, feeRate: "0.65%", trackingError: "1.44%", return1y: "15.19%",
      distributorLimit: "10元/日", directLimit: "100元/日", mergedLimit: null,
    })),
  };
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.method, "POST");
      assert.equal(req.headers.authorization, `Bearer ${apiKey}`);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      assert.equal(body.includes(apiKey), false);
      const request = JSON.parse(body);
      const content = request.messages[1].content;
      assert.equal(content.length, 2);
      assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
      const evidence = JSON.parse(content[0].text.slice(content[0].text.indexOf("\n") + 1));
      assert.deepEqual(evidence.expectedCodes, PRIMARY_DAILY_FUND_CODES);
      assert.equal(evidence.sourcePublishedAt, new Date(publishedAt).toISOString());
      const author = sources.find((source) => evidence.body.includes(`fixture-private-${source.id}`));
      assert.ok(author, "every model request must come from one configured author's captured evidence");
      modelRequests.push(author.id);
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(modelPayload) } }] }));
    } catch (error) {
      requestErrors.push(error);
      res.statusCode = 500;
      res.end("fixture request rejected");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const settings: Record<string, string | undefined> = {
    NABAO_LLM_API_KEY: apiKey, NABAO_LLM_BASE_URL: baseUrl, NABAO_LLM_MODEL: "fixture-image-model",
    NABAO_LLM_MAX_TOKENS: undefined, NABAO_LLM_TIMEOUT_MS: "5000", NABAO_LLM_THINKING_DISABLED: undefined,
    NABAO_TABLE_CACHE_DIR: join(dataDirectory, "table-cache"), NABAO_TABLE_STATE_DIR: undefined,
    NABAO_DATA_DIR: undefined, NABAO_BROWSER_PROFILE: undefined, NABAO_BROWSER_STORAGE_STATE: undefined,
    NABAO_INTERNAL_KEY: "fixture-no-backend-submission",
  };
  const previous = new Map(Object.keys(settings).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const browser = t.mock.method(chromium, "launch", async () => { throw new Error("FIXTURE_BROWSER_UNAVAILABLE"); });
  const persistentBrowser = t.mock.method(chromium, "launchPersistentContext", async () => { throw new Error("FIXTURE_BROWSER_UNAVAILABLE"); });
  const routes = new Map<string, { body: string | Buffer; type: string }>();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+sRe8AAAAASUVORK5CYII=", "base64");
  const imageUrls: string[] = [];
  for (const [index, source] of sources.entries()) {
    const noteId = (index + 1).toString(16).padStart(24, "0");
    const detailUrl = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=fixture-${index}`;
    const imageUrl = `https://test.xhscdn.com/pipeline/${noteId}/0.png`;
    imageUrls.push(imageUrl);
    routes.set(source.profileUrl, { type: "text/html", body: `<html><body><div class="feeds-container">
      <section class="note-item"><a class="title" href="${detailUrl}">${dataDate}纳指额度更新</a></section>
      </div></body></html>` });
    routes.set(detailUrl, { type: "text/html", body: `<html><head>
      <meta property="article:published_time" content="${publishedAt}"></head><body><div class="note-container">
      <div class="author-container"><a href="/user/profile/${source.id}">作者</a></div>
      <div id="detail-title">${dataDate}纳指额度一览</div>
      <div id="detail-desc">${dataDate}纳指额度一览，fixture-private-${source.id}</div>
      <div class="media-container"><div class="swiper-pagination-fraction">1 / 1</div>
      <div class="swiper-slide" data-swiper-slide-index="0"><img src="${imageUrl}"></div></div>
      </div></body></html>` });
    routes.set(imageUrl, { type: "image/png", body: png });
  }
  let failingImage: string | null = null;
  const unknownRequests: string[] = [];
  const publicRequests: string[] = [];
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${baseUrl}/chat/completions`) return realFetch(input, init);
    const fixture = routes.get(url);
    if (!fixture) {
      unknownRequests.push(url);
      throw new Error("UNEXPECTED_HTTP_REQUEST");
    }
    publicRequests.push(url);
    if (url === failingImage) return new Response(null, { status: 503 });
    return new Response(typeof fixture.body === "string" ? fixture.body : new Uint8Array(fixture.body),
      { headers: { "content-type": fixture.type } });
  });
  const options = { maxNotes: 1, headless: true, dataDirectory, outputDirectory };
  const first = await updateDailyTable(options);
  assert.deepEqual(requestErrors, []);
  assert.equal(first.status, "published");
  assert.equal(first.rowCount, 41);
  assert.equal(first.adoptedFields, 41 * 5);
  assert.equal(first.pendingFields, 0);
  assert.ok(first.management.sources.every((source) => source.status === "complete" && source.errorCode === null));
  assert.deepEqual(modelRequests.slice().sort(), sources.map((source) => source.id).sort());
  assert.equal(publicRequests.length, sources.length * 3, "each author requires profile, detail and image evidence");
  assert.equal(browser.mock.callCount(), 0);
  const latestFile = join(outputDirectory, "latest.json");
  const originalBytes = await readFile(latestFile, "utf8");
  const table = JSON.parse(originalBytes) as DailyTable;
  assert.deepEqual(Object.keys(table).sort(), ["schemaVersion", "dataDate", "updatedAt", "source", "rows", "notes"].sort());
  assert.deepEqual(table.rows.map((row) => row.fundCode).sort(), [...PRIMARY_DAILY_FUND_CODES].sort());
  for (const row of table.rows) {
    assert.deepEqual(Object.keys(row).sort(), ["fundCode", "fundName", "feeRate", "distributorLimit", "directLimit", "trackingError", "return1y"].sort());
    assert.equal(row.distributorLimit, "10");
    assert.equal(row.directLimit, "100");
  }
  assert.doesNotMatch(originalBytes, /fixture-private|xsec_token|"(?:votes|authorId|capture|revision|watermarks|unitContexts)"/);
  assert.equal(await readFile(join(outputDirectory, `${dataDate}.json`), "utf8"), originalBytes);
  const stateFile = join(dataDirectory, "table-state", `daily-source-tables-${dataDate}.json`);
  const saved = JSON.parse(await readFile(stateFile, "utf8")) as SourceTable[];
  assert.deepEqual(saved.map((entry) => entry.authorId).sort(), sources.map((source) => source.id).sort());
  assert.ok(saved.every((entry) => entry.table.rows.length === 41 && entry.capture.revision && entry.validationVersion));
  assert.ok(saved.every((entry) => entry.validationStatus === "COMPLETE"));
  assert.equal((await readdir(join(dataDirectory, "table-cache"))).length, sources.length);
  await assert.rejects(access(join(root, "table-state")), { code: "ENOENT" });

  const repeat = await updateDailyTable(options);
  assert.equal(repeat.status, "unchanged");
  assert.deepEqual(repeat.management, first.management, "cached complete sources must not become partial on the next check");
  const repeatedReport = JSON.parse(await readFile(repeat.reportFile, "utf8"));
  assert.equal(repeatedReport.attempts.length, sources.length);
  assert.ok(repeatedReport.attempts.every((attempt: { cacheHit: boolean }) => attempt.cacheHit));
  assert.equal(modelRequests.length, sources.length);
  assert.equal(await readFile(latestFile, "utf8"), originalBytes);

  // A legacy cache with 41 rows did not retain whether all fields passed validation.
  // It must remain conservative rather than inferring completeness from row count.
  const currentState = await readFile(stateFile, "utf8");
  const legacyState = JSON.parse(currentState) as SourceTable[];
  for (const source of legacyState) delete source.validationStatus;
  await writeFile(stateFile, JSON.stringify(legacyState));
  const legacy = await dailyTableFromReport(join(dirname(repeat.reportFile), "report.json"), outputDirectory,
    { dataDate, stateDirectory: dirname(stateFile) });
  await assert.rejects(access(join(root, "author-config.json")), { code: "ENOENT" }, "replay must reuse the private data directory's author config");
  assert.equal(legacy.publication?.status, "UNCHANGED");
  assert.ok(legacy.management.sources.every((source) => source.status === "partial" && source.errorCode === "SOURCE_PARTIAL_FIELDS"));
  assert.equal(modelRequests.length, sources.length);
  await writeFile(stateFile, currentState);

  failingImage = imageUrls[0]!;
  const failed = await updateDailyTable(options);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "TABLE_EXTRACTION_FAILED");
  assert.equal(failed.rowCount, 41);
  assert.equal(await readFile(latestFile, "utf8"), originalBytes);
  const failureReport = JSON.parse(await readFile(failed.reportFile, "utf8"));
  const issue = failureReport.captureIssues.find((item: { authorId: string }) => item.authorId === sources[0]!.id);
  assert.ok(issue.issues.includes("IMAGE_0_HTTP_503"));
  assert.ok(issue.issues.includes("SOURCE_CAPTURE_INCOMPLETE"));
  assert.equal(modelRequests.length, sources.length);
  assert.equal(browser.mock.callCount(), 1, "the failed capture's normal browser fallback is intercepted");

  failingImage = null;
  const recovered = await updateDailyTable(options);
  assert.equal(recovered.status, "unchanged");
  assert.equal(recovered.errorCode, null);
  assert.deepEqual(recovered.management, first.management);
  assert.equal(recovered.rowCount, 41);
  const recoveredReport = JSON.parse(await readFile(recovered.reportFile, "utf8"));
  assert.ok(recoveredReport.captureIssues.every((item: { issues: string[] }) => item.issues.length === 0));
  assert.equal(recoveredReport.attempts.length, sources.length);
  const captureReport = JSON.parse(await readFile(join(dirname(recovered.reportFile), "report.json"), "utf8"));
  assert.equal(captureReport.automaticDiscoveryValidated, true);
  assert.ok(captureReport.results.every((item: { status: string }) => item.status === "no-change"));
  assert.equal(await readFile(latestFile, "utf8"), originalBytes);
  assert.equal(modelRequests.length, sources.length);
  assert.equal(publicRequests.length, sources.length * 3 * 4);
  assert.equal(browser.mock.callCount(), 1);
  assert.equal(persistentBrowser.mock.callCount(), 0);
  assert.deepEqual(unknownRequests, []);
  assert.deepEqual(requestErrors, []);
});
