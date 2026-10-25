export type LoginFailurePhase = "PROFILE" | "BROWSER_LAUNCH" | "PAGE_CREATE" | "PAGE_VIEWPORT" | "PAGE_SETUP"
  | "PAGE_NAVIGATION" | "PAGE_READ" | "SAVE";

const networkMessages = {
  ERR_NAME_NOT_RESOLVED: "域名解析失败，请检查 DNS 和当前网络。",
  ERR_CONNECTION_REFUSED: "网站连接被拒绝，请检查当前网络。",
  ERR_CONNECTION_RESET: "网站连接被中断，请检查当前网络。",
  ERR_CONNECTION_CLOSED: "网站提前关闭连接，请检查当前网络。",
  ERR_CONNECTION_TIMED_OUT: "网站连接超时，请检查当前网络。",
  ERR_TIMED_OUT: "网站响应超时，请检查当前网络。",
  ERR_PROXY_CONNECTION_FAILED: "代理连接失败，请检查此 Mac 的代理设置。",
  ERR_TUNNEL_CONNECTION_FAILED: "代理隧道连接失败，请检查此 Mac 的代理设置。",
  ERR_NETWORK_CHANGED: "操作期间网络发生变化，请在网络稳定后手动检查会话。",
  ERR_INTERNET_DISCONNECTED: "当前网络已断开，请连接网络后手动检查会话。",
  ERR_CERT_AUTHORITY_INVALID: "网站证书未通过验证，请检查网络代理与系统证书配置。",
  ERR_CERT_DATE_INVALID: "网站证书日期校验失败，请检查系统时间与当前网络。",
  ERR_CERT_COMMON_NAME_INVALID: "网站证书与域名不匹配，请检查当前网络。",
  ERR_ABORTED: "页面加载被中止，请保持专用浏览器打开后再检查会话。",
} as const;
type LoginFailureDetail = keyof typeof networkMessages | "TIMEOUT" | "BUSY" | "INVALID" | "PERMISSION_DENIED"
  | "NO_SPACE" | "BROWSER_MISSING" | "CLOSED" | "CONTEXT_CHANGED" | "FRAME_DETACHED" | "PROTOCOL_ERROR"
  | "JS_TYPE_ERROR" | "JS_REFERENCE_ERROR" | "JS_SYNTAX_ERROR" | "JS_RANGE_ERROR" | "FAILED";

/** Keep only known classifications. Raw Playwright exceptions may contain URLs and private paths. */
export class LoginBrowserError extends Error {
  readonly code: string;
  readonly detail: LoginFailureDetail;
  constructor(readonly phase: LoginFailurePhase, error: unknown) {
    const message = error instanceof Error ? error.message : "";
    const errno = (error as NodeJS.ErrnoException | undefined)?.code;
    const network = Object.keys(networkMessages).find(code => new RegExp(`\\b${code}\\b`).test(message)) as keyof typeof networkMessages | undefined;
    const detail: LoginFailureDetail = message === "LOGIN_PROFILE_BUSY" || message === "SCAN_BUSY" ? "BUSY"
      : message === "LOGIN_PROFILE_INVALID" ? "INVALID"
      : network ?? (error instanceof Error && error.name === "TimeoutError" ? "TIMEOUT"
        : errno === "EACCES" || errno === "EPERM" ? "PERMISSION_DENIED"
        : errno === "ENOSPC" ? "NO_SPACE"
        : message.includes("Executable doesn't exist") ? "BROWSER_MISSING"
        : /Target page, context or browser has been closed|Target closed|Session closed/.test(message) ? "CLOSED"
        : /Frame was detached|frame was detached|context is not available in detached frame/.test(message) ? "FRAME_DETACHED"
        : /Execution context was destroyed|Cannot find context with specified id/.test(message) ? "CONTEXT_CHANGED"
        : (error instanceof Error && error.name === "TypeError") || /\bTypeError:/.test(message) ? "JS_TYPE_ERROR"
        : (error instanceof Error && error.name === "ReferenceError") || /\bReferenceError:/.test(message) ? "JS_REFERENCE_ERROR"
        : (error instanceof Error && error.name === "SyntaxError") || /\bSyntaxError:/.test(message) ? "JS_SYNTAX_ERROR"
        : (error instanceof Error && error.name === "RangeError") || /\bRangeError:/.test(message) ? "JS_RANGE_ERROR"
        : /Protocol error/.test(message) ? "PROTOCOL_ERROR" : "FAILED");
    const code = `LOGIN_${phase}_${detail}`;
    // Retain the original exception only for an explicit local diagnostic. Error.cause
    // is non-enumerable; public messages and JSON expose only the safe classification.
    super(code, { cause: error });
    this.name = "LoginBrowserError"; this.code = code; this.detail = detail;
  }
}

export const loginFailure = (phase: LoginFailurePhase, error: unknown): LoginBrowserError =>
  error instanceof LoginBrowserError ? error : new LoginBrowserError(phase, error);

export function loginDiagnostic(error: unknown): { code: string; message: string } {
  const known = error instanceof LoginBrowserError ? error
    : error instanceof Error && ["LOGIN_PROFILE_BUSY", "LOGIN_PROFILE_INVALID", "SCAN_BUSY"].includes(error.message)
      ? loginFailure("PROFILE", error) : null;
  if (!known) return { code: "LOGIN_UNKNOWN_FAILED", message: "登录处理失败，请检查浏览器和网络配置。（LOGIN_UNKNOWN_FAILED）" };
  const prefix: Record<LoginFailurePhase, string> = {
    PROFILE: "读取采集会话失败", BROWSER_LAUNCH: "启动专用浏览器失败", PAGE_CREATE: "创建专用浏览器页面失败",
    PAGE_VIEWPORT: "设置登录窗口尺寸失败", PAGE_SETUP: "初始化登录页面失败", PAGE_NAVIGATION: "打开小红书登录页失败",
    PAGE_READ: "读取登录页面状态失败", SAVE: "保存采集会话失败",
  };
  const explanation = known.detail in networkMessages ? networkMessages[known.detail as keyof typeof networkMessages]
    : known.detail === "BUSY" ? "专用浏览器或采集任务正在占用会话，请先关闭对应窗口或等待任务结束。"
    : known.detail === "INVALID" ? "专用浏览器目录配置无效，请检查采集服务配置。"
    : known.detail === "PERMISSION_DENIED" ? "目录或文件没有读写权限，请检查采集服务的文件权限。"
    : known.detail === "NO_SPACE" ? "存储空间不足，请清理磁盘后重试。"
    : known.detail === "BROWSER_MISSING" ? "未找到配置的浏览器，请确认 Chrome 已安装。"
    : known.detail === "CLOSED" ? "专用浏览器已关闭，请保持窗口打开并手动检查会话。"
    : known.detail === "CONTEXT_CHANGED" ? "读取期间页面发生跳转，本次未确认登录状态。请等待页面稳定后再检查。"
    : known.detail === "FRAME_DETACHED" ? "读取期间页面被移除，本次未确认登录状态。请保持专用浏览器打开。"
    : known.detail.startsWith("JS_") ? "登录状态读取脚本执行失败，需检查采集程序的页面适配。"
    : known.detail === "PROTOCOL_ERROR" ? "浏览器控制接口返回错误，请检查 Chrome 与采集程序的兼容性。"
    : known.detail === "TIMEOUT" ? "本次操作超时，请检查浏览器与当前网络后再手动检查会话。"
    : known.phase === "PROFILE" || known.phase === "SAVE" ? "请检查采集服务的存储目录与权限。"
    : known.phase === "BROWSER_LAUNCH" ? "请确认 Chrome 可启动且专用浏览器没有被其他窗口占用。"
    : "请查看专用浏览器的页面提示，并检查当前网络。";
  return { code: known.code, message: `${prefix[known.phase]}：${explanation}（${known.code}）` };
}
