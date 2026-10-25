import type { ProfileNoteCard, RawNotePage } from "./types.js";

// These two functions run inside the browser. Keep them self-contained: no imported
// helper functions, account state, or private application APIs.
export function readProfilePage(doc: Document = document): {
  links: string[];
  cards: ProfileNoteCard[];
  noteCardCount: number;
  accessRestricted: boolean;
  restrictionReason: string | null;
} {
  const root = doc.querySelector(".feeds-container, .notes-container");
  const cards = Array.from((root ?? doc).querySelectorAll("section.note-item")).map((card) => ({
    links: Array.from(card.querySelectorAll(
      'a[href*="/explore/"], a[href*="/discovery/item/"], a[href*="/user/profile/"]',
    )).map((element) => (element as HTMLAnchorElement).href),
    title: (card.querySelector(".title")?.textContent ?? "").trim(),
    pinned: Array.from(card.querySelectorAll(".top-tag-area, .top-wrapper, .top-tag, .pinned-tag"))
      .some((element) => element.textContent?.trim() === "置顶"),
  }));
  const noteCardCount = cards.length;
  const links = cards.flatMap((card) => card.links);
  const text = doc.body?.innerText ?? doc.body?.textContent ?? "";
  const challenge = /请完成安全验证|拖动滑块|访问过于频繁|访问受限|网络环境存在风险|IP存在风险|安全限制/.test(text);
  const loginWall = links.length === 0 && /登录后查看|登录后可查看|登录小红书/.test(text);
  return {
    links,
    cards,
    noteCardCount,
    accessRestricted: challenge || loginWall,
    restrictionReason: challenge ? "ACCESS_CHALLENGE" : loginWall ? "LOGIN_WALL" : null,
  };
}

export function readNotePage(doc: Document = document): RawNotePage {
  const scope = doc.querySelector(".note-detail-mask, .note-container") ?? doc;
  const textOf = (selector: string): string =>
    (scope.querySelector(selector)?.textContent ?? "").trim();
  const title = textOf("#detail-title, .note-content .title");
  const body = textOf("#detail-desc, .note-content .desc");
  const authorIds = Array.from(scope.querySelectorAll(
    '.author-container a[href*="/user/profile/"], .author-wrapper a[href*="/user/profile/"]',
  )).flatMap((element) => {
    const match = element.getAttribute("href")?.match(/\/user\/profile\/([a-f0-9]{24})/i);
    return match?.[1] ? [match[1]] : [];
  });

  const imageCandidates = Array.from(scope.querySelectorAll(
    ".media-container .swiper-slide img, .note-slider .swiper-slide img, .note-slider-img",
  )).flatMap((element) => {
    const image = element as HTMLImageElement;
    const url = image.currentSrc || image.getAttribute("src") || image.getAttribute("data-src");
    if (!url || !/^https?:\/\//.test(url)) return [];
    const slide = image.closest(".swiper-slide");
    const index = slide?.getAttribute("data-swiper-slide-index");
    return [{ url, ordinal: index !== null && index !== undefined && /^\d+$/.test(index) ? Number(index) : null }];
  });

  let expectedImageCount: number | null = null;
  const counter = textOf(".slider-container .fraction, .media-container .xhs-slider-container .fraction, .media-container .swiper-pagination-fraction, .note-slider .count");
  const countMatch = counter.match(/\d+\s*\/\s*(\d+)/);
  if (countMatch?.[1]) expectedImageCount = Number(countMatch[1]);
  const bullets = scope.querySelectorAll(".media-container .swiper-pagination-bullet, .note-slider .swiper-pagination-bullet").length;
  if (expectedImageCount === null && bullets > 0) expectedImageCount = bullets;
  // Mounted slides may be virtualized. Their count does not prove the total.
  if (expectedImageCount !== null && (!Number.isInteger(expectedImageCount) || expectedImageCount < 1)) {
    expectedImageCount = null;
  }

  // Only explicit machine-readable dates qualify. "今天", HTTP Date, the system
  // clock, a date in the title, and a note ID are not publication metadata.
  const meta = (names: string[]): string | null => {
    for (const name of names) {
      const value = doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute("content");
      if (value) return value;
    }
    return null;
  };
  let sourcePublishedAt = meta(["article:published_time", "datePublished"]);
  let sourceUpdatedAt = meta(["article:modified_time", "dateModified"]);
  // On observed XHS pages, JSON-LD Article dates describe the render time.
  // When note state is present, only its identity-bound time fields qualify;
  // unsupported state must remain unverified instead of falling back to JSON-LD.
  const hasInitialState = Array.from(doc.querySelectorAll("script"))
    .some((element) => /^\s*window\.__INITIAL_STATE__\s*=/.test(element.textContent ?? ""));
  for (const element of hasInitialState ? [] : doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const value: unknown = JSON.parse(element.textContent ?? "");
      const records = Array.isArray(value) ? value : [value];
      for (const record of records) {
        if (!record || typeof record !== "object") continue;
        const item = record as Record<string, unknown>;
        if (["SocialMediaPosting", "Article", "BlogPosting"].includes(String(item["@type"]))) {
          if (!sourcePublishedAt && typeof item.datePublished === "string") sourcePublishedAt = item.datePublished;
          if (!sourceUpdatedAt && typeof item.dateModified === "string") sourceUpdatedAt = item.dateModified;
        }
      }
    } catch { /* A malformed structured-data block is not trusted metadata. */ }
  }
  const text = doc.body?.innerText ?? doc.body?.textContent ?? "";
  const challenge = /请完成安全验证|拖动滑块|访问过于频繁|访问受限|网络环境存在风险|IP存在风险|安全限制/.test(text);
  const loginWall = !body && /登录后查看|登录后可查看|登录小红书/.test(text);
  return {
    title, body, authorIds, imageCandidates, expectedImageCount,
    sourcePublishedAt, sourceUpdatedAt,
    accessRestricted: challenge || loginWall,
    restrictionReason: challenge ? "ACCESS_CHALLENGE" : loginWall ? "LOGIN_WALL" : null,
  };
}
