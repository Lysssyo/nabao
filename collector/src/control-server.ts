import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { CollectorControl } from "./collector-control.js";
import { ControlError } from "./control-types.js";

function authenticated(request: IncomingMessage, key: string): boolean {
  const supplied = request.headers["x-internal-key"];
  return typeof supplied === "string" && timingSafeEqual(createHash("sha256").update(key).digest(), createHash("sha256").update(supplied).digest());
}
async function emptyBody(request: IncomingMessage): Promise<void> {
  let body = "";
  for await (const data of request) {
    body += data.toString();
    if (Buffer.byteLength(body) > 1024) throw new ControlError(413, "请求内容过大。");
  }
  if (!body.trim()) return;
  try {
    const value: unknown = JSON.parse(body);
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return;
  } catch { /* Never reflect request contents. */ }
  throw new ControlError(400, "此操作不接受参数。");
}
async function authorBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const data of request) {
    const chunk = Buffer.from(data);
    bytes += chunk.length;
    if (bytes > 8192) throw new ControlError(413, "请求内容过大。");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ControlError(400, "请提供有效的作者昵称和主页链接。"); }
}
function respond(response: ServerResponse, status: number, value: unknown, type = "application/json; charset=utf-8") {
  response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(Buffer.isBuffer(value) ? value : JSON.stringify(value));
}

export function controlServer(control: CollectorControl, key: string) {
  if (key.length < 16) throw new Error("CONTROL_KEY_REQUIRED");
  const server = createServer(async (request, response) => {
    try {
      if (!authenticated(request, key)) throw new ControlError(401, "采集服务认证失败。");
      // The closed route set accepts only author profile metadata, never commands or file paths.
      const path = request.url;
      if (request.method === "GET" && path === "/status") return respond(response, 200, control.status());
      if (request.method === "GET" && path === "/login/preview") return respond(response, 200, await control.preview(), "image/png");
      if (!["POST", "DELETE"].includes(request.method ?? "")) throw new ControlError(404, "未找到此操作。");
      if (request.method === "POST" && path === "/authors") return respond(response, 200, await control.addAuthor(await authorBody(request)));
      await emptyBody(request);
      if (request.method === "DELETE" && path?.startsWith("/authors/")) return respond(response, 200, await control.removeAuthor(path.slice("/authors/".length)));
      if (request.method === "POST" && path === "/runs") return respond(response, 202, await control.startRun());
      if (request.method === "POST" && path === "/login") return respond(response, 202, control.startLogin());
      if (request.method === "POST" && path === "/login/complete") return respond(response, 200, await control.completeLogin());
      if (request.method === "DELETE" && path === "/login") return respond(response, 200, await control.cancelLogin());
      if (request.method === "POST" && path === "/session/check") return respond(response, 202, control.checkSession());
      throw new ControlError(404, "未找到此操作。");
    } catch (error) {
      const known = error instanceof ControlError;
      const status = known ? error.status : 503;
      respond(response, status, { status, detail: known ? error.message : "采集服务暂时不可用。" }, "application/problem+json; charset=utf-8");
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

export async function serveCollectorControl(): Promise<void> {
  const dataDirectory = resolve(process.env.NABAO_DATA_DIR ?? "data");
  const outputDirectory = resolve(process.env.NABAO_TABLE_DIRECTORY ?? "../.local/public");
  if (!process.env.NABAO_BROWSER_PROFILE && !process.env.NABAO_BROWSER_STORAGE_STATE)
    process.env.NABAO_BROWSER_PROFILE = resolve(dataDirectory, "browser-profile");
  process.env.NABAO_BROWSER_STORAGE_STATE ??= resolve(dataDirectory, "browser-session.json");
  const key = process.env.NABAO_CONTROL_KEY ?? process.env.NABAO_INTERNAL_KEY ?? "";
  const host = process.env.NABAO_CONTROL_HOST ?? "127.0.0.1";
  const port = Number(process.env.NABAO_CONTROL_PORT ?? "18082");
  if (!["127.0.0.1", "0.0.0.0", "::1"].includes(host) || !Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("CONTROL_LISTEN_INVALID");
  const control = new CollectorControl({ dataDirectory, outputDirectory,
    scheduleEnabled: process.env.NABAO_CONTROL_SCHEDULE_ENABLED !== "false",
    intervalMinutes: Number(process.env.NABAO_CONTROL_INTERVAL_MINUTES ?? "360"),
    headless: process.env.NABAO_CONTROL_HEADLESS !== "false",
    loginHeadless: (process.env.NABAO_LOGIN_HEADLESS ?? process.env.NABAO_CONTROL_HEADLESS) !== "false" });
  const server = controlServer(control, key);
  await control.start();
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject); server.listen(port, host, () => { server.removeListener("error", reject); resolveListen(); });
    });
  } catch { await control.stop(); throw new Error("CONTROL_LISTEN_FAILED"); }
  console.log(JSON.stringify({ service: "collector-control", host, port, status: "ready" }));
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    server.close(); server.closeAllConnections();
    try { await control.stop(); } finally { process.exit(0); }
  };
  process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
}
