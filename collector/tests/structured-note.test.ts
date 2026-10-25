import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";
import { readNotePage } from "../src/dom.js";
import { mergeNotePage, readStructuredNote } from "../src/structured-note.js";
import { captureIssues } from "../src/rules.js";

const noteId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const authorId = "6168030000000000020278b5";
const fixture = () => readFile(
  new URL("../../tests/fixtures/structured-note.html", import.meta.url), "utf8",
);

function page(overrides: Record<string, unknown> = {}): string {
  const note = {
    noteId, user: { userId: authorId }, title: "测试", desc: "正文",
    imageList: [{ urlDefault: "https://images.example/first.jpg" }], ...overrides,
  };
  return `<script>window.__INITIAL_STATE__=${JSON.stringify({
    note: { noteDetailMap: { [noteId]: { note } } },
  })};</script>`;
}

test("static state preserves strings containing undefined and explicit epoch milliseconds", async () => {
  const raw = readStructuredNote(await fixture(), noteId, authorId);
  assert.ok(raw);
  assert.equal(raw.title, "额度 undefined 汇总");
  assert.equal(raw.body, '正文 undefined；引号 "undefined"；路径 \\undefined；括号 } 均保留。');
  assert.deepEqual(raw.authorIds, [authorId]);
  assert.equal(raw.sourcePublishedAt, "2026-10-20T01:00:00.000Z");
  assert.equal(raw.sourceUpdatedAt, "2026-10-20T02:00:00.000Z");
});

test("an unrelated exact empty Map cannot hide verified note times and the independent image total", async () => {
  const html = await readFile(new URL("../../tests/fixtures/structured-note-empty-map.html", import.meta.url), "utf8");
  const structured = readStructuredNote(html, noteId, authorId)!;
  assert.ok(structured);
  assert.equal(structured.body, "测试正文保留 new Map([]) 和 undefined 字样。");
  assert.equal(structured.expectedImageCount, 10);
  assert.equal(structured.sourcePublishedAt, "2026-10-20T01:00:00.000Z");
  assert.equal(structured.sourceUpdatedAt, "2026-10-20T02:00:00.000Z");
  const dom = readNotePage(parseHTML(html).document as unknown as Document);
  assert.equal(dom.imageCandidates.length, 1);
  assert.equal(dom.expectedImageCount, 10, "the displayed fraction declares the total independently of mounted slides");
  assert.equal(dom.sourcePublishedAt, null, "JSON-LD rendering timestamps cannot replace identity-bound source times");
  assert.equal(dom.sourceUpdatedAt, null);
  const merged = mergeNotePage(dom, structured);
  assert.equal(merged.expectedImageCount, 10);
  assert.equal(merged.sourcePublishedAt, structured.sourcePublishedAt);
  assert.equal(merged.sourceUpdatedAt, structured.sourceUpdatedAt);

  const noCounter = parseHTML(html).document;
  noCounter.querySelector(".fraction")!.remove();
  assert.equal(readNotePage(noCounter as unknown as Document).expectedImageCount, null);
});

test("nonempty Map expressions remain rejected and never fall back to render timestamps", async () => {
  const html = await readFile(new URL("../../tests/fixtures/structured-note-empty-map.html", import.meta.url), "utf8");
  const marker = "__nabaoMapExecuted";
  const malicious = html.replace('"noteDetailMap":new Map([])',
    `"noteDetailMap":new Map([(() => { globalThis.${marker} = true; return []; })()])`);
  assert.equal(readStructuredNote(malicious, noteId, authorId), null);
  assert.equal(Reflect.has(globalThis, marker), false);
  const dom = readNotePage(parseHTML(malicious).document as unknown as Document);
  const merged = mergeNotePage(dom, null);
  assert.equal(merged.expectedImageCount, 10);
  assert.equal(merged.sourcePublishedAt, null);
  assert.equal(merged.sourceUpdatedAt, null);
  assert.ok(captureIssues(merged, authorId, []).includes("PUBLICATION_TIME_UNVERIFIED"));
  assert.equal(readStructuredNote(html.replace('"noteDetailMap":new Map([])',
    '"noteDetailMap":new Map([]).set("value",1)'), noteId, authorId), null);
});

test("a missing image URL preserves the total and original indices", async () => {
  const raw = readStructuredNote(await fixture(), noteId, authorId)!;
  assert.equal(raw.expectedImageCount, 3);
  assert.deepEqual(raw.imageCandidates, [
    { url: "https://images.example/first.jpg", ordinal: 0 },
    { url: "https://images.example/third.jpg", ordinal: 2 },
  ]);
  const downloaded = raw.imageCandidates.map(({ url, ordinal }) => ({
    ordinal: ordinal!, sourceUrl: url, file: `${ordinal}.jpg`,
    sha256: "a".repeat(64), mediaType: "image/jpeg", size: 1024,
  }));
  assert.ok(captureIssues(raw, authorId, downloaded).includes("IMAGES_INCOMPLETE"));
});

test("note selection uses the exact map key and validates both embedded identities", async () => {
  assert.equal(readStructuredNote(await fixture(), "cccccccccccccccccccccccc", authorId), null);
  assert.equal(readStructuredNote(await fixture(), noteId, "wrong-author"), null);
  assert.equal(readStructuredNote(page({ noteId: "different-note" }), noteId, authorId), null);
  assert.equal(readStructuredNote(page({ user: { userId: "other-author" } }), noteId, authorId), null);
  assert.equal(readStructuredNote(page({ user: undefined }), noteId, authorId), null);
});

test("absent or ambiguous timestamps are not inferred from the clock, title or note ID", () => {
  const raw = readStructuredNote(page({ title: "2026-10-20 额度" }), noteId, authorId)!;
  assert.equal(raw.sourcePublishedAt, null);
  assert.equal(raw.sourceUpdatedAt, null);
  for (const time of [1792458000, "2026-10-20", "今天", -1, null]) {
    assert.equal(readStructuredNote(page({ time }), noteId, authorId)!.sourcePublishedAt, null);
  }
});

test("expressions and additional script statements are rejected without execution", () => {
  const marker = "__nabaoStructuredReaderExecuted";
  assert.equal(Reflect.has(globalThis, marker), false);
  const expression = `(() => { globalThis.${marker} = true; return {}; })()`;
  assert.equal(readStructuredNote(
    `<script>window.__INITIAL_STATE__=${expression};</script>`, noteId, authorId,
  ), null);
  assert.equal(readStructuredNote(
    page().replace('"desc":"正文"', `"desc":${expression}`), noteId, authorId,
  ), null);
  assert.equal(readStructuredNote(
    page().replace("</script>", `globalThis.${marker} = true;</script>`), noteId, authorId,
  ), null);
  assert.equal(Reflect.has(globalThis, marker), false);
});

test("missing state, unsupported shapes and unsafe image URLs remain unavailable", () => {
  for (const html of ["<html><body>登录后查看</body></html>", "<script>window.__INITIAL_STATE__={invalid};</script>"]) {
    assert.equal(readStructuredNote(html, noteId, authorId), null);
  }
  assert.equal(readStructuredNote(page({ imageList: undefined }), noteId, authorId), null);
  const raw = readStructuredNote(page({ imageList: [
    { urlDefault: "javascript:alert(1)" }, null, { url: "https://images.example/third.jpg" },
  ] }), noteId, authorId)!;
  assert.equal(raw.expectedImageCount, 3);
  assert.deepEqual(raw.imageCandidates, [{ url: "https://images.example/third.jpg", ordinal: 2 }]);
});

test("structured data never overrides a restricted page or a different rendered author", () => {
  const raw = readStructuredNote(page(), noteId, authorId)!;
  const blocked = { ...raw, accessRestricted: true, restrictionReason: "ACCESS_CHALLENGE" };
  assert.equal(mergeNotePage(blocked, raw), blocked);
  const otherAuthor = { ...raw, authorIds: ["other-author"] };
  assert.equal(mergeNotePage(otherAuthor, raw), otherAuthor);
  assert.equal(mergeNotePage(raw, null), raw);
});

test("image count disagreements remain incomplete while explicit DOM timestamps can fill gaps", () => {
  const raw = readStructuredNote(page(), noteId, authorId)!;
  const dom = { ...raw, expectedImageCount: 2, sourcePublishedAt: "2026-10-20T01:00:00Z" };
  const merged = mergeNotePage(dom, raw);
  assert.equal(merged.expectedImageCount, null);
  assert.equal(merged.sourcePublishedAt, dom.sourcePublishedAt);
  assert.ok(captureIssues(merged, authorId, []).includes("IMAGE_COUNT_UNVERIFIED"));
});

test("an observed HTTPS rendering upgrades the exact static image without changing its position", () => {
  const raw = readStructuredNote(page({ imageList: [
    { urlDefault: "http://sns-webpic-qc.xhscdn.com/image.webp?format=webp" },
  ] }), noteId, authorId)!;
  const dom = { ...raw, imageCandidates: [
    { url: "https://sns-webpic-qc.xhscdn.com/image.webp?format=webp", ordinal: 0 },
    { url: "https://sns-webpic-qc.xhscdn.com/different.webp", ordinal: 1 },
  ] };
  const merged = mergeNotePage(dom, raw);
  assert.deepEqual(merged.imageCandidates, [dom.imageCandidates[0]]);
  assert.equal(merged.expectedImageCount, 1);
});

test("an explicit secure full-size variant is preferred over an insecure default or a preview", () => {
  const raw = readStructuredNote(page({ imageList: [{
    urlDefault: "http://test.xhscdn.com/default.webp",
    infoList: [
      { imageScene: "WB_PRV", url: "https://test.xhscdn.com/thumbnail.webp" },
      { imageScene: "WB_DFT", url: "https://test.xhscdn.com/full.webp" },
    ],
  }] }), noteId, authorId)!;
  assert.deepEqual(raw.imageCandidates, [{ url: "https://test.xhscdn.com/full.webp", ordinal: 0 }]);
});

test("rendered images fill missing structured slots only at their explicit original indices", () => {
  const raw = readStructuredNote(page({ imageList: [
    { urlDefault: "https://test.xhscdn.com/first.webp" },
    {},
    { urlDefault: "https://test.xhscdn.com/third.webp" },
  ] }), noteId, authorId)!;
  const second = { url: "https://test.xhscdn.com/second.webp", ordinal: 1 };
  const dom = { ...raw, imageCandidates: [
    { url: "https://test.xhscdn.com/unindexed.webp", ordinal: null },
    { url: "https://test.xhscdn.com/outside.webp", ordinal: 3 },
    second,
  ] };
  const merged = mergeNotePage(dom, raw);
  assert.equal(merged.expectedImageCount, 3);
  assert.deepEqual(merged.imageCandidates, [raw.imageCandidates[0], second, raw.imageCandidates[1]]);
  assert.deepEqual(mergeNotePage({ ...dom, imageCandidates: dom.imageCandidates.slice(0, 2) }, raw).imageCandidates,
    raw.imageCandidates, "unindexed or out-of-range images cannot repair a missing slot");
  assert.deepEqual(mergeNotePage({ ...dom, imageCandidates: [second,
    { url: "https://test.xhscdn.com/different.webp", ordinal: 1 },
  ] }, raw).imageCandidates, raw.imageCandidates, "conflicting rendered images cannot silently choose one slot");
  for (const uncertain of [
    { ...dom, authorIds: [] },
    { ...dom, authorIds: [authorId, "other-author"] },
    { ...dom, expectedImageCount: null },
    { ...dom, expectedImageCount: 4 },
    { ...dom, body: "另一篇笔记正文" },
    { ...dom, title: "另一篇标题" },
  ]) {
    assert.deepEqual(mergeNotePage(uncertain, raw).imageCandidates, raw.imageCandidates,
      "new images require matching author, content and an independently declared total");
  }
});
