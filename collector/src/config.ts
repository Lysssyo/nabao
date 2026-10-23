import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

/** Local development only; process/container environment always takes priority. */
export async function loadLocalEnvironment(path = ".env"): Promise<void> {
  try {
    const values = parseEnv(await readFile(path, "utf8"));
    for (const [key, value] of Object.entries(values)) process.env[key] ??= value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read local configuration.");
  }
}
