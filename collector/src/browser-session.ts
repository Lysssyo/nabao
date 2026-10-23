import { chromium, type BrowserContext } from "playwright";
import { mkdir, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

export function sessionDirectory(): string | undefined {
  return process.env.NABAO_BROWSER_PROFILE ? resolve(process.env.NABAO_BROWSER_PROFILE) : undefined;
}

export async function openDedicatedSession(headless: boolean): Promise<BrowserContext> {
  const path = sessionDirectory();
  if (!path) throw new Error("NABAO_BROWSER_PROFILE is required for a dedicated login session.");
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  return chromium.launchPersistentContext(path, {
    headless, locale: "zh-CN", timezoneId: "Asia/Shanghai",
    ...(process.env.NABAO_BROWSER_CHANNEL === "chrome" ? { channel: "chrome" } : {}),
  });
}

/** The user performs ordinary authentication in this isolated profile. */
export async function login(): Promise<void> {
  const context = await openDedicatedSession(false);
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto("https://www.xiaohongshu.com", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await readline.question("请在专用窗口完成正常登录；若出现安全验证由本人处理。完成后按回车保存会话并关闭窗口。\n");
    if (process.env.NABAO_BROWSER_STORAGE_STATE) await saveSession(context);
  } finally { readline.close(); await context.close(); }
}

async function saveSession(context: BrowserContext): Promise<void> {
  const file = process.env.NABAO_BROWSER_STORAGE_STATE;
  if (!file) throw new Error("NABAO_BROWSER_STORAGE_STATE is required.");
  const path = resolve(file);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await context.storageState({ path });
  await chmod(path, 0o600);
}

/** Export only the project-owned session for an explicitly configured runtime. */
export async function exportSession(): Promise<void> {
  const context = await openDedicatedSession(true);
  try { await saveSession(context); }
  finally { await context.close(); }
  console.log("专用会话已保存到配置的私有文件；不要提交或分享该文件。");
}
