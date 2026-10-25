import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProcessLock } from "../src/process-lock.js";

async function directory(t: import("node:test").TestContext) {
  const path = await mkdtemp(join(tmpdir(), "nabao-process-lock-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

async function worker(t: import("node:test").TestContext, path: string) {
  const script = `import { acquireProcessLock } from ${JSON.stringify(new URL("../src/process-lock.js", import.meta.url).href)};
    try {
      await acquireProcessLock(process.argv[1], "BUSY");
      console.log("ACQUIRED"); setInterval(() => {}, 1000);
    } catch (error) { console.log(error.message === "BUSY" ? "BUSY" : "ERROR:" + (error.code ?? error.name)); }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, path], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => stop(child));
  const result = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Lock worker timed out")), 10_000);
    let stdout = "";
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.stdout!.on("data", (data) => {
      stdout += String(data);
      if (stdout.includes("\n")) { clearTimeout(timeout); resolve(stdout.trim()); }
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      if (!stdout.includes("\n")) reject(new Error("Lock worker exited without a result"));
    });
  });
  return { child, result };
}

test("live owners exclude other processes and release only removes its own generation", async (t) => {
  const path = join(await directory(t), "job.lock");
  const first = await acquireProcessLock(path, "BUSY");
  assert.equal((await stat(path)).mode & 0o777, 0o700);
  const [marker] = await readdir(path);
  assert.equal((await stat(join(path, marker!))).mode & 0o777, 0o600);
  assert.equal((await worker(t, path)).result, "BUSY");
  await first.release();
  const second = await acquireProcessLock(path, "BUSY");
  await first.release();
  await assert.rejects(acquireProcessLock(path, "BUSY"), /^Error: BUSY$/);
  await second.release();
  await assert.rejects(stat(path), { code: "ENOENT" });
});

test("a killed process leaves an identifiable lock that the next attempt recovers", async (t) => {
  const path = join(await directory(t), "job.lock");
  const original = await worker(t, path);
  assert.equal(original.result, "ACQUIRED");
  await stop(original.child);
  const replacement = await acquireProcessLock(path, "BUSY");
  const [marker] = await readdir(path);
  assert.equal(JSON.parse(await readFile(join(path, marker!), "utf8")).pid, process.pid);
  await replacement.release();
});

test("simultaneous recovery cannot remove the winning process's replacement lock", async (t) => {
  const directoryPath = await directory(t);
  for (let round = 0; round < 4; round++) {
    const path = join(directoryPath, `${round}.lock`);
    const original = await worker(t, path);
    assert.equal(original.result, "ACQUIRED");
    await stop(original.child);
    const contenders = await Promise.all([worker(t, path), worker(t, path)]);
    assert.deepEqual(contenders.map((entry) => entry.result).sort(), ["ACQUIRED", "BUSY"]);
    const winner = contenders.find((entry) => entry.result === "ACQUIRED")!;
    await assert.rejects(acquireProcessLock(path, "BUSY"), /^Error: BUSY$/);
    const [marker] = await readdir(path);
    assert.equal(JSON.parse(await readFile(join(path, marker!), "utf8")).pid, winner.child.pid);
    await stop(winner.child);
  }
});

test("foreign namespaces, legacy files and unidentified empty locks stay busy", async (t) => {
  const root = await directory(t);
  const foreign = join(root, "foreign.lock");
  const original = await worker(t, foreign);
  await stop(original.child);
  const [marker] = await readdir(foreign);
  const owner = JSON.parse(await readFile(join(foreign, marker!), "utf8"));
  await writeFile(join(foreign, marker!), JSON.stringify({ ...owner, scope: `${owner.scope}:other-namespace` }));
  const empty = join(root, "empty.lock");
  await mkdir(empty);
  const legacy = join(root, "legacy.lock");
  await writeFile(legacy, "2147483647\n");
  for (const path of [foreign, empty, legacy]) {
    await assert.rejects(acquireProcessLock(path, "BUSY"), /^Error: BUSY$/);
    await stat(path);
  }
});


test("a prior release cannot mutate a replacement paused before its owner marker exists", async (t) => {
  const path = join(await directory(t), "generation.lock");
  const previous = await acquireProcessLock(path, "BUSY");
  await previous.release();
  let created!: () => void, resume!: () => void;
  const atDirectory = new Promise<void>((resolve) => { created = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const acquiring = acquireProcessLock(path, "BUSY", async () => { created(); await gate; });
  await atDirectory;
  // This exact empty-directory window previously allowed path-only ABA cleanup.
  const oldRelease = previous.release();
  await assert.rejects(acquireProcessLock(path, "BUSY"), /^Error: BUSY$/);
  assert.deepEqual(await readdir(path), []);
  assert.ok((await stat(`${path}.guard`)).isDirectory());
  resume();
  const replacement = await acquiring;
  await oldRelease;
  await previous.release();
  const [marker] = await readdir(path);
  assert.ok(marker?.startsWith("owner-"));
  await assert.rejects(acquireProcessLock(path, "BUSY"), /^Error: BUSY$/);
  await replacement.release();
});

test("failed marker creation holds the mutation guard until cleanup finishes", async (t) => {
  const path = join(await directory(t), "failed.lock");
  let created!: () => void, resume!: () => void;
  const atDirectory = new Promise<void>((resolve) => { created = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const failed = acquireProcessLock(path, "BUSY", async () => { created(); await gate; throw new Error("SIMULATED_MARKER_FAILURE"); });
  const rejected = assert.rejects(failed, /SIMULATED_MARKER_FAILURE/);
  await atDirectory;
  await assert.rejects(acquireProcessLock(path, "BUSY"), /^Error: BUSY$/);
  resume(); await rejected;
  const next = await acquireProcessLock(path, "BUSY");
  const [marker] = await readdir(path);
  assert.ok(marker?.startsWith("owner-"));
  await next.release();
});

test("stale-owner recovery is serialized before a replacement publishes its marker", async (t) => {
  const path = join(await directory(t), "stale.lock");
  const dead = await worker(t, path); assert.equal(dead.result, "ACQUIRED"); await stop(dead.child);
  let created!: () => void, resume!: () => void;
  const atDirectory = new Promise<void>((resolve) => { created = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const recovering = acquireProcessLock(path, "BUSY", async () => { created(); await gate; });
  await atDirectory;
  const contender = await worker(t, path);
  assert.equal(contender.result, "BUSY");
  assert.deepEqual(await readdir(path), []);
  resume(); const recovered = await recovering;
  await assert.rejects(acquireProcessLock(path, "BUSY"), /^Error: BUSY$/);
  await recovered.release();
});

test("an abandoned mutation guard is never guessed safe to remove", async (t) => {
  const path = join(await directory(t), "guarded.lock");
  await mkdir(`${path}.guard`, { mode: 0o700 });
  await assert.rejects(acquireProcessLock(path, "BUSY"), /^Error: BUSY$/);
  assert.ok((await stat(`${path}.guard`)).isDirectory());
});

test("a recovering process killed before marker publication leaves a guard that stays busy", async (t) => {
  const path = join(await directory(t), "recovery-crash.lock");
  const original = await worker(t, path); assert.equal(original.result, "ACQUIRED"); await stop(original.child);
  const script = `import { acquireProcessLock } from ${JSON.stringify(new URL("../src/process-lock.js", import.meta.url).href)};
    await acquireProcessLock(process.argv[1], "BUSY", async () => {
      console.log("RECOVERED_DIRECTORY_READY"); setInterval(() => {}, 1000); await new Promise(() => {});
    });`;
  const recovering = spawn(process.execPath, ["--input-type=module", "-e", script, path], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => stop(recovering));
  const [chunk] = await once(recovering.stdout!, "data", { signal: AbortSignal.timeout(10_000) });
  assert.equal(String(chunk).trim(), "RECOVERED_DIRECTORY_READY");
  assert.deepEqual(await readdir(path), []);
  await stop(recovering);
  assert.ok((await stat(`${path}.guard`)).isDirectory());
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(acquireProcessLock(path, "BUSY"), /^Error: BUSY$/);
  assert.deepEqual(await readdir(path), []);
  assert.ok((await stat(`${path}.guard`)).isDirectory());
});
