import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface CollectorState {
  notes: Record<string, {
    revision: string; capturedAt: string; evidenceDirectory: string;
    publishedRevision?: string; publishedPromptVersion?: string; publishedModel?: string;
  }>;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  const encoded = JSON.stringify(value, null, 2);
  if (encoded === undefined) throw new TypeError("A JSON value is required.");
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${encoded}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function loadState(dataDirectory: string): Promise<CollectorState> {
  try {
    const state: unknown = JSON.parse(await readFile(join(dataDirectory, "state.json"), "utf8"));
    if (!state || typeof state !== "object" || !("notes" in state)
      || !state.notes || typeof state.notes !== "object" || Array.isArray(state.notes)) {
      throw new Error("Invalid collector state; preserve the file and inspect it.");
    }
    return state as CollectorState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { notes: {} };
    throw error;
  }
}
