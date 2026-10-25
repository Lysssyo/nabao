import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAuthorLease, addAuthor, loadAuthorConfig, parseAuthor, removeAuthor, withAuthorLease } from "../src/author-store.js";
import { sources } from "../src/sources.js";

const id = "aaaaaaaaaaaaaaaaaaaaaaaa";
const author = { name: " 新作者 ", profileUrl: `https://www.xiaohongshu.com/user/profile/${id}/?xsec_token=private-token#ignored` };
async function directory(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "nabao-authors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("author config migrates the default list once, canonicalizes additions and persists empty lists", async t => {
  const root = await directory(t), original = structuredClone(sources);
  assert.equal((await loadAuthorConfig(root)).revision, 1);
  const added = await addAuthor(root, author);
  assert.equal(added.revision, 2); assert.equal(added.authors.length, 6);
  assert.deepEqual(added.authors.at(-1), { id, name: "新作者", profileUrl: `https://www.xiaohongshu.com/user/profile/${id}` });
  assert.equal((await stat(join(root, "author-config.json"))).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(join(root, "author-config.json"), "utf8"), /private-token|ignored/);
  assert.throws(() => { added.authors.pop(); }, TypeError);
  assert.throws(() => { added.authors[0]!.name = "changed"; }, TypeError);
  for (const source of added.authors) await removeAuthor(root, source.id);
  assert.deepEqual((await loadAuthorConfig(root)).authors, []);
  assert.equal((await loadAuthorConfig(root)).revision, 8);
  assert.deepEqual(sources, original);
});

test("profile validation rejects credentials, alternate hosts, short links and malformed identities without fetching", () => {
  const forbidden = ["http://www.xiaohongshu.com", "https://xiaohongshu.com", "https://evil.test", "https://www.xiaohongshu.com.evil.test",
    "https://user:password@www.xiaohongshu.com", "https://www.xiaohongshu.com:443", "https://www.xiaohongshu.com:0443", "https://www.xiaohongshu.com:444"];
  for (const base of forbidden) assert.throws(() => parseAuthor({ ...author, profileUrl: `${base}/user/profile/${id}` }), /AUTHOR_INVALID/);
  for (const url of ["https://xhslink.cn/o/test", `https://www.xiaohongshu.com/user/profile/${id}/posts`,
    `https://www.xiaohongshu.com/user/profile/${id.slice(1)}`, `https://www.xiaohongshu.com/user/profile/%61${id.slice(1)}`])
    assert.throws(() => parseAuthor({ ...author, profileUrl: url }), /AUTHOR_INVALID/);
  for (const name of [" ", "x".repeat(81), "name\nprivate"]) assert.throws(() => parseAuthor({ ...author, name }), /AUTHOR_INVALID/);
  assert.throws(() => parseAuthor({ ...author, command: "ignored?" }), /AUTHOR_INVALID/);
});

test("duplicate, missing and over-limit author mutations leave the committed revision intact", async t => {
  const root = await directory(t);
  await addAuthor(root, author);
  await assert.rejects(addAuthor(root, author), /AUTHOR_DUPLICATE/);
  await assert.rejects(removeAuthor(root, "bbbbbbbbbbbbbbbbbbbbbbbb"), /AUTHOR_NOT_FOUND/);
  assert.equal((await loadAuthorConfig(root)).revision, 2);
  const config = await loadAuthorConfig(root);
  const many = Array.from({ length: 50 }, (_, index) => ({ id: index.toString(16).padStart(24, "0"), name: `作者${index}`,
    profileUrl: `https://www.xiaohongshu.com/user/profile/${index.toString(16).padStart(24, "0")}` }));
  await writeFile(join(root, "author-config.json"), JSON.stringify({ ...config, authors: many }));
  await assert.rejects(addAuthor(root, author), /AUTHOR_LIMIT/);
  assert.equal((await loadAuthorConfig(root)).revision, 2);
});

test("run leases block edits and second runs while allowing immutable snapshots and read-only status", async t => {
  const root = await directory(t);
  const lease = await acquireAuthorLease(root);
  try {
    await assert.rejects(addAuthor(root, author), /AUTHOR_CONFIG_BUSY/);
    await assert.rejects(removeAuthor(root, sources[0]!.id), /AUTHOR_CONFIG_BUSY/);
    await assert.rejects(acquireAuthorLease(root), /AUTHOR_CONFIG_BUSY/);
    assert.equal((await loadAuthorConfig(root)).authors.length, 5);
    assert.equal(await withAuthorLease(root, async current => current === lease, lease), true);
    await assert.rejects(withAuthorLease(join(root, "other"), async () => undefined, lease), /AUTHOR_CONFIG_INVALID/);
  } finally { await lease.release(); }
  await assert.rejects(withAuthorLease(root, async () => undefined, lease), /AUTHOR_CONFIG_INVALID/);
  assert.equal((await addAuthor(root, author)).authors.length, 6);
});

test("corrupt author config is preserved and cannot silently restore default authors", async t => {
  const root = await directory(t), file = join(root, "author-config.json");
  await writeFile(file, "{corrupt-private-value");
  await assert.rejects(loadAuthorConfig(root), /^Error: AUTHOR_CONFIG_INVALID$/);
  await assert.rejects(addAuthor(root, author), /^Error: AUTHOR_CONFIG_INVALID$/);
  assert.equal(await readFile(file, "utf8"), "{corrupt-private-value");
});
