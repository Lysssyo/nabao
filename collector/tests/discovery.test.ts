import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseHTML } from "linkedom";
import { chromium } from "playwright";
import { readProfilePage } from "../src/dom.js";
import { compareCaptureRecency, discoveryResult } from "../src/rules.js";
import { scan } from "../src/scan.js";
import { sources } from "../src/sources.js";
import type { NoteCapture } from "../src/types.js";
import { addAuthor, removeAuthor } from "../src/author-store.js";

const oldId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const newId = "cccccccccccccccccccccccc";
const profileHTML = await readFile(new URL("../../tests/fixtures/profile-pinned-quota.html", import.meta.url), "utf8");

test("real profile structure: pinned old summary cannot hide a newer Nasdaq limit note", () => {
  const profile = readProfilePage(parseHTML(profileHTML).document as unknown as Document);
  assert.equal(profile.cards.length, 3);
  assert.equal(profile.cards[0]?.pinned, true);
  assert.match(profile.cards[2]!.title, /万家纳斯达克/);
  assert.equal(discoveryResult(profile, 1).notes[0]?.noteId, newId);
  const selected = discoveryResult(profile, 2);
  assert.equal(selected.status, "success");
  assert.deepEqual(selected.notes.map((note) => note.noteId), [newId, oldId]);
  assert.match(selected.notes[0]!.url, /xsec_token=fixture-new/);
  assert.equal(selected.notes[1]?.pinned, true);
});

test("captured recency uses verified publish/edit times, never the note ID or a title date", () => {
  const entry = (noteId: string, sourcePublishedAt: string | null, sourceUpdatedAt: string | null = null) => ({
    noteId, sourcePublishedAt, sourceUpdatedAt, title: "最新额度 10/22",
  } as NoteCapture);
  const unknown = entry("ffffffffffffffffffffffff", null);
  const old = entry("eeeeeeeeeeeeeeeeeeeeeeee", "2026-10-13T10:00:00+08:00");
  const current = entry("111111111111111111111111", "2026-10-21T09:00:00+08:00");
  const edited = entry("222222222222222222222222", "2026-10-13T10:00:00+08:00", "2026-10-21T11:00:00+08:00");
  assert.deepEqual([unknown, old, current, edited].sort(compareCaptureRecency), [edited, current, old, unknown]);
});

test("capture-only scans a newly added author with a stable lease and complete evidence without model/backend requests", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "nabao-capture-only-"));
  const source = { id: "eeeeeeeeeeeeeeeeeeeeeeee", name: "新采集作者", profileUrl: "https://www.xiaohongshu.com/user/profile/eeeeeeeeeeeeeeeeeeeeeeee" };
  await addAuthor(dataDirectory, { name: source.name, profileUrl: source.profileUrl });
  const originalFetch = globalThis.fetch;
  const originalInternalKey = process.env.NABAO_INTERNAL_KEY;
  const calls: string[] = [];
  process.env.NABAO_INTERNAL_KEY = "fixture-must-not-be-used";
  const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.hostname + url.pathname);
    if (url.hostname === "test.xhscdn.com") return new Response(imageBytes, { headers: { "content-type": "image/png" } });
    assert.equal(url.hostname, "www.xiaohongshu.com", "capture-only must not contact model/backend hosts");
    if (url.toString() === source.profileUrl) {
      await assert.rejects(removeAuthor(dataDirectory, source.id), /AUTHOR_CONFIG_BUSY/);
      return new Response(profileHTML, { headers: { "content-type": "text/html" } });
    }
    const id = url.pathname.split("/").at(-1)!;
    assert.ok([oldId, newId].includes(id));
    const day = id === newId ? "21" : "13";
    const html = `<!doctype html><html><head><meta property="article:published_time" content="2026-10-${day}T09:00:00+08:00"></head><body>
      <div class="note-container"><div class="author-container"><a href="/user/profile/${source.id}">作者</a></div>
      <div id="detail-title">纳斯达克限额</div><div id="detail-desc">10月${day}日纳指额度更新</div>
      <div class="media-container"><div class="swiper-pagination-fraction">1 / 2</div>
      <div class="swiper-slide" data-swiper-slide-index="0"><img src="https://test.xhscdn.com/${id}/0.png"></div>
      <div class="swiper-slide" data-swiper-slide-index="1"><img src="https://test.xhscdn.com/${id}/1.png"></div></div></div></body></html>`;
    return new Response(html, { headers: { "content-type": "text/html" } });
  };
  try {
    const options = { sourceId: source.id, maxNotes: 2, headless: true, dataDirectory, captureOnly: true };
    const result = await scan(options);
    assert.equal(result.status, "success");
    const report = JSON.parse(await readFile(result.reportFile, "utf8"));
    assert.equal(report.captureOnly, true);
    assert.deepEqual(report.results[0].processing, []);
    assert.deepEqual(report.results[0].notes.map((note: NoteCapture) => note.noteId), [newId, oldId]);
    assert.ok(report.results[0].notes.every((note: NoteCapture) => note.images.length === 2 && note.issues.length === 0 && note.revision));
    const state = JSON.parse(await readFile(join(dataDirectory, "state.json"), "utf8"));
    assert.deepEqual(Object.keys(state.notes).sort(), [oldId, newId]);
    assert.equal(state.notes[newId].publishedRevision, undefined);
    assert.equal((await scan(options)).status, "no-change");
    assert.equal(calls.length, 14, "only profile, two detail pages and their four images per scan");
    await removeAuthor(dataDirectory, source.id);
    await assert.rejects(scan(options), /Unknown source ID/);
    assert.equal(calls.length, 14, "removed authors are rejected before any request");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalInternalKey === undefined) delete process.env.NABAO_INTERNAL_KEY;
    else process.env.NABAO_INTERNAL_KEY = originalInternalKey;
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("capture-only completes mixed static and rendered image evidence without a browser retry", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "nabao-mixed-images-"));
  const source = sources[0]!;
  const originalFetch = globalThis.fetch;
  const originalProfile = process.env.NABAO_BROWSER_PROFILE;
  process.env.NABAO_BROWSER_PROFILE = "";
  const browser = t.mock.method(chromium, "launch", async () => { throw new Error("UNEXPECTED_BROWSER"); });
  const fetchedImages: string[] = [];
  const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const firstImage = "https://test.xhscdn.com/first.png";
  const secondImage = "https://test.xhscdn.com/second.png";
  const profile = `<html><body><div class="feeds-container"><section class="note-item">
    <a class="title" href="/explore/${newId}?xsec_token=fixture">纳指额度更新</a>
    </section></div></body></html>`;
  const note = { noteId: newId, user: { userId: source.id }, title: "纳指额度更新", desc: "10月21日纳指额度",
    time: Date.parse("2026-10-21T09:00:00+08:00"), imageList: [
      { urlDefault: "http://test.xhscdn.com/first.png", infoList: [{ imageScene: "WB_DFT", url: firstImage }] }, {},
    ] };
  const detail = `<html><body><div class="note-container">
    <div class="author-container"><a href="/user/profile/${source.id}">作者</a></div>
    <div id="detail-desc">10月21日纳指额度</div><div class="media-container">
      <div class="swiper-pagination-fraction">2 / 2</div>
      <div class="swiper-slide" data-swiper-slide-index="1"><img src="${secondImage}"></div>
    </div></div><script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: { [newId]: { note } } } })};</script>
    </body></html>`;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === source.profileUrl) return new Response(profile, { headers: { "content-type": "text/html" } });
    if (url === `https://www.xiaohongshu.com/explore/${newId}?xsec_token=fixture`) {
      return new Response(detail, { headers: { "content-type": "text/html" } });
    }
    assert.ok([firstImage, secondImage].includes(url), "only observed secure full-size images may be downloaded");
    fetchedImages.push(url);
    return new Response(imageBytes, { headers: { "content-type": "image/png" } });
  };
  try {
    const result = await scan({ sourceId: source.id, maxNotes: 1, headless: true, dataDirectory, captureOnly: true });
    assert.equal(result.status, "success");
    const report = JSON.parse(await readFile(result.reportFile, "utf8"));
    const captured = report.results[0].notes[0] as NoteCapture;
    assert.deepEqual(captured.images.map(({ ordinal, sourceUrl }) => ({ ordinal, sourceUrl })), [
      { ordinal: 0, sourceUrl: firstImage }, { ordinal: 1, sourceUrl: secondImage },
    ]);
    assert.deepEqual(captured.issues, []);
    assert.deepEqual(fetchedImages, [firstImage, secondImage]);
    assert.equal(browser.mock.callCount(), 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProfile === undefined) delete process.env.NABAO_BROWSER_PROFILE;
    else process.env.NABAO_BROWSER_PROFILE = originalProfile;
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
