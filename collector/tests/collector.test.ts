import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";
import { readNotePage, readProfilePage } from "../src/dom.js";
import { captureIssues, contentHash, discoverNotes, discoveryResult, imageCandidates, normalizedTimestamp } from "../src/rules.js";
import { extract } from "../src/extract.js";
import { validateObservations } from "../src/submit.js";
import type { ImageEvidence, NoteCapture, Observation } from "../src/types.js";

async function fixture(name: string): Promise<Document> {
  const html = await readFile(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf8");
  return parseHTML(html).document as unknown as Document;
}
function images(): ImageEvidence[] {
  return [0, 1].map((ordinal) => ({
    ordinal, sourceUrl: `https://test.xhscdn.com/${ordinal}?signature=first`, file: `${ordinal}.png`,
    sha256: `${ordinal}`.repeat(64), mediaType: "image/png", size: 1024,
  }));
}
test("profile discovery deduplicates note IDs, preserves access signatures, and caps the scan", async () => {
  const profile = readProfilePage(await fixture("profile.html"));
  const notes = discoverNotes(profile.links, 6);
  assert.equal(profile.noteCardCount, 2);
  assert.equal(notes.length, 2);
  assert.match(notes[0]!.url, /xsec_token=first/);
  assert.equal(notes[0]!.canonicalUrl, "https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(discoverNotes(profile.links, 1).length, 1);
  assert.deepEqual(discoverNotes(["https://malicious.example/explore/aaaaaaaaaaaaaaaaaaaaaaaa", "javascript:alert(1)"], 6), []);
});
test("visible cards with profile-only links do not count as discovered notes", async () => {
  const profile = readProfilePage(await fixture("profile-without-note-links.html"));
  assert.equal(profile.noteCardCount, 2);
  assert.equal(discoverNotes(profile.links, 6).length, 0);
  assert.equal(discoveryResult(profile, 6).status, "blocked");
  assert.equal(discoveryResult(profile, 6).issue, "NOTE_LINKS_UNAVAILABLE");
});
test("a partially readable profile is not reported as complete discovery", async () => {
  const profile = readProfilePage(await fixture("profile.html"));
  assert.equal(discoveryResult({ ...profile, noteCardCount: 6 }, 6).status, "partial");
  assert.equal(discoveryResult({ ...profile, noteCardCount: 6 }, 2).status, "success");
});
test("HTTP 200 login HTML and access challenges cannot be interpreted as a note", async () => {
  const raw = readNotePage(await fixture("login.html"));
  assert.equal(raw.accessRestricted, true);
  assert.equal(raw.restrictionReason, "LOGIN_WALL");
  assert.ok(captureIssues(raw, "6168030000000000020278b5", []).includes("NOTE_BODY_MISSING"));
  const challenge = parseHTML("<html><body>请完成安全验证，拖动滑块</body></html>").document;
  assert.equal(readProfilePage(challenge as unknown as Document).restrictionReason, "ACCESS_CHALLENGE");
});
test("a real IP-risk restriction is classified as an access challenge, not an empty profile", async () => {
  const doc = await fixture("ip-risk.html");
  const profile = readProfilePage(doc);
  assert.equal(profile.accessRestricted, true);
  assert.equal(profile.restrictionReason, "ACCESS_CHALLENGE");
  assert.deepEqual(discoveryResult(profile, 6), {
    status: "blocked", notes: [], issue: "ACCESS_CHALLENGE",
  });
  const note = readNotePage(doc);
  assert.equal(note.accessRestricted, true);
  assert.equal(note.restrictionReason, "ACCESS_CHALLENGE");
  assert.ok(captureIssues(note, "6168030000000000020278b5", []).includes("ACCESS_CHALLENGE"));
});
test("note extraction separates body from interactions and handles cloned carousel images", async () => {
  const raw = readNotePage(await fixture("note.html"));
  assert.equal(raw.expectedImageCount, 2);
  assert.equal(imageCandidates(raw).length, 2);
  assert.equal(raw.body.includes("评论"), false);
  assert.equal(raw.body.includes("点赞"), false);
  assert.equal(normalizedTimestamp(raw.sourcePublishedAt), "2026-10-20T01:00:00.000Z");
  assert.deepEqual(captureIssues(raw, "6168030000000000020278b5", images()), []);
});
test("missing images and absent publication metadata stay incomplete", async () => {
  const raw = readNotePage(await fixture("note.html"));
  assert.ok(captureIssues(raw, "6168030000000000020278b5", images().slice(0, 1)).includes("IMAGES_INCOMPLETE"));
  assert.ok(captureIssues(raw, "6168030000000000020278b5", images().map((image) => ({ ...image, ordinal: image.ordinal + 1 }))).includes("IMAGES_INCOMPLETE"));
  const noMetadata = { ...raw, sourcePublishedAt: null };
  assert.ok(captureIssues(noMetadata, "6168030000000000020278b5", images()).includes("PUBLICATION_TIME_UNVERIFIED"));
  assert.equal(normalizedTimestamp("2026-10-20"), null);
  assert.equal(normalizedTimestamp("今天 09:00"), null);
  assert.equal(normalizedTimestamp("2026-02-31T09:00:00+08:00"), null);
});
test("mounted slides without an independent total do not prove all images were read", async () => {
  const doc = await fixture("note.html");
  doc.querySelector(".swiper-pagination-fraction")?.remove();
  assert.equal(readNotePage(doc).expectedImageCount, null);
});
test("profile note routes retain the observed signed link over unsigned explore duplicates", () => {
  const id = "6ad72ff5000000002f02a03a";
  const signed = `https://www.xiaohongshu.com/user/profile/6168030000000000020278b5/${id}?xsec_token=public-test&xsec_source=pc_user`;
  const result = discoveryResult({
    links: [`https://www.xiaohongshu.com/explore/${id}`, signed,
      "https://www.xiaohongshu.com/user/profile/6168030000000000020278b5"],
    noteCardCount: 1, accessRestricted: false, restrictionReason: null,
  }, 1);
  assert.equal(result.status, "success");
  assert.equal(result.notes[0]?.url, signed);
  assert.equal(result.notes[0]?.canonicalUrl, `https://www.xiaohongshu.com/explore/${id}`);
});
test("content revisions ignore rotating URLs and file paths but detect text, image and order changes", () => {
  const original = images();
  const revisedURLs = original.map((image) => ({ ...image, sourceUrl: `${image.sourceUrl}&refresh=2`, file: `other/${image.file}` }));
  const first = contentHash("标题", "正文", original);
  assert.equal(first, contentHash("标题", "正文", revisedURLs));
  assert.notEqual(first, contentHash("标题", "已修改正文", original));
  assert.notEqual(first, contentHash("标题", "正文", original.map((image) => ({ ...image, sha256: "f".repeat(64) }))));
  assert.notEqual(first, contentHash("标题", "正文", original.map((image) => ({ ...image, ordinal: 1 - image.ordinal }))));
});
test("missing model configuration produces no candidate observations", async () => {
  const result = await extract({} as NoteCapture, ".", { apiKey: "", baseUrl: "", model: "" });
  assert.equal(result.status, "NOT_CONFIGURED");
  assert.deepEqual(result.rows, []);
});
const observation: Observation = {
  authorId: "6168030000000000020278b5", noteId: "aaaaaaaaaaaaaaaaaaaaaaaa", noteRevision: "e".repeat(64),
  fundCode: "000001", fundName: "测试基金", channelScope: "DISTRIBUTOR", businessType: "UNSPECIFIED",
  period: "UNSPECIFIED", limitKind: "LIMITED", amountMinor: 1000, currency: "CNY",
  observedForDate: "2026-10-20", sourcePublishedAt: "2026-10-20T09:00:00+08:00",
  sourceUpdatedAt: null, capturedAt: "2026-10-20T02:00:00Z",
  evidenceRef: "https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa",
};
test("explicit reviewed submission preserves unknown scope and refuses ambiguous amounts or dates", () => {
  assert.equal(validateObservations({ items: [observation] })[0]!.businessType, "UNSPECIFIED");
  assert.throws(() => validateObservations({ items: [{ ...observation, limitKind: "PAUSED", amountMinor: 0 }] }), /amountMinor/);
  assert.throws(() => validateObservations({ items: [{ ...observation, sourcePublishedAt: null }] }), /sourcePublishedAt/);
  assert.throws(() => validateObservations({ items: [{ ...observation, observedForDate: "2026-02-31" }] }), /observedForDate/);
  assert.throws(() => validateObservations({ items: [{ ...observation, fundCode: 1 }] }), /fundCode/);
});
