import type { AuthorInput } from './types';
export const authorIdValid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
export const authorNameValid = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80;
export function authorProfile(value: string): { id: string; url: string } | null {
  try {
    const url = new URL(value.trim());
    const match = /^\/user\/profile\/([a-f0-9]{24})\/?$/i.exec(url.pathname);
    if (url.protocol !== 'https:' || url.hostname !== 'www.xiaohongshu.com' || url.port || url.username || url.password || !match) return null;
    const id = match[1].toLowerCase();
    return { id, url: `https://www.xiaohongshu.com/user/profile/${id}` };
  } catch { return null; }
}
export function normalizedAuthor(input: AuthorInput): AuthorInput | null {
  const profile = authorProfile(input.profileUrl);
  return authorNameValid(input.name) && profile ? { name: input.name.trim(), profileUrl: profile.url } : null;
}
export const authorURL = (id: string) => `https://www.xiaohongshu.com/user/profile/${id}`;
