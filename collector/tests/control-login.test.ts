import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { chromium, type BrowserContext } from "playwright";
import { commitLoginSession, openLoginBrowser, stageLoginProfile, waitForLoginReady, type LoginPageEvidence } from "../src/control-login.js";
import { loginDiagnostic, loginFailure } from "../src/login-errors.js";
import { CollectorControl } from "../src/collector-control.js";

async function profileFixture() {
  const directory = await mkdtemp(join(tmpdir(), "nabao-login-reuse-"));
  const profile = join(directory, "dedicated");
  await mkdir(join(profile, "Default", "Local Storage"), { recursive: true });
  await writeFile(join(profile, "Local State"), "existing-browser-identity");
  await writeFile(join(profile, "Default", "Cookies"), "synthetic-saved-session");
  await writeFile(join(profile, "Default", "Local Storage", "state"), "existing-site-state");
  return { directory, profile, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("staged login preserves dedicated browser identity and session while excluding caches and outside symlinks", async () => {
  const fixture = await profileFixture();
  try {
    await mkdir(join(fixture.profile, "Default", "Cache"));
    await writeFile(join(fixture.profile, "Default", "Cache", "disposable"), "cache");
    const outside = join(fixture.directory, "outside-secret");
    await writeFile(outside, "must-not-be-copied");
    await symlink(outside, join(fixture.profile, "external-link"));
    const staged = await stageLoginProfile(fixture.profile);
    assert.equal(await readFile(join(staged, "Local State"), "utf8"), "existing-browser-identity");
    assert.equal(await readFile(join(staged, "Default", "Cookies"), "utf8"), "synthetic-saved-session");
    assert.equal(await readFile(join(staged, "Default", "Local Storage", "state"), "utf8"), "existing-site-state");
    await assert.rejects(stat(join(staged, "Default", "Cache")), { code: "ENOENT" });
    await assert.rejects(stat(join(staged, "external-link")), { code: "ENOENT" });
    assert.equal((await stat(staged)).mode & 0o777, 0o700);
    await writeFile(join(staged, "Default", "Cookies"), "new-unconfirmed-session");
    assert.equal(await readFile(join(fixture.profile, "Default", "Cookies"), "utf8"), "synthetic-saved-session");
  } finally { await fixture.cleanup(); }
});

test("failed profile copy removes incomplete staging and preserves the saved profile", async () => {
  const fixture = await profileFixture();
  try {
    await assert.rejects(stageLoginProfile(fixture.profile, async (source, target, options) => {
      await cp(source, target, options);
      throw new Error("simulated-copy-failure");
    }), /simulated-copy-failure/);
    assert.deepEqual(await readdir(fixture.directory), ["dedicated"]);
    assert.equal(await readFile(join(fixture.profile, "Default", "Cookies"), "utf8"), "synthetic-saved-session");
  } finally { await fixture.cleanup(); }
});

test("first login stages an empty profile without creating an unverified saved profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nabao-first-login-"));
  const profile = join(directory, "dedicated");
  try {
    const staged = await stageLoginProfile(profile);
    assert.deepEqual(await readdir(staged), []);
    await assert.rejects(stat(profile), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an externally open profile is neither copied nor replaced", async () => {
  const fixture = await profileFixture();
  try {
    // Chromium's process marker is commonly a dangling symlink; lstat must still detect it.
    await symlink("some-host-123", join(fixture.profile, "SingletonLock"));
    let copied = false;
    await assert.rejects(stageLoginProfile(fixture.profile, async () => { copied = true; }), /LOGIN_PROFILE_BUSY/);
    assert.equal(copied, false);
    assert.deepEqual(await readdir(fixture.directory), ["dedicated"]);
    const staged = join(fixture.directory, "stage");
    await mkdir(staged); await writeFile(join(staged, "Local State"), "replacement");
    const sessionFile = join(fixture.directory, "export.json");
    await writeFile(sessionFile, "old-export");
    await assert.rejects(commitLoginSession(staged, fixture.profile, sessionFile, "new-export"), /LOGIN_PROFILE_BUSY/);
    assert.equal(await readFile(join(fixture.profile, "Local State"), "utf8"), "existing-browser-identity");
    assert.equal(await readFile(sessionFile, "utf8"), "old-export");
    assert.equal(await readFile(join(staged, "Local State"), "utf8"), "replacement");
  } finally { await fixture.cleanup(); }
});

test("a configured profile symlink cannot copy another browser directory", async () => {
  const fixture = await profileFixture();
  try {
    const link = join(fixture.directory, "profile-link");
    await symlink(fixture.profile, link);
    await assert.rejects(stageLoginProfile(link), /LOGIN_PROFILE_INVALID/);
    assert.deepEqual((await readdir(fixture.directory)).sort(), ["dedicated", "profile-link"]);
  } finally { await fixture.cleanup(); }
});

const qrEvidence: LoginPageEvidence = { origin: "https://www.xiaohongshu.com", text: "扫码登录", loginVisible: true,
  qrVisible: true, challengeVisible: false, ownProfileVisible: false, loggedIn: false, guest: true };
const authenticated: LoginPageEvidence = { ...qrEvidence, text: "已登录", loginVisible: false, qrVisible: false,
  ownProfileVisible: true, loggedIn: true, guest: false, userId: "123456789012345678901234" };

test("login readiness waits through a loading modal and stops when QR, authentication or a restriction is visible", async () => {
  for (const ready of ["qr_ready", "authenticated", "restricted"] as const) {
    let reads = 0;
    const state = await waitForLoginReady(async () => ++reads < 3 ? "login_required" : ready, 1000);
    assert.equal(state, ready); assert.equal(reads, 3);
  }
});

test("login readiness timeout preserves the observed incomplete state instead of reporting a QR", async () => {
  for (const incomplete of ["login_required", "unavailable"] as const) {
    let reads = 0;
    const started = Date.now();
    const state = await waitForLoginReady(async () => { reads++; return incomplete; }, 20);
    assert.equal(state, incomplete); assert.ok(reads >= 2);
    assert.ok(Date.now() - started < 1000);
  }
  let reads = 0;
  assert.equal(await waitForLoginReady(async () => { reads++; return "restricted"; }), "restricted");
  assert.equal(reads, 1);
});

test("prepare waits for the QR image after clicking login without a reload or second navigation", async () => {
  const fixture = await profileFixture();
  const previous = process.env.NABAO_BROWSER_PROFILE;
  process.env.NABAO_BROWSER_PROFILE = fixture.profile;
  let clicks = 0, navigations = 0, readsAfterClick = 0;
  const loginButton = { first() { return this; }, isVisible: async () => true, click: async () => { clicks++; } };
  const page = {
    setViewportSize: async () => undefined, setDefaultTimeout: () => undefined,
    goto: async () => { navigations++; }, waitForLoadState: async () => undefined,
    reload: async () => { throw new Error("must not reload"); },
    locator: () => ({ isVisible: async () => clicks > 0 }), getByRole: () => loginButton,
    evaluate: async () => clicks && ++readsAfterClick >= 3 ? qrEvidence : { ...qrEvidence, qrVisible: false },
  };
  const launch = mock.method(chromium, "launchPersistentContext", async () => ({
    pages: () => [page], close: async () => undefined,
  } as unknown as BrowserContext));
  try {
    const browser = await openLoginBrowser(false, "login");
    assert.equal(await browser.prepare(), "qr_ready");
    assert.equal(clicks, 1); assert.equal(navigations, 1); assert.equal(readsAfterClick, 3);
    await browser.close();
  } finally {
    launch.mock.restore();
    if (previous === undefined) delete process.env.NABAO_BROWSER_PROFILE; else process.env.NABAO_BROWSER_PROFILE = previous;
    await fixture.cleanup();
  }
});

test("login cancellation discards only the staged profile and verification never reloads the user page", async () => {
  const fixture = await profileFixture();
  const previous = { profile: process.env.NABAO_BROWSER_PROFILE, storage: process.env.NABAO_BROWSER_STORAGE_STATE };
  process.env.NABAO_BROWSER_PROFILE = fixture.profile;
  delete process.env.NABAO_BROWSER_STORAGE_STATE;
  let evidence = qrEvidence, navigations = 0, closes = 0, staged = "";
  const page = {
    setViewportSize: async () => undefined, setDefaultTimeout: () => undefined,
    goto: async () => { navigations++; }, waitForLoadState: async () => undefined,
    reload: async () => { throw new Error("verification must not reload"); },
    evaluate: async () => evidence,
  };
  const launch = mock.method(chromium, "launchPersistentContext", async (path: string, options: Parameters<typeof chromium.launchPersistentContext>[1]) => {
    staged = path; assert.equal(options?.headless, false);
    return { pages: () => [page], close: async () => { closes++; } } as unknown as BrowserContext;
  });
  try {
    const browser = await openLoginBrowser(false, "login");
    assert.notEqual(staged, fixture.profile);
    assert.equal(await readFile(join(staged, "Default", "Cookies"), "utf8"), "synthetic-saved-session");
    assert.equal(await browser.prepare(), "qr_ready");
    assert.equal(await browser.verify(), "qr_ready");
    evidence = authenticated;
    assert.equal(await browser.verify(), "authenticated");
    assert.equal(navigations, 1);
    await writeFile(join(staged, "Default", "Cookies"), "unconfirmed-session");
    await browser.close(); await browser.close();
    assert.equal(closes, 1);
    await assert.rejects(stat(staged), { code: "ENOENT" });
    assert.equal(await readFile(join(fixture.profile, "Default", "Cookies"), "utf8"), "synthetic-saved-session");
  } finally {
    launch.mock.restore();
    if (previous.profile === undefined) delete process.env.NABAO_BROWSER_PROFILE; else process.env.NABAO_BROWSER_PROFILE = previous.profile;
    if (previous.storage === undefined) delete process.env.NABAO_BROWSER_STORAGE_STATE; else process.env.NABAO_BROWSER_STORAGE_STATE = previous.storage;
    await fixture.cleanup();
  }
});

test("session-only login and checks both reuse the configured saved state without extra navigation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nabao-login-state-"));
  const stateFile = join(directory, "session.json");
  await writeFile(stateFile, "synthetic-saved-state");
  const previous = { profile: process.env.NABAO_BROWSER_PROFILE, storage: process.env.NABAO_BROWSER_STORAGE_STATE };
  delete process.env.NABAO_BROWSER_PROFILE;
  process.env.NABAO_BROWSER_STORAGE_STATE = stateFile;
  let navigations = 0, closes = 0;
  const page = {
    setViewportSize: async () => undefined, setDefaultTimeout: () => undefined,
    goto: async () => { navigations++; }, waitForLoadState: async () => undefined,
    reload: async () => { throw new Error("verification must not reload"); },
    evaluate: async () => authenticated,
  };
  const launch = mock.method(chromium, "launch", async () => ({
    newContext: async (options: { storageState?: string }) => {
      assert.equal(options.storageState, stateFile);
      return { pages: () => [page] };
    }, close: async () => { closes++; },
  }));
  try {
    for (const mode of ["login", "check"] as const) {
      const browser = await openLoginBrowser(true, mode);
      assert.equal(await browser.prepare(), "authenticated");
      assert.equal(await browser.verify(), "authenticated");
      await browser.close();
    }
    assert.equal(navigations, 2); assert.equal(closes, 2);
    assert.equal(await readFile(stateFile, "utf8"), "synthetic-saved-state");
  } finally {
    launch.mock.restore();
    if (previous.profile === undefined) delete process.env.NABAO_BROWSER_PROFILE; else process.env.NABAO_BROWSER_PROFILE = previous.profile;
    if (previous.storage === undefined) delete process.env.NABAO_BROWSER_STORAGE_STATE; else process.env.NABAO_BROWSER_STORAGE_STATE = previous.storage;
    await rm(directory, { recursive: true, force: true });
  }
});

test("login diagnostics expose only phase and allowlisted causes, never exception details", () => {
  const secret = "SECRET-cookie https://private.example/token /private/profile";
  const timeout = Object.assign(new Error(secret), { name: "TimeoutError" });
  assert.equal(loginDiagnostic(loginFailure("PAGE_NAVIGATION", timeout)).code, "LOGIN_PAGE_NAVIGATION_TIMEOUT");
  assert.match(loginDiagnostic(loginFailure("PAGE_NAVIGATION", new Error(`net::ERR_NAME_NOT_RESOLVED ${secret}`))).message, /DNS/);
  assert.match(loginDiagnostic(loginFailure("PAGE_NAVIGATION", new Error(`net::ERR_PROXY_CONNECTION_FAILED ${secret}`))).message, /代理/);
  for (const phase of ["PROFILE", "BROWSER_LAUNCH", "PAGE_NAVIGATION", "PAGE_READ", "SAVE"] as const) {
    const failure = loginFailure(phase, new Error(`ERR_UNKNOWN_SECRET ${secret}`));
    assert.equal(failure.code, `LOGIN_${phase}_FAILED`);
    assert.doesNotMatch(JSON.stringify(loginDiagnostic(failure)), /SECRET|private\.example|private\/profile/);
    assert.equal(loginFailure("PAGE_READ", failure), failure, "wrapping must preserve the original phase");
  }
  assert.doesNotMatch(JSON.stringify(loginDiagnostic(new Error(secret))), /SECRET|private\.example/);
  const original = new TypeError(secret);
  const preserved = loginFailure("PAGE_READ", original);
  assert.equal(preserved.cause, original);
  assert.equal(Object.getOwnPropertyDescriptor(preserved, "cause")?.enumerable, false);
  assert.doesNotMatch(JSON.stringify(preserved), /SECRET|private\.example|private\/profile/);
});

test("read diagnostics distinguish page changes from JavaScript failures without exposing their contents", () => {
  const examples = [
    ["page.evaluate: Execution context was destroyed, most likely because of a navigation", "CONTEXT_CHANGED"],
    ["Cannot find context with specified id", "CONTEXT_CHANGED"],
    ["page.evaluate: Frame was detached", "FRAME_DETACHED"],
    ["Execution context is not available in detached frame", "FRAME_DETACHED"],
    ["page.evaluate: TypeError: private-value", "JS_TYPE_ERROR"],
    ["page.evaluate: ReferenceError: private-variable is not defined", "JS_REFERENCE_ERROR"],
    ["page.evaluate: SyntaxError: private-expression", "JS_SYNTAX_ERROR"],
    ["page.evaluate: RangeError: private-number", "JS_RANGE_ERROR"],
    ["Protocol error (private-method): private-payload", "PROTOCOL_ERROR"],
  ] as const;
  for (const [message, detail] of examples) {
    const diagnostic = loginDiagnostic(loginFailure("PAGE_READ", new Error(`${message} https://private.example SECRET`)));
    assert.equal(diagnostic.code, `LOGIN_PAGE_READ_${detail}`);
    assert.doesNotMatch(diagnostic.message, /private|SECRET/);
  }
  assert.equal(loginDiagnostic(loginFailure("PAGE_READ", new TypeError("SECRET"))).code, "LOGIN_PAGE_READ_JS_TYPE_ERROR");
});

test("browser page setup failures cannot be mistaken for login state evaluation failures", async () => {
  for (const phase of ["PAGE_CREATE", "PAGE_VIEWPORT", "PAGE_SETUP"] as const) {
    const fixture = await profileFixture();
    const previous = process.env.NABAO_BROWSER_PROFILE;
    process.env.NABAO_BROWSER_PROFILE = fixture.profile;
    let navigations = 0;
    const fail = () => { throw new Error("Protocol error: SECRET private-payload"); };
    const page = {
      setViewportSize: async () => { if (phase === "PAGE_VIEWPORT") fail(); },
      setDefaultTimeout: () => { if (phase === "PAGE_SETUP") fail(); },
      goto: async () => { navigations++; },
    };
    const launch = mock.method(chromium, "launchPersistentContext", async () => ({
      pages: () => phase === "PAGE_CREATE" ? [] : [page], newPage: async () => fail(), close: async () => undefined,
    } as unknown as BrowserContext));
    try {
      await assert.rejects(openLoginBrowser(false, "login"), error => {
        const diagnostic = loginDiagnostic(error);
        assert.equal(diagnostic.code, `LOGIN_${phase}_PROTOCOL_ERROR`);
        assert.doesNotMatch(diagnostic.message, /SECRET|private/); return true;
      });
      assert.equal(navigations, 0); assert.deepEqual(await readdir(fixture.directory), ["dedicated"]);
    } finally {
      launch.mock.restore();
      if (previous === undefined) delete process.env.NABAO_BROWSER_PROFILE; else process.env.NABAO_BROWSER_PROFILE = previous;
      await fixture.cleanup();
    }
  }
});

test("the compiled page reader tolerates missing DOM and excludes reactive objects from authentication evidence", async () => {
  const fixture = await profileFixture();
  const previous = process.env.NABAO_BROWSER_PROFILE;
  process.env.NABAO_BROWSER_PROFILE = fixture.profile;
  const cyclic: Record<string, unknown> = { value: true }; cyclic.self = cyclic;
  let initialState: unknown = undefined;
  let body: { innerText: string } | null = null;
  const page = {
    setViewportSize: async () => undefined, setDefaultTimeout: () => undefined,
    goto: async () => undefined, waitForLoadState: async () => undefined,
    evaluate: async (reader: () => unknown) => {
      const evidence = runInNewContext(`(${reader.toString()})()`, {
        window: { __INITIAL_STATE__: initialState }, location: { origin: "https://www.xiaohongshu.com" },
        document: { body, querySelectorAll: () => [] },
      });
      assert.doesNotThrow(() => JSON.stringify(evidence));
      for (const field of ["loggedIn", "guest", "userId"]) assert.notEqual(typeof evidence[field], "object");
      return evidence;
    },
  };
  const launch = mock.method(chromium, "launchPersistentContext", async () => ({
    pages: () => [page], close: async () => undefined,
  } as unknown as BrowserContext));
  try {
    const browser = await openLoginBrowser(false, "login");
    assert.equal(await browser.verify(), "unavailable");
    initialState = { user: { loggedIn: cyclic, userInfo: { guest: cyclic, user_id: cyclic } } };
    body = { innerText: "" };
    assert.equal(await browser.verify(), "unavailable");
    await browser.close();
  } finally {
    launch.mock.restore();
    if (previous === undefined) delete process.env.NABAO_BROWSER_PROFILE; else process.env.NABAO_BROWSER_PROFILE = previous;
    await fixture.cleanup();
  }
});

test("the compiled reader unwraps explicit Vue refs without serializing their graph or weakening authentication", async () => {
  const fixture = await profileFixture();
  const previous = process.env.NABAO_BROWSER_PROFILE;
  const previousDiagnostics = process.env.NABAO_LOGIN_DIAGNOSTICS;
  process.env.NABAO_BROWSER_PROFILE = fixture.profile;
  process.env.NABAO_LOGIN_DIAGNOSTICS = "true";
  const diagnosticLines: string[] = [];
  const log = mock.method(console, "info", (line: string) => { diagnosticLines.push(line); });
  const ref = (value: unknown): Record<string, unknown> => {
    const result: Record<string, unknown> = { __v_isRef: true, value };
    result.dependency = { owner: result }; // A realistic reactive backreference must never cross the serializer.
    return result;
  };
  const userId = "123456789012345678901234";
  let loginVisible = false, ownProfileVisible = true;
  let loggedIn: unknown = ref(true), guest: unknown = ref(false);
  let identifiers: Record<string, unknown> = { user_id: ref(userId) };
  const visible = { getClientRects: () => [1] };
  const profileLink = { ...visible, textContent: "我", getAttribute: () => `/user/profile/${userId}` };
  const page = {
    setViewportSize: async () => undefined, setDefaultTimeout: () => undefined,
    goto: async () => undefined, waitForLoadState: async () => undefined,
    evaluate: async (reader: () => unknown) => {
      const state = { user: ref({ loggedIn, userInfo: ref({ guest, ...identifiers }) }) };
      const evidence = runInNewContext(`(${reader.toString()})()`, {
        window: { __INITIAL_STATE__: state }, location: { origin: "https://www.xiaohongshu.com" },
        document: { body: { innerText: "发现 我" }, querySelectorAll: (selector: string) =>
          selector.startsWith("a[") ? ownProfileVisible ? [profileLink] : []
            : selector === ".login-container" && loginVisible ? [visible] : [] },
      });
      assert.doesNotThrow(() => JSON.stringify(evidence));
      for (const field of ["loggedIn", "guest", "userId"]) assert.notEqual(typeof evidence[field], "object");
      return evidence;
    },
  };
  const launch = mock.method(chromium, "launchPersistentContext", async () => ({
    pages: () => [page], close: async () => undefined,
  } as unknown as BrowserContext));
  try {
    const browser = await openLoginBrowser(false, "login");
    assert.equal(await browser.verify(), "authenticated");
    assert.equal(JSON.parse(diagnosticLines[0]!).shapes.info.ref, true);
    assert.equal(JSON.parse(diagnosticLines[0]!).ownProfileVisibleMatches, 1);
    assert.doesNotMatch(diagnosticLines.join("\n"), new RegExp(userId));
    identifiers = { userId: ref(userId) };
    assert.equal(await browser.verify(), "authenticated", "camelCase ref ID must match the same visible own-profile evidence");
    let diagnosis = JSON.parse(diagnosticLines.at(-1)!);
    assert.equal(diagnosis.shapes.userIdCamel.ref, true); assert.equal(diagnosis.userIdSnakeProvided, false);
    assert.equal(diagnosis.userIdCamelValid, true); assert.equal(diagnosis.userIdValid, true);
    identifiers = { user_id: ref(userId), userId: ref(userId) };
    assert.equal(await browser.verify(), "authenticated", "equal valid aliases are consistent");
    identifiers = { user_id: ref(userId), userId: ref("aaaaaaaaaaaaaaaaaaaaaaaa") };
    assert.equal(await browser.verify(), "unavailable", "conflicting valid aliases cannot choose one ID");
    diagnosis = JSON.parse(diagnosticLines.at(-1)!);
    assert.equal(diagnosis.userIdConflict, true); assert.equal(diagnosis.userIdValid, false);
    for (const malformed of [null, "invalid-id", "AAAAAAAAAAAAAAAAAAAAAAAA", { value: userId }, ref(undefined)]) {
      identifiers = { user_id: malformed, userId: ref(userId) };
      assert.equal(await browser.verify(), "unavailable", "valid camelCase cannot override a malformed supplied snake_case ID");
      identifiers = { user_id: ref(userId), userId: malformed };
      assert.equal(await browser.verify(), "unavailable", "valid snake_case cannot override a malformed supplied camelCase ID");
    }
    identifiers = {};
    assert.equal(await browser.verify(), "unavailable", "a missing ID cannot authenticate from an avatar alone");
    identifiers = { userId: ref(userId) };
    loggedIn = ref(ref(true));
    assert.equal(await browser.verify(), "authenticated");
    loggedIn = ref(ref(ref(true)));
    assert.equal(await browser.verify(), "unavailable", "unwrapping depth must be bounded");
    const selfRef = ref(undefined); selfRef.value = selfRef; loggedIn = selfRef;
    assert.equal(await browser.verify(), "unavailable", "a ref cycle must not authenticate");
    loggedIn = { value: true };
    assert.equal(await browser.verify(), "unavailable", "a value-shaped object without Vue's explicit marker must not unwrap");
    loggedIn = ref(true); guest = ref("false");
    assert.equal(await browser.verify(), "unavailable", "guest must be exactly boolean false");
    guest = ref(false); ownProfileVisible = false;
    assert.equal(await browser.verify(), "unavailable", "visible own-profile evidence is still required");
    ownProfileVisible = true; loginVisible = true;
    assert.equal(await browser.verify(), "login_required", "a login overlay still rejects authentication");
    await browser.close();
  } finally {
    launch.mock.restore();
    log.mock.restore();
    if (previous === undefined) delete process.env.NABAO_BROWSER_PROFILE; else process.env.NABAO_BROWSER_PROFILE = previous;
    if (previousDiagnostics === undefined) delete process.env.NABAO_LOGIN_DIAGNOSTICS; else process.env.NABAO_LOGIN_DIAGNOSTICS = previousDiagnostics;
    await fixture.cleanup();
  }
});

test("interactive login override does not change the browser mode used for saved-session checks", async () => {
  const fixture = await profileFixture();
  const previous = { profile: process.env.NABAO_BROWSER_PROFILE, storage: process.env.NABAO_BROWSER_STORAGE_STATE };
  process.env.NABAO_BROWSER_PROFILE = fixture.profile;
  delete process.env.NABAO_BROWSER_STORAGE_STATE;
  const modes: boolean[] = [];
  const page = { setViewportSize: async () => undefined, setDefaultTimeout: () => undefined,
    goto: async () => undefined, waitForLoadState: async () => undefined, evaluate: async () => authenticated };
  const launch = mock.method(chromium, "launchPersistentContext", async (_profile: string, options: Parameters<typeof chromium.launchPersistentContext>[1]) => {
    modes.push(options?.headless ?? true);
    return { pages: () => [page], close: async () => undefined, storageState: async () => ({ cookies: [], origins: [] }) } as unknown as BrowserContext;
  });
  const control = new CollectorControl({ dataDirectory: join(fixture.directory, "control-data"), outputDirectory: join(fixture.directory, "output"),
    scheduleEnabled: false, intervalMinutes: 360, headless: true, loginHeadless: false });
  try {
    await control.start();
    control.startLogin(); await control.settled();
    assert.equal(control.status().session.status, "authenticated");
    control.checkSession(); await control.settled();
    assert.equal(control.status().session.status, "authenticated");
    assert.deepEqual(modes, [false, true]);
  } finally {
    await control.stop(); launch.mock.restore();
    if (previous.profile === undefined) delete process.env.NABAO_BROWSER_PROFILE; else process.env.NABAO_BROWSER_PROFILE = previous.profile;
    if (previous.storage === undefined) delete process.env.NABAO_BROWSER_STORAGE_STATE; else process.env.NABAO_BROWSER_STORAGE_STATE = previous.storage;
    await fixture.cleanup();
  }
});

test("browser launch, navigation, page reading and save failures retain distinct sanitized phases", async () => {
  for (const phase of ["BROWSER_LAUNCH", "PAGE_NAVIGATION", "PAGE_READ", "SAVE"] as const) {
    const fixture = await profileFixture();
    const previous = process.env.NABAO_BROWSER_PROFILE;
    process.env.NABAO_BROWSER_PROFILE = fixture.profile;
    const failure = () => {
      throw Object.assign(new Error("SECRET https://private.example/session net::ERR_CONNECTION_RESET"), { code: "EACCES" });
    };
    const page = {
      setViewportSize: async () => undefined, setDefaultTimeout: () => undefined,
      goto: async () => { if (phase === "PAGE_NAVIGATION") failure(); }, waitForLoadState: async () => undefined,
      evaluate: async () => { if (phase === "PAGE_READ") failure(); return authenticated; },
    };
    const launch = mock.method(chromium, "launchPersistentContext", async () => {
      if (phase === "BROWSER_LAUNCH") failure();
      return { pages: () => [page], close: async () => undefined,
        storageState: async () => { if (phase === "SAVE") failure(); return {}; } } as unknown as BrowserContext;
    });
    let browser: Awaited<ReturnType<typeof openLoginBrowser>> | undefined;
    try {
      await assert.rejects(async () => {
        browser = await openLoginBrowser(false, "login");
        await browser.prepare();
        await browser.save();
      }, error => {
        const diagnostic = loginDiagnostic(error);
        assert.equal(diagnostic.code, `LOGIN_${phase}_ERR_CONNECTION_RESET`);
        assert.doesNotMatch(diagnostic.message, /SECRET|private\.example/);
        return true;
      });
      await browser?.close();
      assert.equal(await readFile(join(fixture.profile, "Default", "Cookies"), "utf8"), "synthetic-saved-session");
      assert.deepEqual(await readdir(fixture.directory), ["dedicated"]);
    } finally {
      launch.mock.restore();
      if (previous === undefined) delete process.env.NABAO_BROWSER_PROFILE; else process.env.NABAO_BROWSER_PROFILE = previous;
      await fixture.cleanup();
    }
  }
});
