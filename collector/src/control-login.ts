import { chromium, type BrowserContext, type Page } from "playwright";
import { chmod, cp, lstat, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { openDedicatedSession, sessionDirectory } from "./browser-session.js";
import { loginFailure } from "./login-errors.js";
import { createLoginDiagnostics } from "./login-diagnostics.js";

export type LoginPageState = "authenticated" | "qr_ready" | "login_required" | "restricted" | "unavailable";
export interface LoginBrowser {
  prepare(): Promise<LoginPageState>;
  verify(): Promise<LoginPageState>;
  save(): Promise<void>;
  preview(): Promise<Buffer>;
  close(): Promise<void>;
}

const readyLoginStates = new Set<LoginPageState>(["authenticated", "restricted", "qr_ready"]);

/** Wait only for this page's DOM to settle; no navigation or network retries. */
export async function waitForLoginReady(readState: () => Promise<LoginPageState>, timeoutMs = 5000): Promise<LoginPageState> {
  const deadline = Date.now() + timeoutMs;
  let state = await readState();
  while (!readyLoginStates.has(state)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return state;
    await delay(Math.min(100, remaining));
    state = await readState();
  }
  return state;
}

/** Only a live logged-in page AND its own-profile navigation prove authentication. */
export function authenticatedEvidence(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const evidence = value as Record<string, unknown>;
  return evidence.loggedIn === true && evidence.guest === false
    && typeof evidence.userId === "string" && /^[a-f0-9]{24}$/.test(evidence.userId)
    && evidence.ownProfileVisible === true && evidence.loginVisible === false;
}

const disposableProfileEntries = new Set([
  "SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort",
  "Cache", "Code Cache", "GPUCache", "Media Cache", "ShaderCache", "GrShaderCache",
  "DawnGraphiteCache", "DawnWebGPUCache", "BrowserMetrics", "Crashpad", "Crash Reports",
]);

async function assertProfileClosed(profile: string): Promise<void> {
  // A browser opened outside the collector does not hold scan.lock. Treat even a
  // stale Chromium lock as busy: copying a live profile could snapshot an incomplete DB.
  try { await lstat(join(profile, "SingletonLock")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error("LOGIN_PROFILE_BUSY");
}

/** Call under scan.lock. Preserve our dedicated browser identity without touching the saved profile. */
export async function stageLoginProfile(profile: string, copy: typeof cp = cp): Promise<string> {
  await mkdir(dirname(profile), { recursive: true, mode: 0o700 });
  const staged = await mkdtemp(join(dirname(profile), ".nabao-login-"));
  await chmod(staged, 0o700);
  try {
    let exists = true;
    try {
      const current = await lstat(profile);
      if (!current.isDirectory() || current.isSymbolicLink()) throw new Error("LOGIN_PROFILE_INVALID");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false;
      else throw error;
    }
    if (exists) await assertProfileClosed(profile);
    if (exists) await copy(profile, staged, {
      recursive: true, dereference: false,
      // Browser process markers and disposable caches do not belong in a new context.
      // Other symlinks are excluded so this never copies data outside the configured profile.
      filter: async (source) => source === profile || !disposableProfileEntries.has(basename(source))
        && !(await lstat(source)).isSymbolicLink(),
    });
    await chmod(staged, 0o700);
    return staged;
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
}

/** Ordinary browser login only; no cookie APIs, hidden login endpoints or challenge solving. */
export async function openLoginBrowser(headless: boolean, mode: "login" | "check" = "check"): Promise<LoginBrowser> {
  let context: BrowserContext;
  let closeContext: () => Promise<void>;
  let stagedProfile: string | null = null;
  const profile = sessionDirectory();
  if (mode === "login" && profile) {
    try { stagedProfile = await stageLoginProfile(profile); }
    catch (error) { throw loginFailure("PROFILE", error); }
    try {
      context = await chromium.launchPersistentContext(stagedProfile, { headless, locale: "zh-CN", timezoneId: "Asia/Shanghai",
        ...(process.env.NABAO_BROWSER_CHANNEL === "chrome" ? { channel: "chrome" } : {}) });
      closeContext = () => context.close();
    } catch (error) { await rm(stagedProfile, { recursive: true, force: true }); throw loginFailure("BROWSER_LAUNCH", error); }
  } else if (profile) {
    try { context = await openDedicatedSession(headless); }
    catch (error) { throw loginFailure("BROWSER_LAUNCH", error); }
    closeContext = () => context.close();
  } else {
    const browser = await chromium.launch({ headless,
      ...(process.env.NABAO_BROWSER_CHANNEL === "chrome" ? { channel: "chrome" } : {}) })
      .catch(error => { throw loginFailure("BROWSER_LAUNCH", error); });
    try {
      // Both entry points reuse the configured session; new state is only committed after verification.
      const storage = process.env.NABAO_BROWSER_STORAGE_STATE;
      let storageState: string | undefined;
      if (storage) {
        const { access } = await import("node:fs/promises");
        try { await access(resolve(storage)); storageState = resolve(storage); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw loginFailure("PROFILE", error); }
      }
      context = await browser.newContext({ locale: "zh-CN", timezoneId: "Asia/Shanghai", storageState });
      closeContext = () => browser.close();
    } catch (error) { await browser.close(); throw loginFailure("BROWSER_LAUNCH", error); }
  }
  let contextClosing: Promise<void> | null = null;
  const diagnose = createLoginDiagnostics(process.env.NABAO_LOGIN_DIAGNOSTICS === "true");
  const closeOnce = () => contextClosing ??= closeContext();
  const close = async () => {
    try { await closeOnce(); }
    finally {
      if (stagedProfile) { const discarded = stagedProfile; stagedProfile = null; await rm(discarded, { recursive: true, force: true }); }
    }
  };
  try {
    let page: Page;
    try { page = context.pages()[0] ?? await context.newPage(); }
    catch (error) { throw loginFailure("PAGE_CREATE", error); }
    try { await page.setViewportSize({ width: 1120, height: 800 }); }
    catch (error) { throw loginFailure("PAGE_VIEWPORT", error); }
    try { page.setDefaultTimeout(5000); }
    catch (error) { throw loginFailure("PAGE_SETUP", error); }
    await page.goto("https://www.xiaohongshu.com/explore", { waitUntil: "domcontentloaded", timeout: 30_000 })
      .catch(error => { throw loginFailure("PAGE_NAVIGATION", error); });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
    const readPage = () => pageState(page, diagnose);
    return {
      async prepare() {
        try {
          const initial = await readPage();
          if (readyLoginStates.has(initial)) return initial;
          // Only the website's normal login button is clicked. QR and any challenges stay with the user.
          if (!await page.locator(".login-container").isVisible().catch(() => false)) {
            const login = page.getByRole("button", { name: /登录/ }).first();
            if (await login.isVisible().catch(() => false)) await login.click();
          }
          // The modal and QR image may render after the click resolves. Wait for live
          // evidence without reloading it, and keep timeout distinct from a ready QR.
          return await waitForLoginReady(readPage);
        } catch (error) { throw loginFailure("PAGE_READ", error); }
      },
      async verify() {
        // The page was already loaded when opening the browser. In a login flow it
        // is also the page the user is interacting with; reloading would reset QR/challenges.
        return readPage();
      },
      async save() {
        try {
          const state = await context.storageState();
          if (stagedProfile) await closeOnce();
          await commitLoginSession(stagedProfile, profile ?? null,
            process.env.NABAO_BROWSER_STORAGE_STATE ? resolve(process.env.NABAO_BROWSER_STORAGE_STATE) : null,
            JSON.stringify(state));
          stagedProfile = null;
        } catch (error) { throw loginFailure("SAVE", error); }
      },
      async preview() {
        const modal = page.locator(".login-container").first();
        if (await modal.isVisible().catch(() => false)) return modal.screenshot({ type: "png", timeout: 5000 });
        return page.screenshot({ type: "png", fullPage: false, timeout: 5000 });
      },
      close,
    };
  } catch (error) { await close(); throw loginFailure("PAGE_READ", error); }
}

export interface LoginPageEvidence {
  origin: string; text: string; loginVisible: boolean; qrVisible: boolean; challengeVisible: boolean;
  loggedIn?: unknown; guest?: unknown; userId?: unknown; ownProfileVisible: boolean;
}

/** Risk pages and missing pages never imply an expired session or a ready login QR. */
export function classifyLoginPage(value: LoginPageEvidence): LoginPageState {
  if (value.challengeVisible || /300012|IP\s*存在风险|安全限制|请完成安全验证|访问受限|访问异常/.test(value.text)) return "restricted";
  if (value.origin !== "https://www.xiaohongshu.com") return "unavailable";
  if (authenticatedEvidence(value)) return "authenticated";
  if (value.loginVisible && value.qrVisible) return "qr_ready";
  if (value.loginVisible || value.loggedIn === false && value.guest === true) return "login_required";
  return "unavailable";
}

async function pageState(page: Page, diagnose: ReturnType<typeof createLoginDiagnostics>): Promise<LoginPageState> {
  const value = await page.evaluate(() => {
    const record = (value: unknown): Record<string, unknown> | undefined =>
      value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    const unref = (value: unknown): unknown => {
      // Read Vue's explicit public ref marker/value only. Bound the depth so malformed
      // or cyclic refs stay untrusted instead of looping or traversing reactive graphs.
      for (let depth = 0; depth < 2; depth++) {
        const ref = record(value);
        if (ref?.__v_isRef !== true) break;
        value = ref.value;
      }
      return value;
    };
    const initialStateValue = (window as unknown as { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__;
    const state = record(unref(initialStateValue));
    const userValue = state?.user, user = record(unref(userValue));
    const infoValue = user?.userInfo, info = record(unref(infoValue));
    const loggedInValue = user?.loggedIn, guestValue = info?.guest;
    const userIdSnakeValue = info?.user_id, userIdCamelValue = info?.userId;
    const rawLoggedIn = unref(loggedInValue), rawGuest = unref(guestValue);
    const userIdSnake = unref(userIdSnakeValue), userIdCamel = unref(userIdCamelValue);
    // Never return reactive objects or unexpected page values through Playwright's
    // serializer. Authentication still requires all of these strict live primitives.
    const loggedIn = typeof rawLoggedIn === "boolean" ? rawLoggedIn : undefined;
    const guest = typeof rawGuest === "boolean" ? rawGuest : undefined;
    const userIdSnakeProvided = userIdSnakeValue !== undefined, userIdCamelProvided = userIdCamelValue !== undefined;
    const userIdSnakeValid = typeof userIdSnake === "string" && /^[a-f0-9]{24}$/.test(userIdSnake);
    const userIdCamelValid = typeof userIdCamel === "string" && /^[a-f0-9]{24}$/.test(userIdCamel);
    const userIdConflict = userIdSnakeValid && userIdCamelValid && userIdSnake !== userIdCamel;
    // Either documented spelling is accepted, but a supplied malformed or conflicting
    // alias must not be ignored in favor of a convenient valid ID.
    const userId = userIdSnakeProvided && !userIdSnakeValid || userIdCamelProvided && !userIdCamelValid || userIdConflict
      ? undefined : userIdSnakeValid ? userIdSnake : userIdCamelValid ? userIdCamel : undefined;
    const visible = (element: Element) => element.getClientRects().length > 0;
    const ownProfiles = typeof userId === "string" ? Array.from(document.querySelectorAll('a[href*="/user/profile/"]'))
      .filter(link => link.getAttribute("href")?.split("?")[0] === `/user/profile/${userId}`) : [];
    const ownProfilesWithMyText = ownProfiles.filter(link => link.textContent?.trim() === "我");
    const ownVisibleProfiles = ownProfilesWithMyText.filter(visible);
    const ownProfileVisible = ownVisibleProfiles.length > 0;
    const loginVisible = Array.from(document.querySelectorAll(".login-container")).some(visible);
    const challengeVisible = Array.from(document.querySelectorAll('[class*="captcha"], iframe[src*="captcha"]')).some(visible);
    const qrVisible = Array.from(document.querySelectorAll('.login-container canvas, .login-container img[class*="qr"], .login-container [class*="qr"] img'))
      .some((element) => visible(element) && (element instanceof HTMLImageElement ? element.complete && element.naturalWidth >= 80
        : element instanceof HTMLCanvasElement && element.width >= 80));
    // Redirects can briefly replace the document before its body exists. That is
    // unavailable evidence, not a JavaScript failure or proof of expired login.
    const shape = (value: unknown) => ({ type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
      ref: record(value)?.__v_isRef === true });
    return { origin: location.origin, text: (document.body?.innerText ?? "").slice(0, 8000),
      loggedIn, guest, userId, ownProfileVisible, loginVisible, challengeVisible, qrVisible,
      diagnostic: { shapes: { initialState: shape(initialStateValue), user: shape(userValue), info: shape(infoValue),
        loggedIn: shape(loggedInValue), guest: shape(guestValue), userIdSnake: shape(userIdSnakeValue), userIdCamel: shape(userIdCamelValue) },
        initialStatePresent: state !== undefined, userPresent: user !== undefined, infoPresent: info !== undefined,
        loggedIn: loggedIn === true ? "true" : loggedIn === false ? "false" : "missing",
        guest: guest === true ? "true" : guest === false ? "false" : "missing", userIdValid: typeof userId === "string" && /^[a-f0-9]{24}$/.test(userId),
        userIdSnakeProvided, userIdCamelProvided, userIdSnakeValid, userIdCamelValid, userIdConflict,
        ownProfileMatches: ownProfiles.length, ownProfileMyTextMatches: ownProfilesWithMyText.length, ownProfileVisibleMatches: ownVisibleProfiles.length,
        loginVisible, challengeVisible, qrVisible } };
  }).catch(error => { throw loginFailure("PAGE_READ", error); });
  const result = classifyLoginPage(value);
  diagnose(value.diagnostic, result);
  return result;
}

/** Commit the profile and exported state together. Keep backups until every promotion succeeds. */
export async function commitLoginSession(staged: string | null, target: string | null, sessionFile: string | null,
  serializedState: string, move: typeof rename = rename): Promise<void> {
  const suffix = randomUUID();
  const previousProfile = target ? `${target}.previous-${suffix}` : null;
  const previousState = sessionFile ? `${sessionFile}.previous-${suffix}` : null;
  const pendingState = sessionFile ? `${sessionFile}.${suffix}.tmp` : null;
  let profileBackedUp = false, stateBackedUp = false, profilePromoted = false, statePromoted = false;
  let committed = false;
  try {
    // Recheck before promotion in case the user opened the original profile while logging in.
    if (staged && target) await assertProfileClosed(target);
    if (sessionFile && pendingState) {
      await mkdir(dirname(sessionFile), { recursive: true, mode: 0o700 });
      try { if (!(await stat(sessionFile)).isFile()) throw new Error("SESSION_FILE_INVALID"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await writeFile(pendingState, serializedState, { mode: 0o600, flag: "wx" });
      await chmod(pendingState, 0o600);
    }
    if (staged && target && previousProfile) {
      try { await move(target, previousProfile); profileBackedUp = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await move(staged, target); profilePromoted = true;
    }
    if (sessionFile && previousState && pendingState) {
      try { await move(sessionFile, previousState); stateBackedUp = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await move(pendingState, sessionFile); statePromoted = true;
    }
    committed = true;
  } catch (error) {
    // A rejected save must leave both previous representations usable.
    if (statePromoted && sessionFile) await rm(sessionFile, { force: true });
    if (stateBackedUp && previousState && sessionFile) await rename(previousState, sessionFile);
    if (profilePromoted && target) await rm(target, { recursive: true, force: true });
    if (profileBackedUp && previousProfile && target) await rename(previousProfile, target);
    throw error;
  } finally {
    if (pendingState) await rm(pendingState, { force: true }).catch(() => undefined);
    // Cleanup after a successful commit cannot turn that success into a false failure.
    if (committed && previousProfile && profileBackedUp) await rm(previousProfile, { recursive: true, force: true }).catch(() => undefined);
    if (committed && previousState && stateBackedUp) await rm(previousState, { force: true }).catch(() => undefined);
  }
}

export async function commitLoginProfile(staged: string, target: string): Promise<void> {
  await commitLoginSession(staged, target, null, "");
}
