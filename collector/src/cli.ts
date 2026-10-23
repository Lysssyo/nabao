import { readFile } from "node:fs/promises";
import { scan, doctor } from "./scan.js";
import { submitReviewed } from "./submit.js";
import { loadLocalEnvironment } from "./config.js";
import { processCapture } from "./pipeline.js";
import { dirname, resolve } from "node:path";
import type { NoteCapture } from "./types.js";
import { login, exportSession } from "./browser-session.js";
import { setTimeout as delay } from "node:timers/promises";
import { updateDailyTable, dailyTableFromReport } from "./daily-table-run.js";
import { runTableWatch, tableRunSucceeded } from "./table-watch.js";

await loadLocalEnvironment();
process.env.NABAO_TABLE_CACHE_DIR ??= resolve(process.env.NABAO_DATA_DIR ?? "data", "table-cache");
const [command, ...args] = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

try {
  if (command === "login") {
    await login();
  } else if (command === "session-export") {
    await exportSession();
  } else if (command === "doctor") {
    console.log(JSON.stringify(await doctor(), null, 2));
  } else if (command === "table" || command === "table-watch") {
    const intervalMinutes = Number(option("--interval-minutes") ?? "360");
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 60) throw new Error("Watch interval must be at least 60 minutes.");
    const stop = new AbortController();
    const shutdown = () => stop.abort();
    process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
    try {
      const outputDirectory = process.env.NABAO_TABLE_DIRECTORY ?? "../.local/public";
      const dataDirectory = process.env.NABAO_DATA_DIR ?? "data";
      const savedReport = option("--report");
      const last = await runTableWatch({
        run: () => savedReport ? dailyTableFromReport(resolve(savedReport), resolve(outputDirectory))
          : updateDailyTable({ maxNotes: Number(option("--max-notes") ?? "6"), headless: !args.includes("--headed"),
            dataDirectory, outputDirectory }),
        statusFile: resolve(dataDirectory, "table-watch", "status.json"),
        intervalMs: intervalMinutes * 60_000, signal: stop.signal, once: command === "table",
        onResult: (result) => console.log(JSON.stringify(result, null, 2)),
        onAlert: (status) => console.error(JSON.stringify({ event: "TABLE_COLLECTION_ATTENTION", ...status })),
      });
      if (command === "table" && last) process.exitCode = tableRunSucceeded(last.status) ? 0 : 2;
    } finally { process.removeListener("SIGINT", shutdown); process.removeListener("SIGTERM", shutdown); }
  } else if (command === "scan" || command === "watch") {
    const scanOptions = {
      sourceId: option("--source"),
      maxNotes: Number(option("--max-notes") ?? "6"),
      headless: !args.includes("--headed"),
      dataDirectory: process.env.NABAO_DATA_DIR ?? "data",
      knownNotesOnly: args.includes("--known-notes"),
    };
    const intervalMinutes = Number(option("--interval-minutes") ?? "360");
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 60) throw new Error("Watch interval must be at least 60 minutes.");
    const stop = new AbortController();
    const shutdown = () => stop.abort();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    try {
      do {
        const result = await scan(scanOptions);
        console.log(JSON.stringify(result, null, 2));
        if (command === "scan") {
          process.exitCode = result.status === "blocked" ? 3 : result.status === "partial" ? 2 : 0;
          break;
        }
        // No fast retries for restrictions or incomplete extraction.
        if (!stop.signal.aborted) await delay(intervalMinutes * 60_000, undefined, { signal: stop.signal }).catch(() => undefined);
      } while (!stop.signal.aborted);
    } finally {
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
    }
  } else if (command === "process") {
    const file = option("--capture");
    if (!file) throw new Error("process requires --capture path/to/capture.json.");
    const capture = JSON.parse(await readFile(file, "utf8")) as NoteCapture;
    const result = await processCapture(capture, dirname(resolve(file)), resolve(process.env.NABAO_DATA_DIR ?? "data"));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "published" ? 0 : 2;
  } else if (command === "submit") {
    const file = option("--file");
    if (!file) throw new Error("submit requires --file with a manually reviewed observation batch. This is a diagnostic command, not the daily workflow.");
    const input: unknown = JSON.parse(await readFile(file, "utf8"));
    console.log(JSON.stringify(await submitReviewed(input), null, 2));
  } else {
    console.log("Usage: doctor | login | session-export | table [--max-notes 1..20] [--headed] [--report report.json] | table-watch [--interval-minutes 360] | scan [--source ID] [--max-notes 1..20] [--headed] [--known-notes] | watch [--interval-minutes 360] | process --capture path/capture.json | submit --file path.json");
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Collector failed.");
  process.exitCode = 1;
}
