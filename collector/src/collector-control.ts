import { flushVoteAudits } from "./vote-audit.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { acquireProcessLock } from "./process-lock.js";
import { writeJson } from "./storage.js";
import { acquireAuthorLease, addAuthor, AuthorConfigError, loadAuthorConfig, removeAuthor, requireVotingAuthors,
  type AuthorConfig, type AuthorLease } from "./author-store.js";
import { updateDailyTable } from "./daily-table-run.js";
import { runTableWatch, type TableWatchStatus } from "./table-watch.js";
import { openLoginBrowser, type LoginBrowser } from "./control-login.js";
import { ControlError, type ControlStatus, type RunState } from "./control-types.js";
import { loginDiagnostic } from "./login-errors.js";

export interface ControlOptions {
  dataDirectory: string; outputDirectory: string; scheduleEnabled: boolean; intervalMinutes: number;
  headless: boolean; loginHeadless?: boolean; loginTimeoutMs?: number;
}
interface Dependencies {
  run?: (lease: AuthorLease) => Promise<TableWatchStatus | null>;
  browser?: (mode: "login" | "check") => Promise<LoginBrowser>;
}
const idleLogin: ControlStatus["login"] = { status: "idle", startedAt: null, expiresAt: null,
  verifiedAt: null, message: "登录采集账号后，会话保存在此服务器。", previewAvailable: false };
const runMessages: Record<string, string> = {
  published: "采集完成，已发布最新投票结果。", unchanged: "检查完成，投票结果未变化。",
  "no-change": "检查完成，投票结果未变化。",
  partial: "采集完成，已按投票规则更新额度。未形成结果的字段保持待更新。",
  no_new_post: "检查完成，未发现当日新表，保留现有投票结果。",
  older_skipped: "检查完成，保留已发布的较新投票结果。",
  restricted: "小红书要求人工验证，请在登录入口处理后再采集。",
  session_expired: "小红书会话已失效，请重新登录后采集。",
  failed: "采集未完成，保留现有投票结果。请检查采集配置或重新登录。",
};
const safeResults = new Set(Object.keys(runMessages));

export class CollectorControl {
  private operation: "run" | "login" | "check" | "authors" | null = null;
  private authorConfig: AuthorConfig | null = null;
  private runState: RunState | null = null;
  private session: ControlStatus["session"] = { status: "unchecked", checkedAt: null, message: "尚未检查已保存会话。" };
  private login: ControlStatus["login"] = { ...idleLogin };
  private browser: LoginBrowser | null = null;
  private restrictedPreview: Buffer | null = null;
  private browserLock: { release(): Promise<void> } | null = null;
  private daemonLock: { release(): Promise<void> } | null = null;
  private scheduleTimer?: NodeJS.Timeout;
  private loginTimer?: NodeJS.Timeout;
  private nextRunAt: string | null = null;
  private closing = false;
  private accessRestricted = false;
  private verifying = false;
  private task: Promise<void> | null = null;
  private readonly stateFile: string;
  private readonly run: (lease: AuthorLease) => Promise<TableWatchStatus | null>;
  private readonly openBrowser: (mode: "login" | "check") => Promise<LoginBrowser>;
  private browserClosing: Promise<void> | null = null;

  constructor(private readonly options: ControlOptions, dependencies: Dependencies = {}) {
    if (!Number.isSafeInteger(options.intervalMinutes) || options.intervalMinutes < 60 || options.intervalMinutes > 10080)
      throw new Error("CONTROL_INTERVAL_INVALID");
    this.stateFile = join(options.dataDirectory, "control", "status.json");
    this.openBrowser = dependencies.browser ?? ((mode) => openLoginBrowser(
      mode === "login" ? options.loginHeadless ?? options.headless : options.headless, mode));
    this.run = dependencies.run ?? ((authorLease) => runTableWatch({
      run: () => updateDailyTable({ maxNotes: 6, headless: options.headless,
        dataDirectory: options.dataDirectory, outputDirectory: options.outputDirectory, authorLease }),
      statusFile: join(options.dataDirectory, "table-watch", "status.json"),
      managementFiles: { statusFile: resolve(process.env.NABAO_STATUS_FILE?.trim()
        || resolve(options.outputDirectory, "..", "status", "daily-table.json")), tableFile: join(options.outputDirectory, "latest.json") },
      intervalMs: options.intervalMinutes * 60_000, signal: new AbortController().signal, once: true,
      managementAuthors: () => authorLease.config.authors,
    }));
  }

  async start(): Promise<void> {
    await mkdir(join(this.options.dataDirectory, "control"), { recursive: true, mode: 0o700 });
    this.daemonLock = await acquireProcessLock(join(this.options.dataDirectory, "control", ".service.lock"), "CONTROL_BUSY");
    try {
      this.authorConfig = await loadAuthorConfig(this.options.dataDirectory);
      try {
        const saved = JSON.parse(await readFile(this.stateFile, "utf8")) as { run?: RunState; accessRestricted?: boolean };
        if (saved.accessRestricted === true) {
          this.accessRestricted = true;
          const message = "上次检查发现小红书访问受限，自动采集保持暂停。请由本人处理平台提示后手动检查登录。";
          this.session = { status: "restricted", checkedAt: null, message };
          this.login = { ...idleLogin, status: "restricted", message };
        }
        const run = saved.run;
        if (run && typeof run.id === "string" && /^[0-9a-f-]{36}$/.test(run.id)
          && ["manual", "scheduled"].includes(run.trigger) && Number.isFinite(Date.parse(run.startedAt))) {
          const interrupted = run.status === "running" || run.status === "interrupted";
          this.runState = { id: run.id, trigger: run.trigger, startedAt: run.startedAt,
            status: interrupted ? "interrupted" : run.status === "completed" ? "completed" : "failed",
            finishedAt: typeof run.finishedAt === "string" && Number.isFinite(Date.parse(run.finishedAt)) ? run.finishedAt : null,
            result: run.result && safeResults.has(run.result) ? run.result : null, errorCode: null,
            message: interrupted ? "上次采集因服务重启中断，现有投票结果已保留。"
              : runMessages[run.result ?? ""] ?? runMessages.failed! };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("CONTROL_STATE_INVALID");
      }
      await this.persist();
      await flushVoteAudits(this.options.dataDirectory);
      this.scheduleNext();
    } catch (error) { await this.daemonLock.release(); this.daemonLock = null; throw error; }
  }

  status(): ControlStatus {
    return { available: true, busy: this.operation !== null, session: { ...this.session },
      run: this.runState && { ...this.runState }, login: { ...this.login },
      schedule: { enabled: this.options.scheduleEnabled && !this.accessRestricted && (this.authorConfig?.authors.length ?? 0) >= 1,
        intervalMinutes: this.options.intervalMinutes, nextRunAt: this.nextRunAt },
      sources: (this.authorConfig?.authors ?? []).map(({ id, name, profileUrl }) => ({ id, name, profileUrl })) };
  }

  async startRun(trigger: "manual" | "scheduled" = "manual"): Promise<ControlStatus> {
    this.requireIdle();
    this.clearRestrictedPreview();
    this.operation = "run";
    let lease: AuthorLease;
    try {
      lease = await acquireAuthorLease(this.options.dataDirectory);
      this.authorConfig = lease.config;
      try { requireVotingAuthors(lease.config); }
      catch (error) { await lease.release(); throw error; }
    } catch (error) { this.operation = null; this.scheduleNext(); throw this.authorError(error); }
    this.runState = { id: randomUUID(), trigger, status: "running", startedAt: new Date().toISOString(),
      finishedAt: null, result: null, errorCode: null, message: `正在采集 ${lease.config.authors.length} 位作者并计算额度投票，请稍候。` };
    try { await this.persist(); }
    catch { await lease.release(); this.operation = null; this.runState.status = "failed"; throw new ControlError(503, "无法保存采集任务，请检查服务存储。 "); }
    this.task = this.executeRun(lease);
    return this.status();
  }

  private async executeRun(lease: AuthorLease): Promise<void> {
    try {
      const result = await this.run(lease);
      if (this.closing || !this.runState) return;
      const outcome = result && safeResults.has(result.status) ? result.status : "failed";
      this.runState = { ...this.runState, status: ["failed", "restricted", "session_expired"].includes(outcome) ? "failed" : "completed",
        result: outcome, finishedAt: new Date().toISOString(), message: result?.errorCode === "TABLE_NO_QUORUM" ? "检查完成，本轮未形成新投票结果，保留现有额度表。" : runMessages[outcome]!,
        // Only codes produced by the existing sanitized watch layer can reach the controller.
        errorCode: result?.errorCode && /^[A-Z][A-Z_]{1,60}$/.test(result.errorCode) ? result.errorCode : null };
      if (outcome === "restricted") {
        this.accessRestricted = true;
        this.session = { status: "restricted", checkedAt: new Date().toISOString(),
          message: "小红书访问受限，自动采集已暂停。请由本人处理平台提示后手动检查登录。" };
      }
      if (outcome === "session_expired") this.session = { status: "expired", checkedAt: new Date().toISOString(), message: runMessages.session_expired! };
    } catch {
      if (this.closing || !this.runState) return;
      this.runState = { ...this.runState, status: "failed", finishedAt: new Date().toISOString(),
        result: "failed", errorCode: "TABLE_RUN_FAILED", message: runMessages.failed! };
    } finally {
      await lease.release();
      if (!this.closing) {
        await this.persist().catch(() => undefined);
        this.operation = null;
        this.scheduleNext();
      }
    }
  }

  async addAuthor(input: unknown): Promise<ControlStatus> {
    return this.editAuthors(() => addAuthor(this.options.dataDirectory, input));
  }
  async removeAuthor(id: string): Promise<ControlStatus> {
    return this.editAuthors(() => removeAuthor(this.options.dataDirectory, id));
  }
  private async editAuthors(write: () => Promise<AuthorConfig>): Promise<ControlStatus> {
    this.requireIdle(); this.operation = "authors";
    const task = (async () => {
      try { this.authorConfig = await write(); }
      catch (error) { throw this.authorError(error); }
      finally { this.operation = null; this.scheduleNext(); }
    })();
    this.task = task;
    await task;
    return this.status();
  }
  private authorError(error: unknown): ControlError {
    const code = error instanceof AuthorConfigError ? error.code : error instanceof Error ? error.message : "";
    if (code === "AUTHOR_CONFIG_BUSY") return new ControlError(409, "采集或作者配置正在使用中，请完成后再试。");
    if (code === "AUTHOR_DUPLICATE") return new ControlError(409, "此作者已在采集列表中。");
    if (code === "AUTHOR_NOT_FOUND") return new ControlError(404, "此作者不在采集列表中。");
    if (code === "AUTHOR_INVALID") return new ControlError(400, "请填写 1–80 字昵称和有效的小红书作者主页链接。");
    if (code === "AUTHOR_LIMIT") return new ControlError(400, "最多可添加 50 位采集作者。");
    if (code === "AUTHORS_REQUIRED") return new ControlError(409, "至少添加一位作者后才能采集并形成投票结果。");
    return new ControlError(503, "无法读取或保存作者配置，请检查采集服务存储。");
  }

  startLogin(): ControlStatus {
    this.requireIdle();
    this.clearRestrictedPreview();
    this.operation = "login";
    this.login = { ...idleLogin, status: "starting", startedAt: new Date().toISOString(), message: "正在打开小红书登录页面。" };
    this.task = this.prepareLogin().catch(() => this.browserFailure());
    return this.status();
  }

  private async prepareLogin(): Promise<void> {
    try {
      this.browserLock = await acquireProcessLock(join(this.options.dataDirectory, "scan.lock"), "SCAN_BUSY");
      this.browser = await this.openBrowser("login");
      if (this.closing) return;
      const state = await this.browser.prepare();
      if (state === "restricted") { await this.reportRestriction(); return; }
      if (state === "authenticated") { await this.saveVerifiedLogin(); return; }
      const manualBrowser = state !== "qr_ready" && !(this.options.loginHeadless ?? this.options.headless);
      if (state !== "qr_ready" && !manualBrowser) {
        this.login = { ...this.login, status: "failed", previewAvailable: false,
          message: "小红书页面没有显示可用登录二维码，请检查页面或使用专用浏览器完成登录。" };
        await this.closeBrowser(); this.operation = null; return;
      }
      const timeout = this.options.loginTimeoutMs ?? 10 * 60_000;
      this.login = { ...this.login, status: manualBrowser ? "waiting_browser" : "waiting", expiresAt: new Date(Date.now() + timeout).toISOString(),
        previewAvailable: true, message: manualBrowser
          ? "专用浏览器已打开，请在运行采集服务的 Mac 上按小红书页面提示完成登录，再点击已完成登录。本次尚未识别到可用二维码或已登录账号。"
          : "请用本人小红书 App 扫码并确认，然后点击已完成登录。二维码失效可取消后重新登录；安全验证需本人完成。" };
      this.loginTimer = setTimeout(() => { void this.expireLogin().catch(() => this.browserFailure()); }, timeout);
    } catch (error) {
      this.login = { ...this.login, status: "failed", previewAvailable: false,
        message: loginDiagnostic(error).message };
      await this.closeBrowser();
      this.operation = null;
    } finally { if (this.closing) await this.closeBrowser(); }
  }

  async completeLogin(): Promise<ControlStatus> {
    if (this.operation !== "login" || !["waiting", "waiting_browser"].includes(this.login.status) || !this.browser || this.verifying)
      throw new ControlError(409, "当前没有可确认的登录页面，请等待页面打开或重新登录。");
    this.verifying = true;
    try {
      const state = await this.browser.verify();
      if (state === "restricted") { await this.reportRestriction(); return this.status(); }
      if (state !== "authenticated") {
        const prepared = await this.browser.prepare();
        if (prepared === "restricted") { await this.reportRestriction(); return this.status(); }
        if (prepared !== "authenticated")
          throw new ControlError(409, "尚未检测到已登录账号，请完成扫码确认；若有安全验证请本人完成。");
      }
      await this.saveVerifiedLogin();
      return this.status();
    } catch (error) {
      if (error instanceof ControlError) throw error;
      this.login = { ...this.login, status: "failed", previewAvailable: false,
        message: loginDiagnostic(error).message };
      try { await this.closeBrowser(); this.operation = null; } catch { this.browserFailure(); }
      throw new ControlError(503, loginDiagnostic(error).message);
    } finally { this.verifying = false; }
  }

  private async saveVerifiedLogin(): Promise<void> {
    if (!this.browser) throw new Error("LOGIN_BROWSER_MISSING");
    await this.browser.save();
    const now = new Date().toISOString();
    const wasRestricted = this.accessRestricted;
    this.accessRestricted = false;
    try { await this.persist(); }
    catch (error) { this.accessRestricted = wasRestricted; throw error; }
    this.session = { status: "authenticated", checkedAt: now, message: "已确认登录，采集将复用服务器保存的会话。" };
    this.login = { ...this.login, status: "authenticated", verifiedAt: now, expiresAt: null,
      previewAvailable: false, message: "登录成功，已保存并复用采集会话。" };
    await this.closeBrowser();
    this.operation = null;
    this.scheduleNext();
  }

  async cancelLogin(): Promise<ControlStatus> {
    if (this.verifying || this.login.status === "starting") throw new ControlError(409, "登录页面正在处理中，请稍后再试。");
    if (this.operation !== "login") throw new ControlError(409, "当前没有进行中的登录。");
    this.verifying = true;
    try {
      await this.closeBrowser();
      this.operation = null;
      this.login = { ...this.login, status: "cancelled", previewAvailable: false, message: "本次登录已取消。" };
      return this.status();
    } catch {
      this.browserFailure();
      throw new ControlError(503, "浏览器关闭失败，请重启采集服务。");
    } finally { this.verifying = false; }
  }

  async preview(): Promise<Buffer> {
    if (this.login.status === "restricted" && this.restrictedPreview) return Buffer.from(this.restrictedPreview);
    if (this.operation !== "login" || !["waiting", "waiting_browser"].includes(this.login.status) || !this.browser || this.verifying)
      throw new ControlError(409, "登录预览尚未就绪。");
    try { return await this.browser.preview(); }
    catch { throw new ControlError(503, "无法加载登录预览，请稍后重试。"); }
  }

  checkSession(): ControlStatus {
    this.requireIdle(); this.clearRestrictedPreview(); this.operation = "check";
    this.session = { status: "checking", checkedAt: null, message: "正在通过小红书页面检查已保存会话。" };
    this.task = this.executeSessionCheck().catch(() => this.browserFailure());
    return this.status();
  }

  private async executeSessionCheck(): Promise<void> {
    try {
      this.browserLock = await acquireProcessLock(join(this.options.dataDirectory, "scan.lock"), "SCAN_BUSY");
      this.browser = await this.openBrowser("check");
      if (this.closing) return;
      const state = await this.browser.verify();
      if (state === "restricted") { await this.reportRestriction(); return; }
      if (state === "authenticated") {
        this.accessRestricted = false;
        if (this.login.status === "restricted") this.login = { ...idleLogin };
      }
      this.session = { status: state === "authenticated" ? "authenticated" : state === "login_required" || state === "qr_ready" ? "expired" : "failed",
        checkedAt: new Date().toISOString(), message: state === "authenticated" ? "已确认当前会话登录有效。"
          : state === "login_required" || state === "qr_ready" ? "小红书页面要求登录，请登录采集账号。"
          : "小红书页面未能加载会话信息，本次无法检查登录状态。" };
    } catch (error) {
      this.session = { status: "failed", checkedAt: new Date().toISOString(), message: loginDiagnostic(error).message };
    } finally {
      await this.persist().catch(() => undefined);
      await this.closeBrowser(); this.operation = null; this.scheduleNext();
    }
  }

  private clearRestrictedPreview(): void {
    this.restrictedPreview = null;
    if (this.login.status === "restricted") this.login = { ...this.login, previewAvailable: false };
  }
  private async reportRestriction(): Promise<void> {
    const message = "小红书访问受限（安全限制或 IP 风险），未生成可用登录二维码。自动采集已暂停，请由本人处理平台提示后再手动检查登录；系统不会自动重试或绕过验证。";
    this.accessRestricted = true;
    this.scheduleNext();
    await this.persist();
    const preview = await this.browser?.preview().catch(() => null);
    this.restrictedPreview = preview && preview.length <= 2 * 1024 * 1024 ? Buffer.from(preview) : null;
    this.session = { status: "restricted", checkedAt: new Date().toISOString(), message };
    this.login = { ...this.login, status: "restricted", previewAvailable: this.restrictedPreview !== null,
      expiresAt: null, message };
    await this.closeBrowser();
    this.operation = null;
  }
  private requireIdle() {
    if (this.closing) throw new ControlError(503, "采集服务正在停止。");
    if (this.operation) throw new ControlError(409, "已有采集或登录任务正在执行，请等待完成。");
  }
  private closeBrowser(): Promise<void> {
    if (this.browserClosing) return this.browserClosing;
    clearTimeout(this.loginTimer);
    const browser = this.browser;
    const lock = this.browserLock;
    this.browser = null;
    this.browserLock = null;
    this.browserClosing = (async () => {
      await browser?.close();
      await lock?.release();
    })().then(() => { this.browserClosing = null; });
    return this.browserClosing;
  }
  private async expireLogin(): Promise<void> {
    if (this.verifying) { this.loginTimer = setTimeout(() => { void this.expireLogin().catch(() => this.browserFailure()); }, 5000); return; }
    if (this.operation !== "login") return;
    this.verifying = true;
    try {
      await this.closeBrowser(); this.operation = null;
      this.login = { ...this.login, status: "expired", previewAvailable: false, message: "登录窗口已超时关闭，请重新登录。" };
    } finally { this.verifying = false; }
  }
  private browserFailure(): void {
    // Stay busy after a failed browser close: releasing the profile lock would let another run collide.
    this.login = { ...this.login, status: "failed", previewAvailable: false, message: "浏览器关闭失败，请重启采集服务后再试。" };
    this.session = { status: "failed", checkedAt: new Date().toISOString(), message: "浏览器处理失败，请重启采集服务。" };
  }
  private scheduleNext() {
    clearTimeout(this.scheduleTimer);
    this.nextRunAt = null;
    if (this.closing || !this.options.scheduleEnabled || this.accessRestricted || (this.authorConfig?.authors.length ?? 0) < 1) return;
    const interval = this.options.intervalMinutes * 60_000;
    this.nextRunAt = new Date(Date.now() + interval).toISOString();
    this.scheduleTimer = setTimeout(() => {
      if (this.operation) { this.scheduleNext(); return; }
      void this.startRun("scheduled").catch(() => this.scheduleNext());
    }, interval);
  }
  private persist() { return writeJson(this.stateFile, { run: this.runState, accessRestricted: this.accessRestricted }); }
  /** Testing and orderly browser shutdown; collection itself is never awaited on a termination signal. */
  async settled(): Promise<void> { await this.task; }
  async stop(): Promise<void> {
    this.closing = true;
    clearTimeout(this.scheduleTimer); clearTimeout(this.loginTimer);
    if (this.runState?.status === "running") {
      this.runState = { ...this.runState, status: "interrupted", finishedAt: new Date().toISOString(),
        message: "采集服务已停止，现有投票结果已保留。" };
      await this.persist().catch(() => undefined);
    }
    if (this.operation === "login" || this.operation === "check" || this.operation === "authors") await this.task?.catch(() => undefined);
    await this.closeBrowser();
    await this.daemonLock?.release(); this.daemonLock = null;
  }
}
