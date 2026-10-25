import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollectorControl, type ControlOptions } from "../src/collector-control.js";
import { authenticatedEvidence, commitLoginProfile, type LoginBrowser } from "../src/control-login.js";
import { ControlError } from "../src/control-types.js";
import { acquireProcessLock } from "../src/process-lock.js";
import { controlServer } from "../src/control-server.js";
import { acquireAuthorLease, loadAuthorConfig } from "../src/author-store.js";

const result = (status = "no_new_post") => ({ lastAttempt: new Date().toISOString(), lastSuccess: null,
  dataDate: "2026-10-23", status, errorCode: null });
async function setup(overrides: Partial<ControlOptions> = {}, deps: ConstructorParameters<typeof CollectorControl>[1] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "nabao-control-"));
  const control = new CollectorControl({ dataDirectory: directory, outputDirectory: join(directory, "public"),
    scheduleEnabled: false, intervalMinutes: 360, headless: true, ...overrides }, deps);
  await control.start();
  return { directory, control, async cleanup() { await control.stop(); await rm(directory, { recursive: true, force: true }); } };
}
function browser(verified = false) {
  const calls = { saves: 0, closes: 0 };
  const implementation: LoginBrowser = { prepare: async () => "qr_ready", verify: async () => verified ? "authenticated" : "login_required",
    save: async () => { calls.saves++; }, preview: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    close: async () => { calls.closes++; } };
  return { calls, implementation };
}

test("manual run starts once, rejects concurrent work and preserves no-new-post result", async () => {
  let finish!: () => void;
  let runs = 0;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const fixture = await setup({}, { run: async () => { runs++; await gate; return result(); } });
  try {
    const state = await fixture.control.startRun();
    assert.equal(state.busy, true); assert.equal(state.run?.status, "running");
    await assert.rejects(fixture.control.startRun(), (error: unknown) => error instanceof ControlError && error.status === 409);
    assert.throws(() => fixture.control.startLogin(), ControlError);
    assert.throws(() => fixture.control.checkSession(), ControlError);
    await assert.rejects(fixture.control.removeAuthor(state.sources[0]!.id), (error: unknown) => error instanceof ControlError && error.status === 409);
    finish(); await fixture.control.settled();
    assert.equal(runs, 1); assert.equal(fixture.control.status().run?.status, "completed");
    assert.match(fixture.control.status().run?.message ?? "", /未发现当日新表/);
    assert.equal(fixture.control.status().busy, false);
    const saved = JSON.parse(await readFile(join(fixture.directory, "control/status.json"), "utf8"));
    assert.equal(saved.run.result, "no_new_post");
  } finally { finish(); await fixture.cleanup(); }
});

test("author CRUD persists across restart, allows an empty list and resumes scheduling only at two authors", async () => {
  const fixture = await setup({ scheduleEnabled: true }, { run: async () => result() });
  let restored: CollectorControl | undefined;
  try {
    const initial = fixture.control.status();
    initial.sources[0]!.name = "outside mutation";
    assert.notEqual(fixture.control.status().sources[0]!.name, "outside mutation");
    for (const source of initial.sources) await fixture.control.removeAuthor(source.id);
    assert.deepEqual(fixture.control.status().sources, []);
    assert.equal(fixture.control.status().schedule.enabled, false); assert.equal(fixture.control.status().schedule.nextRunAt, null);
    await assert.rejects(fixture.control.startRun(), (error: unknown) => error instanceof ControlError && error.status === 409);
    const first = { name: "作者一", profileUrl: "https://www.xiaohongshu.com/user/profile/aaaaaaaaaaaaaaaaaaaaaaaa?xsec_token=private" };
    await fixture.control.addAuthor(first);
    assert.equal(fixture.control.status().schedule.enabled, false);
    await assert.rejects(fixture.control.startRun(), (error: unknown) => error instanceof ControlError && error.status === 409);
    await fixture.control.addAuthor({ name: "作者二", profileUrl: "https://www.xiaohongshu.com/user/profile/bbbbbbbbbbbbbbbbbbbbbbbb" });
    assert.equal(fixture.control.status().schedule.enabled, true); assert.ok(fixture.control.status().schedule.nextRunAt);
    const expected = fixture.control.status().sources;
    await fixture.control.stop();
    restored = new CollectorControl({ dataDirectory: fixture.directory, outputDirectory: join(fixture.directory, "public"),
      scheduleEnabled: true, intervalMinutes: 360, headless: true });
    await restored.start();
    assert.deepEqual(restored.status().sources, expected);
    assert.equal(restored.status().sources.some(source => source.profileUrl.includes("private")), false);
  } finally { await restored?.stop(); await fixture.cleanup(); }
});

test("an external collection lease blocks author edits and manual runs without creating a run", async () => {
  const fixture = await setup();
  const lease = await acquireAuthorLease(fixture.directory);
  try {
    await assert.rejects(fixture.control.removeAuthor(fixture.control.status().sources[0]!.id), (error: unknown) => error instanceof ControlError && error.status === 409);
    await assert.rejects(fixture.control.startRun(), (error: unknown) => error instanceof ControlError && error.status === 409);
    assert.equal(fixture.control.status().run, null); assert.equal(fixture.control.status().busy, false);
    assert.equal((await loadAuthorConfig(fixture.directory)).authors.length, 5);
  } finally { await lease.release(); await fixture.cleanup(); }
});

test("author routes authenticate, validate canonical profiles and return complete status with stable errors", async () => {
  const fixture = await setup();
  const key = "test-control-key-at-least-16", server = controlServer(fixture.control, key);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`, headers = { "X-Internal-Key": key, "Content-Type": "application/json" };
  const id = "aaaaaaaaaaaaaaaaaaaaaaaa", payload = { name: "新作者", profileUrl: `https://www.xiaohongshu.com/user/profile/${id}?token=private` };
  try {
    for (const [path, method] of [["/authors", "POST"], [`/authors/${id}`, "DELETE"]])
      assert.equal((await fetch(base + path, { method })).status, 401);
    assert.equal((await fetch(base + "/authors", { method: "POST", headers, body: "{" })).status, 400);
    const invalid = await fetch(base + "/authors", { method: "POST", headers, body: JSON.stringify({ ...payload, profileUrl: "https://secret.evil/profile" }) });
    assert.equal(invalid.status, 400); assert.doesNotMatch(await invalid.text(), /secret/);
    const added = await fetch(base + "/authors", { method: "POST", headers, body: JSON.stringify(payload) });
    assert.equal(added.status, 200);
    const status = await added.json() as { sources: { id: string; profileUrl: string }[]; login: unknown };
    assert.equal(status.sources.length, 6); assert.ok(status.login);
    assert.equal(status.sources.at(-1)?.profileUrl, `https://www.xiaohongshu.com/user/profile/${id}`);
    assert.equal((await fetch(base + "/authors", { method: "POST", headers, body: JSON.stringify(payload) })).status, 409);
    assert.equal((await fetch(base + `/authors/${id}`, { method: "DELETE", headers })).status, 200);
    assert.equal((await fetch(base + `/authors/${id}`, { method: "DELETE", headers })).status, 404);
    assert.equal((await fetch(base + "/authors/invalid", { method: "DELETE", headers })).status, 400);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await fixture.cleanup(); }
});

test("failed task hides exception details and can be run again", async () => {
  const fixture = await setup({}, { run: async () => { throw new Error("SECRET-cookie-credential"); } });
  try {
    await fixture.control.startRun(); await fixture.control.settled();
    assert.equal(fixture.control.status().run?.status, "failed");
    assert.doesNotMatch(JSON.stringify(fixture.control.status()), /SECRET/);
    await fixture.control.startRun(); await fixture.control.settled();
  } finally { await fixture.cleanup(); }
});

test("login requires positive live evidence, never just a saved cookie file", async () => {
  const fake = browser(false);
  const fixture = await setup({}, { browser: async () => fake.implementation });
  try {
    fixture.control.startLogin(); await fixture.control.settled();
    assert.equal(fixture.control.status().login.status, "waiting");
    await assert.rejects(fixture.control.completeLogin(), (error: unknown) => error instanceof ControlError && error.status === 409);
    assert.equal(fake.calls.saves, 0);
    assert.equal(fixture.control.status().session.status, "unchecked");
    assert.equal((await fixture.control.preview()).subarray(1, 4).toString(), "PNG");
    await assert.rejects(acquireProcessLock(join(fixture.directory, "scan.lock"), "SCAN_BUSY"), /SCAN_BUSY/);
    await fixture.control.cancelLogin(); assert.equal(fake.calls.closes, 1);
    const lock = await acquireProcessLock(join(fixture.directory, "scan.lock"), "SCAN_BUSY"); await lock.release();
  } finally { await fixture.cleanup(); }
});

test("verified login saves privately then closes browser and clears preview", async () => {
  const fake = browser(true);
  const fixture = await setup({}, { browser: async () => fake.implementation });
  try {
    fixture.control.startLogin(); await fixture.control.settled();
    const state = await fixture.control.completeLogin();
    assert.equal(state.session.status, "authenticated"); assert.equal(state.login.previewAvailable, false);
    assert.equal(state.busy, false); assert.equal(fake.calls.saves, 1); assert.equal(fake.calls.closes, 1);
    await assert.rejects(fixture.control.preview(), ControlError);
  } finally { await fixture.cleanup(); }
});

test("an already authenticated dedicated session completes without asking the user to scan again", async () => {
  const fake = browser(true);
  const fixture = await setup({}, { browser: async () => ({ ...fake.implementation, prepare: async () => "authenticated" }) });
  try {
    fixture.control.startLogin(); await fixture.control.settled();
    const state = fixture.control.status();
    assert.equal(state.login.status, "authenticated"); assert.equal(state.session.status, "authenticated");
    assert.equal(state.busy, false); assert.equal(state.login.previewAvailable, false); assert.equal(state.login.expiresAt, null);
    assert.equal(fake.calls.saves, 1); assert.equal(fake.calls.closes, 1);
    await assert.rejects(fixture.control.completeLogin(), ControlError);
    const lock = await acquireProcessLock(join(fixture.directory, "scan.lock"), "SCAN_BUSY"); await lock.release();
  } finally { await fixture.cleanup(); }
});

test("a failed save of an existing authenticated session never reports login success", async () => {
  const fake = browser(true);
  const fixture = await setup({}, { browser: async () => ({ ...fake.implementation, prepare: async () => "authenticated",
    save: async () => { throw new Error("SECRET-profile-write-failure"); } }) });
  try {
    fixture.control.startLogin(); await fixture.control.settled();
    assert.equal(fixture.control.status().login.status, "failed");
    assert.equal(fixture.control.status().session.status, "unchecked");
    assert.equal(fixture.control.status().busy, false); assert.equal(fake.calls.closes, 1);
    assert.doesNotMatch(JSON.stringify(fixture.control.status()), /SECRET/);
  } finally { await fixture.cleanup(); }
});

test("session check is asynchronous, verified and mutually exclusive with collection", async () => {
  const fake = browser(false);
  const fixture = await setup({}, { browser: async () => fake.implementation });
  try {
    assert.equal(fixture.control.checkSession().session.status, "checking");
    await assert.rejects(fixture.control.startRun(), ControlError);
    await fixture.control.settled();
    assert.equal(fixture.control.status().session.status, "expired"); assert.equal(fake.calls.saves, 0);
    assert.equal(fixture.control.status().busy, false);
  } finally { await fixture.cleanup(); }
});

test("an external CLI scan blocks login and the second control daemon", async () => {
  const fake = browser(true);
  const fixture = await setup({}, { browser: async () => fake.implementation });
  const lock = await acquireProcessLock(join(fixture.directory, "scan.lock"), "SCAN_BUSY");
  try {
    fixture.control.startLogin(); await fixture.control.settled();
    assert.equal(fixture.control.status().login.status, "failed"); assert.equal(fake.calls.closes, 0);
    const duplicate = new CollectorControl({ dataDirectory: fixture.directory, outputDirectory: "unused", scheduleEnabled: false, intervalMinutes: 360, headless: true });
    await assert.rejects(duplicate.start(), /CONTROL_BUSY/);
  } finally { await lock.release(); await fixture.cleanup(); }
});

test("restart reports running task as interrupted and never trusts prior authenticated status", async () => {
  const fixture = await setup();
  await fixture.control.stop();
  await writeFile(join(fixture.directory, "control/status.json"), JSON.stringify({
    run: { id: "e518f119-e9aa-44b2-9c5c-7dd72a97c99b", trigger: "manual", status: "running", startedAt: new Date().toISOString() },
    session: { status: "authenticated" },
  }));
  try {
    await fixture.control.start();
    assert.equal(fixture.control.status().run?.status, "interrupted");
    assert.equal(fixture.control.status().session.status, "unchecked");
  } finally { await fixture.cleanup(); }
});

test("schedule has a future interval and never runs immediately on start", async () => {
  let calls = 0;
  const fixture = await setup({ scheduleEnabled: true }, { run: async () => { calls++; return result(); } });
  try {
    const schedule = fixture.control.status().schedule;
    assert.equal(schedule.enabled, true); assert.equal(schedule.intervalMinutes, 360);
    assert.ok(Date.parse(schedule.nextRunAt!) - Date.now() > 359 * 60_000);
    assert.equal(calls, 0);
  } finally { await fixture.cleanup(); }
});

test("authentication evidence rejects guests, unrelated profiles and login overlays", () => {
  const valid = { loggedIn: true, guest: false, userId: "123456789012345678901234", ownProfileVisible: true, loginVisible: false };
  assert.equal(authenticatedEvidence(valid), true);
  for (const change of [{ loggedIn: false }, { guest: true }, { guest: undefined }, { ownProfileVisible: false }, { loginVisible: true }, { userId: "" }])
    assert.equal(authenticatedEvidence({ ...valid, ...change }), false);
  assert.equal(authenticatedEvidence({ cookies: ["web_session"] }), false);
});

test("HTTP control authenticates every route, forbids parameters and suppresses secrets", async () => {
  const fixture = await setup({}, { run: async () => result() });
  const key = "test-control-key-at-least-16";
  const server = controlServer(fixture.control, key);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "X-Internal-Key": key };
  try {
    for (const path of ["/status", "/login/preview", "/runs"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 401); assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
    const status = await fetch(base + "/status", { headers });
    assert.equal(status.status, 200); assert.equal((await status.json() as { sources: unknown[] }).sources.length, 5);
    const malicious = await fetch(base + "/runs", { method: "POST", headers, body: JSON.stringify({ command: "secret;rm -rf /" }) });
    assert.equal(malicious.status, 400); assert.doesNotMatch(await malicious.text(), /secret/);
    const started = await fetch(base + "/runs", { method: "POST", headers }); assert.equal(started.status, 202);
    await fixture.control.settled();
    const unknown = await fetch(base + "/status?path=secret", { headers }); assert.equal(unknown.status, 404);
    const preview = await fetch(base + "/login/preview", { headers }); assert.equal(preview.status, 409);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await fixture.cleanup(); }
});

test("profile promotion commits only a verified stage and restores old profile on failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nabao-login-commit-"));
  const target = join(directory, "current");
  const staged = join(directory, "staged");
  await mkdir(target); await mkdir(staged);
  await writeFile(join(target, "session"), "old-private-session");
  await writeFile(join(staged, "session"), "verified-new-session");
  try {
    await assert.rejects(commitLoginProfile(join(directory, "missing-stage"), target));
    assert.equal(await readFile(join(target, "session"), "utf8"), "old-private-session");
    await commitLoginProfile(staged, target);
    assert.equal(await readFile(join(target, "session"), "utf8"), "verified-new-session");
    assert.deepEqual(await readdir(directory), ["current"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("concurrent cancel never releases the scan lock until browser close completes", async () => {
  let finishClose!: () => void;
  const gate = new Promise<void>((resolve) => { finishClose = resolve; });
  const fake = browser(false);
  const closing = { ...fake.implementation, close: async () => { fake.calls.closes++; await gate; } };
  const fixture = await setup({}, { browser: async () => closing });
  try {
    fixture.control.startLogin(); await fixture.control.settled();
    const cancelling = fixture.control.cancelLogin();
    await assert.rejects(fixture.control.cancelLogin(), ControlError);
    await assert.rejects(fixture.control.startRun(), ControlError);
    await assert.rejects(acquireProcessLock(join(fixture.directory, "scan.lock"), "SCAN_BUSY"), /SCAN_BUSY/);
    finishClose(); await cancelling;
    assert.equal(fake.calls.closes, 1); assert.equal(fixture.control.status().busy, false);
    const lock = await acquireProcessLock(join(fixture.directory, "scan.lock"), "SCAN_BUSY"); await lock.release();
  } finally { finishClose(); await fixture.cleanup(); }
});

test("login and session checking use separate browser modes", async () => {
  const modes: string[] = [];
  const fake = browser(false);
  const fixture = await setup({}, { browser: async (mode) => { modes.push(mode); return fake.implementation; } });
  try {
    fixture.control.startLogin(); await fixture.control.settled(); await fixture.control.cancelLogin();
    fixture.control.checkSession(); await fixture.control.settled();
    assert.deepEqual(modes, ["login", "check"]);
  } finally { await fixture.cleanup(); }
});

test("failed exported-state promotion rolls back an already promoted login profile", async () => {
  const { commitLoginSession } = await import("../src/control-login.js");
  const { rename } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "nabao-login-rollback-"));
  const target = join(directory, "current"), staged = join(directory, "staged"), session = join(directory, "session.json");
  await mkdir(target); await mkdir(staged);
  await writeFile(join(target, "session"), "old-profile"); await writeFile(join(staged, "session"), "new-profile");
  await writeFile(session, "old-export");
  try {
    await assert.rejects(commitLoginSession(staged, target, session, "new-export", async (from, to) => {
      if (to === session && String(from).endsWith(".tmp")) throw new Error("simulated export promotion failure");
      await rename(from, to);
    }));
    assert.equal(await readFile(join(target, "session"), "utf8"), "old-profile");
    assert.equal(await readFile(session, "utf8"), "old-export");
    assert.deepEqual((await readdir(directory)).sort(), ["current", "session.json"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("expired login with a failed browser close stays safely busy without unhandled rejection", async () => {
  const fake = browser(false);
  const fixture = await setup({ loginTimeoutMs: 5 }, { browser: async () => ({ ...fake.implementation,
    close: async () => { throw new Error("SECRET-close-error"); } }) });
  try {
    fixture.control.startLogin(); await fixture.control.settled();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(fixture.control.status().login.status, "failed");
    assert.equal(fixture.control.status().busy, true);
    assert.doesNotMatch(JSON.stringify(fixture.control.status()), /SECRET/);
    await assert.rejects(fixture.control.startRun(), ControlError);
    await assert.rejects(acquireProcessLock(join(fixture.directory, "scan.lock"), "SCAN_BUSY"), /SCAN_BUSY/);
  } finally { await fixture.control.stop().catch(() => undefined); await rm(fixture.directory, { recursive: true, force: true }); }
});

test("actual 300012 risk page is restricted, not logged out or QR-ready", async () => {
  const { classifyLoginPage } = await import("../src/control-login.js");
  const page = { origin: "https://www.xiaohongshu.com", text: "安全限制 300012 IP存在风险，请切换可靠网络环境后重试",
    loginVisible: false, qrVisible: false, challengeVisible: false, ownProfileVisible: false };
  assert.equal(classifyLoginPage(page), "restricted");
  // Even stale logged-in evidence or an obscured QR cannot override the live restriction page.
  assert.equal(classifyLoginPage({ ...page, loggedIn: true, guest: false, userId: "123456789012345678901234", ownProfileVisible: true }), "restricted");
  assert.equal(classifyLoginPage({ ...page, text: "登录小红书", loginVisible: true }), "login_required");
  assert.equal(classifyLoginPage({ ...page, text: "扫码登录", loginVisible: true, qrVisible: true }), "qr_ready");
  assert.equal(classifyLoginPage({ ...page, text: "正在加载" }), "unavailable");
  assert.equal(classifyLoginPage({ ...page, text: "请完成验证", challengeVisible: true }), "restricted");
});

test("restricted login closes staging browser, pauses schedule and retains only the authenticated PNG preview", async () => {
  const fake = browser(false);
  const fixture = await setup({ scheduleEnabled: true }, { browser: async () => ({ ...fake.implementation, prepare: async () => "restricted" }) });
  try {
    fixture.control.startLogin(); await fixture.control.settled();
    const status = fixture.control.status();
    assert.equal(status.login.status, "restricted"); assert.equal(status.session.status, "restricted");
    assert.equal(status.busy, false); assert.equal(status.schedule.enabled, false); assert.equal(status.schedule.nextRunAt, null);
    assert.match(status.login.message, /访问受限/); assert.match(status.login.message, /未生成可用登录二维码/);
    assert.equal(status.login.previewAvailable, true); assert.equal(fake.calls.closes, 1); assert.equal(fake.calls.saves, 0);
    assert.equal((await fixture.control.preview()).subarray(1, 4).toString(), "PNG");
    await assert.rejects(fixture.control.completeLogin(), ControlError);
    const lock = await acquireProcessLock(join(fixture.directory, "scan.lock"), "SCAN_BUSY"); await lock.release();
  } finally { await fixture.cleanup(); }
});

test("session checks distinguish risk blocks and unavailable pages from an explicit login wall", async () => {
  for (const [pageState, expected] of [["restricted", "restricted"], ["unavailable", "failed"], ["login_required", "expired"]] as const) {
    const fake = browser(false);
    const fixture = await setup({}, { browser: async () => ({ ...fake.implementation, verify: async () => pageState }) });
    try {
      fixture.control.checkSession(); await fixture.control.settled();
      assert.equal(fixture.control.status().session.status, expected);
      assert.equal(fixture.control.status().busy, false); assert.equal(fake.calls.saves, 0);
    } finally { await fixture.cleanup(); }
  }
});

test("a login page with no rendered QR never reports waiting to scan", async () => {
  const fake = browser(false);
  const fixture = await setup({}, { browser: async () => ({ ...fake.implementation, prepare: async () => "login_required" }) });
  try {
    fixture.control.startLogin(); await fixture.control.settled();
    assert.equal(fixture.control.status().login.status, "failed");
    assert.equal(fixture.control.status().login.previewAvailable, false); assert.equal(fixture.control.status().busy, false);
  } finally { await fixture.cleanup(); }
});

test("a visible browser stays open for manual login without claiming that a QR or authenticated account exists", async () => {
  for (const pageState of ["login_required", "unavailable"] as const) {
    const fake = browser(false);
    const fixture = await setup({ headless: true, loginHeadless: false }, { browser: async () => ({ ...fake.implementation,
      prepare: async () => pageState, verify: async () => pageState }) });
    try {
      fixture.control.startLogin(); await fixture.control.settled();
      let state = fixture.control.status();
      assert.equal(state.login.status, "waiting_browser"); assert.equal(state.busy, true);
      assert.equal(state.session.status, "unchecked"); assert.equal(state.login.previewAvailable, true);
      assert.ok(Date.parse(state.login.expiresAt!) > Date.now());
      assert.equal(fake.calls.closes, 0); assert.equal(fake.calls.saves, 0);
      assert.match(state.login.message, /专用浏览器/); assert.match(state.login.message, /尚未识别/);
      assert.equal((await fixture.control.preview()).subarray(1, 4).toString(), "PNG");
      await assert.rejects(fixture.control.completeLogin(), error => error instanceof ControlError && error.status === 409);
      assert.equal(fixture.control.status().login.status, "waiting_browser"); assert.equal(fake.calls.saves, 0);
      await assert.rejects(fixture.control.startRun(), ControlError);
      await assert.rejects(acquireProcessLock(join(fixture.directory, "scan.lock"), "SCAN_BUSY"), /SCAN_BUSY/);
      await fixture.control.cancelLogin(); state = fixture.control.status();
      assert.equal(state.login.status, "cancelled"); assert.equal(state.busy, false); assert.equal(fake.calls.closes, 1);
    } finally { await fixture.cleanup(); }
  }
});

test("manual-browser fallback follows the effective login headless option", async () => {
  for (const options of [{ headless: false }, { headless: false, loginHeadless: true }, { headless: true }]) {
    const fake = browser(false);
    const fixture = await setup(options, { browser: async () => ({ ...fake.implementation, prepare: async () => "unavailable" }) });
    try {
      fixture.control.startLogin(); await fixture.control.settled();
      const manual = !(options.loginHeadless ?? options.headless);
      assert.equal(fixture.control.status().login.status, manual ? "waiting_browser" : "failed");
      assert.equal(fixture.control.status().busy, manual);
      if (manual) await fixture.control.cancelLogin();
    } finally { await fixture.cleanup(); }
  }
});

test("manual-browser confirmation resumes a restricted schedule only after positive authentication", async () => {
  const fake = browser(false);
  let first = true, verified = false;
  const fixture = await setup({ scheduleEnabled: true, headless: false }, { browser: async () => ({ ...fake.implementation,
    prepare: async () => first ? "restricted" : "unavailable", verify: async () => verified ? "authenticated" : "unavailable" }) });
  try {
    fixture.control.startLogin(); await fixture.control.settled();
    assert.equal(fixture.control.status().login.status, "restricted");
    assert.equal(fixture.control.status().schedule.enabled, false); assert.equal(fake.calls.closes, 1);
    first = false;
    fixture.control.startLogin(); await fixture.control.settled();
    assert.equal(fixture.control.status().login.status, "waiting_browser");
    assert.equal(fixture.control.status().schedule.enabled, false); assert.equal(fixture.control.status().schedule.nextRunAt, null);
    await assert.rejects(fixture.control.completeLogin(), ControlError);
    assert.equal(fake.calls.saves, 0); assert.equal(fixture.control.status().schedule.enabled, false);
    verified = true; const result = await fixture.control.completeLogin();
    assert.equal(result.login.status, "authenticated"); assert.equal(result.session.status, "authenticated");
    assert.equal(result.busy, false); assert.equal(result.schedule.enabled, true);
    assert.equal(fake.calls.saves, 1); assert.equal(fake.calls.closes, 2);
  } finally { await fixture.cleanup(); }
});

test("manual-browser login expires and releases its dedicated browser lock", async () => {
  const fake = browser(false);
  const fixture = await setup({ headless: false, loginTimeoutMs: 10 }, { browser: async () => ({ ...fake.implementation,
    prepare: async () => "unavailable" }) });
  try {
    fixture.control.startLogin(); await fixture.control.settled();
    assert.equal(fixture.control.status().login.status, "waiting_browser");
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(fixture.control.status().login.status, "expired"); assert.equal(fixture.control.status().busy, false);
    assert.equal(fake.calls.closes, 1); assert.equal(fake.calls.saves, 0);
    const lock = await acquireProcessLock(join(fixture.directory, "scan.lock"), "SCAN_BUSY"); await lock.release();
  } finally { await fixture.cleanup(); }
});

test("manual-browser confirmation accepts positive evidence that appears during the bounded DOM wait", async () => {
  const fake = browser(false);
  let ready = false;
  const fixture = await setup({ headless: false }, { browser: async () => ({ ...fake.implementation,
    prepare: async () => ready ? "authenticated" : "unavailable", verify: async () => "unavailable" }) });
  try {
    fixture.control.startLogin(); await fixture.control.settled();
    assert.equal(fixture.control.status().login.status, "waiting_browser");
    ready = true;
    const status = await fixture.control.completeLogin();
    assert.equal(status.session.status, "authenticated"); assert.equal(status.login.status, "authenticated");
    assert.equal(fake.calls.saves, 1); assert.equal(fake.calls.closes, 1);
  } finally { await fixture.cleanup(); }
});

test("risk encountered when confirming login never saves the session", async () => {
  const fake = browser(false);
  const fixture = await setup({}, { browser: async () => ({ ...fake.implementation, verify: async () => "restricted" }) });
  try {
    fixture.control.startLogin(); await fixture.control.settled();
    const result = await fixture.control.completeLogin();
    assert.equal(result.login.status, "restricted"); assert.equal(result.busy, false); assert.equal(fake.calls.saves, 0);
  } finally { await fixture.cleanup(); }
});

test("a later explicit successful session check clears restriction and resumes configured schedule", async () => {
  const fake = browser(true);
  const fixture = await setup({ scheduleEnabled: true }, { browser: async (mode) => ({ ...fake.implementation,
    prepare: async () => mode === "login" ? "restricted" : "authenticated" }) });
  try {
    fixture.control.startLogin(); await fixture.control.settled();
    assert.equal(fixture.control.status().schedule.enabled, false);
    fixture.control.checkSession(); await fixture.control.settled();
    assert.equal(fixture.control.status().session.status, "authenticated");
    assert.equal(fixture.control.status().login.status, "idle");
    assert.equal(fixture.control.status().schedule.enabled, true);
    await assert.rejects(fixture.control.preview(), ControlError);
  } finally { await fixture.cleanup(); }
});

test("a failed or unavailable check preserves an earlier restriction and paused schedule", async () => {
  for (const fails of [false, true]) {
    const fake = browser(false);
    const fixture = await setup({ scheduleEnabled: true }, { browser: async () => ({ ...fake.implementation,
      prepare: async () => "restricted", verify: async () => {
        if (fails) throw new Error("SECRET-network-failure");
        return "unavailable";
      } }) });
    try {
      fixture.control.startLogin(); await fixture.control.settled();
      fixture.control.checkSession(); await fixture.control.settled();
      assert.equal(fixture.control.status().session.status, "failed");
      assert.equal(fixture.control.status().schedule.enabled, false);
      assert.equal(fixture.control.status().schedule.nextRunAt, null);
      assert.equal(JSON.parse(await readFile(join(fixture.directory, "control/status.json"), "utf8")).accessRestricted, true);
      assert.doesNotMatch(JSON.stringify(fixture.control.status()), /SECRET/);
    } finally { await fixture.cleanup(); }
  }
});

test("a login prompt after access restriction keeps automatic collection paused until authentication", async () => {
  for (const state of ["login_required", "qr_ready"] as const) {
    const fake = browser(false);
    const fixture = await setup({ scheduleEnabled: true }, { browser: async () => ({ ...fake.implementation,
      prepare: async () => "restricted", verify: async () => state }) });
    try {
      fixture.control.startLogin(); await fixture.control.settled();
      fixture.control.checkSession(); await fixture.control.settled();
      assert.equal(fixture.control.status().session.status, "expired");
      assert.equal(fixture.control.status().schedule.enabled, false);
      assert.equal(fixture.control.status().schedule.nextRunAt, null);
      assert.equal(JSON.parse(await readFile(join(fixture.directory, "control/status.json"), "utf8")).accessRestricted, true);
    } finally { await fixture.cleanup(); }
  }
});

test("access restriction persists across service restart without storing the page or session", async () => {
  const fake = browser(false);
  const fixture = await setup({ scheduleEnabled: true }, { browser: async () => ({ ...fake.implementation, prepare: async () => "restricted" }) });
  let restored: CollectorControl | null = null;
  try {
    fixture.control.startLogin(); await fixture.control.settled(); await fixture.control.stop();
    const saved = JSON.parse(await readFile(join(fixture.directory, "control/status.json"), "utf8"));
    assert.deepEqual(saved, { run: null, accessRestricted: true });
    restored = new CollectorControl({ dataDirectory: fixture.directory, outputDirectory: join(fixture.directory, "public"),
      scheduleEnabled: true, intervalMinutes: 360, headless: true }, { browser: async () => browser(true).implementation });
    await restored.start();
    assert.equal(restored.status().session.status, "restricted"); assert.equal(restored.status().schedule.enabled, false);
    assert.equal(restored.status().login.previewAvailable, false); assert.equal(restored.status().busy, false);
    restored.checkSession(); await restored.settled();
    assert.equal(restored.status().session.status, "authenticated"); assert.equal(restored.status().schedule.enabled, true);
    assert.equal(JSON.parse(await readFile(join(fixture.directory, "control/status.json"), "utf8")).accessRestricted, false);
  } finally { await restored?.stop(); await fixture.cleanup(); }
});
