import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, readdir, readlink, rmdir, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

interface Owner { version: 1; pid: number; token: string; scope: string | null }
const ownerName = /^owner-([0-9a-f-]{36})\.json$/;
let scopePromise: Promise<string | null> | undefined;

function processScope(): Promise<string | null> {
  return scopePromise ??= (async () => {
    try {
      // PIDs from a shared volume's other host/container must never be tested locally.
      if (process.platform === "linux") {
        const [boot, namespace] = await Promise.all([
          readFile("/proc/sys/kernel/random/boot_id", "utf8"), readlink("/proc/self/ns/pid"),
        ]);
        return `linux:${hostname()}:${boot.trim()}:${namespace}`;
      }
      if (process.platform === "darwin") {
        const { stdout } = await promisify(execFile)("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]);
        return stdout.trim() ? `darwin:${hostname()}:${stdout.trim()}` : null;
      }
    } catch { /* Unsupported or unavailable identity makes stale recovery unsafe. */ }
    return null;
  })();
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }

async function removeOwner(path: string, marker: string): Promise<boolean> {
  try { await unlink(join(path, marker)); }
  catch (error) { if (missing(error)) return false; throw error; }
  // Only the winner deleting this unique marker may remove the empty directory.
  // A competing recovery/release cannot delete a later owner's different marker.
  try { await rmdir(path); }
  catch (error) {
    if (!missing(error) && !["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  return true;
}

async function recoverDeadOwner(path: string, scope: string | null): Promise<boolean> {
  if (!scope) return false;
  try {
    const entries = await readdir(path);
    if (entries.length !== 1 || !ownerName.test(entries[0]!)) return false;
    const marker = entries[0]!;
    const owner = JSON.parse(await readFile(join(path, marker), "utf8")) as Owner;
    if (owner.version !== 1 || owner.scope !== scope || marker !== `owner-${owner.token}.json`
      || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
    return await removeOwner(path, marker);
  } catch (error) {
    if (missing(error)) return true; // A competing release/recovery already made progress.
    return false; // Legacy, malformed and foreign locks require inspection, not guessing.
  }
}

/** Serializes every generation-changing filesystem operation, including stale recovery and release.
 * A process killed while this short critical section is held leaves a guard requiring inspection;
 * an unidentifiable guard is deliberately never reclaimed by path alone.
 */
async function mutationGuard(path: string, busyCode: string, wait = false): Promise<{ release(): Promise<void> }> {
  const guard = `${path}.guard`;
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(guard, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!wait || attempt >= 100) throw new Error(busyCode);
      await delay(10);
    }
  }
  return { release: () => rmdir(guard) };
}

/** Single-host process lock. Only a positively identified dead owner is reclaimed.
 * Empty/legacy locks and locks from another boot or PID namespace remain busy.
 * afterCreate is an optional fault-injection seam for deterministic lock lifecycle tests.
 */
export async function acquireProcessLock(path: string, busyCode: string,
  afterCreate?: () => Promise<void>): Promise<{ release(): Promise<void> }> {
  const guard = await mutationGuard(path, busyCode);
  try {
    const owner: Owner = { version: 1, pid: process.pid, token: randomUUID(), scope: await processScope() };
    const marker = `owner-${owner.token}.json`;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { await mkdir(path, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await recoverDeadOwner(path, owner.scope)) continue;
        throw new Error(busyCode);
      }
      try {
        await afterCreate?.();
        const handle = await open(join(path, marker), "wx", 0o600);
        try { await handle.writeFile(`${JSON.stringify(owner)}\n`); await handle.sync(); }
        finally { await handle.close(); }
      } catch (error) {
        if (!await removeOwner(path, marker)) {
          // The mutation guard prevents a later generation from appearing during cleanup.
          try { await rmdir(path); }
          catch (cleanup) {
            if (!missing(cleanup) && !["ENOTEMPTY", "EEXIST"].includes((cleanup as NodeJS.ErrnoException).code ?? "")) throw cleanup;
          }
        }
        throw error;
      }
      return { release: async () => {
        const releaseGuard = await mutationGuard(path, busyCode, true);
        try { await removeOwner(path, marker); }
        finally { await releaseGuard.release(); }
      } };
    }
    throw new Error(busyCode);
  } finally { await guard.release(); }
}
