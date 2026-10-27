import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sources as defaultAuthors } from "./sources.js";
import { acquireProcessLock } from "./process-lock.js";
import { writeJson } from "./storage.js";
import type { SourceAuthor } from "./types.js";

export interface AuthorConfig { schemaVersion: 1; revision: number; authors: SourceAuthor[] }
export interface AuthorLease { readonly config: AuthorConfig; release(): Promise<void> }
export class AuthorConfigError extends Error {
  constructor(public readonly code: "AUTHOR_INVALID" | "AUTHOR_DUPLICATE" | "AUTHOR_NOT_FOUND" | "AUTHOR_LIMIT" | "AUTHORS_REQUIRED" | "AUTHOR_CONFIG_INVALID") { super(code); }
}
const activeLeases = new WeakMap<AuthorLease, string>();
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Accept only an ordinary public profile. Never follow short links or caller supplied hosts. */
export function parseAuthor(input: unknown): SourceAuthor {
  if (!record(input) || Object.keys(input).some(key => !["name", "profileUrl"].includes(key))
    || typeof input.name !== "string" || typeof input.profileUrl !== "string") throw new AuthorConfigError("AUTHOR_INVALID");
  const name = input.name.trim(), raw = input.profileUrl.trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name) || raw.length > 2048
    || /[\u0000-\u001f\u007f]/.test(raw) || !/^https:\/\/www\.xiaohongshu\.com\//.test(raw)) throw new AuthorConfigError("AUTHOR_INVALID");
  let url: URL;
  try { url = new URL(raw); } catch { throw new AuthorConfigError("AUTHOR_INVALID"); }
  const match = /^\/user\/profile\/([a-f0-9]{24})\/?$/i.exec(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== "www.xiaohongshu.com" || url.username || url.password || url.port || !match)
    throw new AuthorConfigError("AUTHOR_INVALID");
  const id = match[1]!.toLowerCase();
  return { id, name, profileUrl: `https://www.xiaohongshu.com/user/profile/${id}` };
}

function immutable(config: AuthorConfig): AuthorConfig {
  const copy = structuredClone(config);
  for (const author of copy.authors) {
    if (author.seedNotes) { author.seedNotes.forEach(Object.freeze); Object.freeze(author.seedNotes); }
    Object.freeze(author);
  }
  Object.freeze(copy.authors);
  return Object.freeze(copy);
}
function validatedConfig(value: unknown): AuthorConfig {
  try {
    if (!record(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
      || !Array.isArray(value.authors) || value.authors.length > 50) throw new Error();
    const authors = value.authors.map((entry): SourceAuthor => {
      if (!record(entry)) throw new Error();
      const author = parseAuthor({ name: entry.name, profileUrl: entry.profileUrl });
      if (entry.id !== author.id) throw new Error();
      // Existing reviewed seed notes may survive migration; author CRUD cannot add arbitrary note URLs.
      if (entry.seedNotes !== undefined) {
        const seeds = defaultAuthors.find(source => source.id === author.id)?.seedNotes;
        if (!seeds || JSON.stringify(seeds) !== JSON.stringify(entry.seedNotes)) throw new Error();
        author.seedNotes = structuredClone(seeds);
      }
      return author;
    });
    if (new Set(authors.map(author => author.id)).size !== authors.length) throw new Error();
    return immutable({ schemaVersion: 1, revision: Number(value.revision), authors });
  } catch { throw new AuthorConfigError("AUTHOR_CONFIG_INVALID"); }
}

/** This lease spans capture, extraction and publication, also excluding author edits from other processes. */
export async function acquireAuthorLease(dataDirectory: string): Promise<AuthorLease> {
  const directory = resolve(dataDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = await acquireProcessLock(join(directory, ".author-config.lock"), "AUTHOR_CONFIG_BUSY");
  try {
    const file = join(directory, "author-config.json");
    let config: AuthorConfig;
    try { config = validatedConfig(JSON.parse(await readFile(file, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AuthorConfigError("AUTHOR_CONFIG_INVALID");
      config = immutable({ schemaVersion: 1, revision: 1, authors: defaultAuthors });
      await writeJson(file, config);
    }
    const lease: AuthorLease = { config, release: async () => {
      if (!activeLeases.has(lease)) return;
      await lock.release(); activeLeases.delete(lease);
    } };
    activeLeases.set(lease, directory);
    return Object.freeze(lease);
  } catch (error) { await lock.release(); throw error; }
}

export async function withAuthorLease<T>(dataDirectory: string, work: (lease: AuthorLease) => Promise<T>, existing?: AuthorLease): Promise<T> {
  if (existing) {
    if (activeLeases.get(existing) !== resolve(dataDirectory)) throw new AuthorConfigError("AUTHOR_CONFIG_INVALID");
    return work(existing);
  }
  const lease = await acquireAuthorLease(dataDirectory);
  try { return await work(lease); } finally { await lease.release(); }
}
export async function loadAuthorConfig(dataDirectory: string): Promise<AuthorConfig> {
  // Atomic replacement permits read-only status/daemon startup while a CLI owns the run lease.
  try { return validatedConfig(JSON.parse(await readFile(join(resolve(dataDirectory), "author-config.json"), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AuthorConfigError("AUTHOR_CONFIG_INVALID");
    return withAuthorLease(dataDirectory, async lease => lease.config);
  }
}
export function requireVotingAuthors(config: AuthorConfig): void {
  if (config.authors.length < 1) throw new AuthorConfigError("AUTHORS_REQUIRED");
}
export async function addAuthor(dataDirectory: string, input: unknown): Promise<AuthorConfig> {
  const author = parseAuthor(input);
  return mutate(dataDirectory, config => {
    if (config.authors.some(source => source.id === author.id)) throw new AuthorConfigError("AUTHOR_DUPLICATE");
    if (config.authors.length >= 50) throw new AuthorConfigError("AUTHOR_LIMIT");
    return [...config.authors, author];
  });
}
export async function removeAuthor(dataDirectory: string, id: string): Promise<AuthorConfig> {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new AuthorConfigError("AUTHOR_INVALID");
  return mutate(dataDirectory, config => {
    if (!config.authors.some(source => source.id === id)) throw new AuthorConfigError("AUTHOR_NOT_FOUND");
    return config.authors.filter(source => source.id !== id);
  });
}
async function mutate(dataDirectory: string, change: (config: AuthorConfig) => SourceAuthor[]): Promise<AuthorConfig> {
  return withAuthorLease(dataDirectory, async lease => {
    if (lease.config.revision >= Number.MAX_SAFE_INTEGER) throw new AuthorConfigError("AUTHOR_CONFIG_INVALID");
    const config = immutable({ schemaVersion: 1, revision: lease.config.revision + 1, authors: change(lease.config) });
    await writeJson(join(resolve(dataDirectory), "author-config.json"), config);
    return config;
  });
}
