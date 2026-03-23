import type { ExtractResult, IngestItem, SiteId } from './types';
import { normalizeMediaUrl } from './url-normalize';

export type MediaCandidate = {
  element: Element;
  mediaUrl: string;
  mediaType: 'image' | 'video';
};

export function detectSite(locHref: string): SiteId {
  try {
    const host = new URL(locHref).hostname.toLowerCase();
    if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) {
      return 'x';
    }
    if (host === 'pixiv.net' || host.endsWith('.pixiv.net') || host.endsWith('.pximg.net')) {
      return 'pixiv';
    }
    if (host === 'duitang.com' || host.endsWith('.duitang.com')) {
      return 'duitang';
    }
  } catch {
    // ignore
  }
  return 'other';
}

function extractPixivArtworkIdFromText(text: string): string | undefined {
  if (!text) return undefined;
  const m1 = text.match(/artworks\/(\d+)/);
  if (m1?.[1]) return m1[1];
  const m2 = text.match(/illustId["']?\s*[:=]\s*["']?(\d+)/i);
  if (m2?.[1]) return m2[1];
  const m3 = text.match(/illust_id["']?\s*[:=]\s*["']?(\d+)/i);
  if (m3?.[1]) return m3[1];
  const m4 = text.match(/"id"\s*:\s*"(\d{6,})"/i);
  if (m4?.[1]) return m4[1];
  return undefined;
}

export function resolvePixivArtworkUrl(el: Element, locHref: string): string | undefined {
  try {
    if (/pixiv\.net\/artworks\/\d+/.test(locHref)) return new URL(locHref).toString();
  } catch {
    // ignore
  }

  const directAnchor = el.closest('a[href*="/artworks/"]') as HTMLAnchorElement | null;
  const directHref = directAnchor?.getAttribute('href') ?? '';
  if (directHref) {
    try {
      return new URL(directHref, locHref).toString();
    } catch {
      // ignore
    }
  }

  const dataIdEl = el.closest('[data-illust-id], [data-id]') as HTMLElement | null;
  const dataId = dataIdEl?.getAttribute('data-illust-id') ?? dataIdEl?.getAttribute('data-id') ?? '';
  const dataIdMatch = dataId.match(/\d{5,}/)?.[0];
  if (dataIdMatch) {
    try {
      return new URL(`/artworks/${dataIdMatch}`, locHref).toString();
    } catch {
      // ignore
    }
  }

  const gtmEl = el.closest('[data-gtm-value], [data-gtm-label], [data-gtm-action]') as HTMLElement | null;
  const gtmValue =
    (gtmEl?.getAttribute('data-gtm-value') ?? '') +
    ' ' +
    (gtmEl?.getAttribute('data-gtm-label') ?? '') +
    ' ' +
    (gtmEl?.getAttribute('data-gtm-action') ?? '');
  const gtmId = extractPixivArtworkIdFromText(gtmValue);
  if (gtmId) {
    try {
      return new URL(`/artworks/${gtmId}`, locHref).toString();
    } catch {
      // ignore
    }
  }

  const container = el.closest('article, section, li, div') ?? el.parentElement;
  const fallbackAnchor = container?.querySelector('a[href*="/artworks/"]') as HTMLAnchorElement | null;
  const fallbackHref = fallbackAnchor?.getAttribute('href') ?? '';
  if (fallbackHref) {
    try {
      return new URL(fallbackHref, locHref).toString();
    } catch {
      // ignore
    }
  }

  return undefined;
}

export function isPixivNovelElement(el: Element, locHref: string): boolean {
  const lowerHref = locHref.toLowerCase();
  if (lowerHref.includes('/novel/') || lowerHref.includes('mode=novel')) return true;

  const novelAnchor = el.closest('a[href*="/novel/"], a[href*="novel/show.php"], a[href*="/novel/series"]');
  if (novelAnchor) return true;

  const gtmEl = el.closest('[data-gtm-value], [data-gtm-label], [data-gtm-action]') as HTMLElement | null;
  if (gtmEl) {
    const raw =
      (gtmEl.getAttribute('data-gtm-value') ?? '') +
      ' ' +
      (gtmEl.getAttribute('data-gtm-label') ?? '') +
      ' ' +
      (gtmEl.getAttribute('data-gtm-action') ?? '');
    if (raw.toLowerCase().includes('novel')) return true;
  }

  const ariaLabel = (el.closest('[aria-label]') as HTMLElement | null)?.getAttribute('aria-label') ?? '';
  if (/novel|小说/i.test(ariaLabel)) return true;

  return false;
}

function isPixivAdHref(href: string): boolean {
  const lower = href.toLowerCase();
  if (lower.includes('/artworks/')) return false;
  return /premium|campaign|ads?|advert|promo|promotion|sponsored|fanbox|booth|pixiv-pay|membership|subscribe|upgrade/.test(
    lower,
  );
}

function isPixivAdText(text: string): boolean {
  const lower = text.toLowerCase();
  return /(?:\bpr\b|\bads?\b|promo|promotion|sponsored|advert|premium|campaign|fanbox|booth|pixiv-pay|membership|subscribe|upgrade|広告|プロモーション|プレミアム|スポンサー|广告|推广|赞助|会员|開通)/.test(
    lower,
  );
}

export function isPixivAdElement(el: Element, locHref: string): boolean {
  if (detectSite(locHref) !== 'pixiv') return false;

  const layoutBlock = el.closest('aside, header, footer, nav, [role="complementary"], [role="banner"]');
  if (layoutBlock) {
    const artworkAnchor = el.closest('a[href*="/artworks/"]');
    if (!artworkAnchor) return true;
  }

  const anchor = el.closest('a[href]') as HTMLAnchorElement | null;
  const href = anchor?.getAttribute('href') ?? '';
  if (href && isPixivAdHref(href)) return true;

  const gtmEl = el.closest('[data-gtm-action], [data-gtm-label], [data-gtm-category], [data-gtm-value]') as
    | HTMLElement
    | null;
  if (gtmEl) {
    const raw =
      (gtmEl.getAttribute('data-gtm-action') ?? '') +
      ' ' +
      (gtmEl.getAttribute('data-gtm-label') ?? '') +
      ' ' +
      (gtmEl.getAttribute('data-gtm-category') ?? '') +
      ' ' +
      (gtmEl.getAttribute('data-gtm-value') ?? '');
    if (raw && isPixivAdText(raw)) return true;
  }

  const labeledRoot = el.closest('[aria-label], [title], [data-testid], [data-gtm-category], [data-gtm-label]') as
    | HTMLElement
    | null;
  if (labeledRoot) {
    const raw =
      (labeledRoot.getAttribute('aria-label') ?? '') +
      ' ' +
      (labeledRoot.getAttribute('title') ?? '') +
      ' ' +
      (labeledRoot.getAttribute('data-testid') ?? '') +
      ' ' +
      (labeledRoot.getAttribute('data-gtm-category') ?? '') +
      ' ' +
      (labeledRoot.getAttribute('data-gtm-label') ?? '');
    if (raw && isPixivAdText(raw)) return true;
  }

  const labeled =
    (el.closest('[aria-label]') as HTMLElement | null)?.getAttribute('aria-label') ??
    (el.closest('[title]') as HTMLElement | null)?.getAttribute('title') ??
    '';
  const alt = (el as HTMLElement).getAttribute?.('alt') ?? '';
  const className = (el.closest('[class]') as HTMLElement | null)?.getAttribute('class') ?? '';
  const composite = `${labeled} ${alt} ${className}`.trim();
  if (composite && isPixivAdText(composite)) return true;

  const artworkAnchor = el.closest('a[href*="/artworks/"]');
  if (artworkAnchor) return false;

  return false;
}

function isLikelyMediaUrl(url: string, site: SiteId): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('blob:') || trimmed.startsWith('data:') || trimmed.startsWith('about:')) return false;
  const normalized = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
  if (!/^https?:/i.test(normalized)) return false;
  if (site === 'x') {
    if (url.includes('video.twimg.com/')) return true;
    if (url.includes('pbs.twimg.com/media/')) return true;
    if (url.includes('pbs.twimg.com/ext_tw_video_thumb/')) return true;
    if (url.includes('pbs.twimg.com/amplify_video_thumb/')) return true;
    if (url.includes('pbs.twimg.com/tweet_video_thumb/')) return true;
    return false;
  }
  if (site === 'pixiv') {
    if (!/pximg\.net/.test(url)) return false;
    if (/img-zip-ugoira/.test(url)) return false;
    try {
      const u = new URL(url);
      const p = u.pathname.toLowerCase();
      const hasImgDir = /\/img-(original|master)\//.test(p) || /\/img\//.test(p) || /\/custom-thumb\//.test(p);
      const hasPageSuffix = /_p\d+/.test(p);
      if (!hasImgDir && !hasPageSuffix) return false;
      const ext = p.split('.').pop()?.toLowerCase() ?? '';
      if (!['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return false;
      return true;
    } catch {
      return false;
    }
  }
  if (site === 'duitang') {
    if (!/duitang\.com/.test(url)) return false;
    return true;
  }
  return false;
}

function isNoiseAsset(url: string, site: SiteId): boolean {
  if (site === 'x') {
    if (url.includes('pbs.twimg.com/profile_images/')) return true;
    if (url.includes('pbs.twimg.com/profile_banners/')) return true;
    if (url.includes('abs.twimg.com/emoji/')) return true;
    if (url.includes('abs.twimg.com/sticky/')) return true;
    return false;
  }
  if (site === 'pixiv') {
    if (/s\.pximg\.net/.test(url)) return true;
    if (/\/common\//.test(url)) return true;
    if (/favicon/.test(url)) return true;
    if (/user-profile/.test(url)) return true;
    if (/profile\//.test(url)) return true;
    if (/\/avatar\//.test(url)) return true;
  }
  if (site === 'duitang') {
    if (/\/avatar\//.test(url)) return true;
    if (/\/icon\//.test(url)) return true;
  }
  return false;
}

function parsePixivMeta(doc: Document, locHref: string): { authorHandle?: string; tags?: string[] } {
  let illustId: string | null = null;
  try {
    const u = new URL(locHref);
    const m = u.pathname.match(/artworks\/(\d+)/);
    illustId = m?.[1] ?? null;
  } catch {
    illustId = null;
  }

  let authorHandle: string | undefined;
  let tags: string[] = [];

  const meta = doc.querySelector<HTMLMetaElement>('meta#meta-preload-data');
  if (meta?.content) {
    try {
      const data = JSON.parse(meta.content) as any;
      if (illustId && data?.illust?.[illustId]) {
        const illust = data.illust[illustId];
        const userId = String(illust?.userId ?? '');
        if (userId && data?.user?.[userId]?.name) {
          authorHandle = String(data.user[userId].name);
        }
        const rawTags = Array.isArray(illust?.tags?.tags) ? illust.tags.tags : [];
        tags = rawTags.map((t: any) => String(t?.tag ?? '')).filter(Boolean);
      }
    } catch {
      // ignore
    }
  }

  if (!authorHandle) {
    const ogCreator = doc.querySelector<HTMLMetaElement>('meta[name="twitter:creator"]')?.content;
    if (ogCreator && ogCreator.trim()) authorHandle = ogCreator.trim().replace(/^@/, '');
  }

  if (tags.length === 0) {
    const keywords = doc.querySelector<HTMLMetaElement>('meta[name="keywords"]')?.content;
    if (keywords) {
      tags = keywords
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    }
  }

  return {
    authorHandle: authorHandle?.trim() || undefined,
    tags: Array.from(new Set(tags)).slice(0, 40),
  };
}

function findClosestTweetUrl(el: Element, pageOrigin: string): string | undefined {
  const article = el.closest('article');
  if (!article) return undefined;

  const a = article.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
  const href = a?.getAttribute('href');
  if (!href) return undefined;
  try {
    return new URL(href, pageOrigin).toString();
  } catch {
    return undefined;
  }
}

function extractHandleFromTweetUrl(tweetUrl?: string): string | undefined {
  if (!tweetUrl) return undefined;
  try {
    const u = new URL(tweetUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    // /{handle}/status/{id}
    if (parts.length >= 3 && parts[1] === 'status') return parts[0];
  } catch {
    // ignore
  }
  return undefined;
}

function buildItemsFromCandidates(
  candidates: MediaCandidate[],
  locHref: string,
  site: SiteId,
  pageTitle?: string,
  extra?: { authorHandle?: string; tags?: string[] },
): IngestItem[] {
  let page: URL | null = null;
  try {
    page = new URL(locHref);
  } catch {
    // ignore
  }

  const pageOrigin = page?.origin ?? 'https://x.com';
  const sourcePageUrl = locHref;

  const items: IngestItem[] = [];
  const collectedAt = new Date().toISOString();
  for (const candidate of candidates) {
    const tweetUrl = site === 'x' ? findClosestTweetUrl(candidate.element, pageOrigin) : undefined;
    const authorHandle =
      site === 'x' ? extractHandleFromTweetUrl(tweetUrl) : extra?.authorHandle ? extra.authorHandle : undefined;
    const artworkUrl = site === 'pixiv' ? resolvePixivArtworkUrl(candidate.element, locHref) : undefined;
    const effectiveSourcePageUrl = site === 'pixiv' && artworkUrl ? artworkUrl : sourcePageUrl;
    const referer = site === 'pixiv' && artworkUrl ? artworkUrl : sourcePageUrl;

    items.push({
      sourcePageUrl: effectiveSourcePageUrl,
      tweetUrl,
      authorHandle,
      mediaUrl: candidate.mediaUrl,
      mediaType: candidate.mediaType,
      collectedAt,
      context: {
        site,
        referer,
        pageTitle,
        tags: extra?.tags ?? [],
        artworkUrl,
      },
    });
  }
  return items;
}

function collectImageUrls(img: HTMLImageElement): string[] {
  const urls: string[] = [];
  const push = (value?: string | null) => {
    if (!value) return;
    const trimmed = value.trim();
    if (trimmed) urls.push(trimmed);
  };
  const pushSrcset = (value?: string | null) => {
    if (!value) return;
    for (const part of value.split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const url = seg.split(/\s+/)[0];
      push(url);
    }
  };

  push(img.currentSrc);
  push(img.src);
  push(img.getAttribute('data-src'));
  push(img.getAttribute('data-original'));
  push(img.getAttribute('data-lazy'));
  push(img.getAttribute('data-lazy-src'));
  push(img.getAttribute('data-url'));
  push(img.getAttribute('data-raw'));

  pushSrcset(img.getAttribute('srcset'));
  pushSrcset(img.getAttribute('data-srcset'));

  const picture = img.parentElement?.tagName === 'PICTURE' ? img.parentElement : null;
  if (picture) {
    const sources = Array.from(picture.querySelectorAll<HTMLSourceElement>('source'));
    for (const source of sources) {
      pushSrcset(source.getAttribute('srcset'));
      pushSrcset(source.getAttribute('data-srcset'));
    }
  }

  return urls;
}

function pickBestUrl(urls: string[], site: SiteId): string | null {
  const filtered = urls.filter((url) => isLikelyMediaUrl(url, site) && !isNoiseAsset(url, site));
  if (!filtered.length) return null;

  if (site === 'pixiv') {
    const score = (url: string) => {
      let s = 0;
      if (url.includes('/img-original/')) s += 4;
      if (url.includes('/img-master/')) s += 2;
      if (url.includes('/c/')) s -= 1;
      if (url.includes('_master1200')) s += 1;
      return s;
    };
    return filtered.sort((a, b) => score(b) - score(a))[0] ?? null;
  }

  return filtered[0] ?? null;
}

function candidateFromImage(img: HTMLImageElement, site: SiteId): MediaCandidate | null {
  const rawUrl = pickBestUrl(collectImageUrls(img), site);
  if (!rawUrl) return null;
  return { element: img, mediaUrl: normalizeMediaUrl(rawUrl), mediaType: 'image' };
}

function pickVideoUrl(video: HTMLVideoElement, site: SiteId): string | null {
  const sources = Array.from(video.querySelectorAll<HTMLSourceElement>('source'))
    .map((s) => s.src)
    .filter(Boolean);
  for (const src of sources) {
    if (isLikelyMediaUrl(src, site) && !isNoiseAsset(src, site)) return src;
  }
  const fallback = video.currentSrc || video.src || '';
  if (!fallback) return null;
  if (!isLikelyMediaUrl(fallback, site)) return null;
  if (isNoiseAsset(fallback, site)) return null;
  return fallback;
}

function candidateFromVideo(video: HTMLVideoElement, site: SiteId): MediaCandidate | null {
  const rawUrl = pickVideoUrl(video, site);
  if (!rawUrl) return null;
  return { element: video, mediaUrl: normalizeMediaUrl(rawUrl), mediaType: 'video' };
}

function candidateFromElement(el: Element, site: SiteId): MediaCandidate | null {
  const tag = el.tagName;
  if (tag === 'IMG') return candidateFromImage(el as HTMLImageElement, site);
  if (tag === 'VIDEO') return candidateFromVideo(el as HTMLVideoElement, site);
  return null;
}

function collectBackgroundUrls(el: HTMLElement): string[] {
  const urls: string[] = [];
  const re = /url\(["']?([^"')]+)["']?\)/g;
  const styleAttr = el.getAttribute('style') ?? '';
  let match: RegExpExecArray | null = re.exec(styleAttr);
  while (match) {
    urls.push(match[1]);
    match = re.exec(styleAttr);
  }

  const view = el.ownerDocument?.defaultView;
  if (view?.getComputedStyle) {
    try {
      const computed = view.getComputedStyle(el);
      const bg = computed?.backgroundImage ?? '';
      if (bg && bg !== 'none') {
        let m: RegExpExecArray | null = re.exec(bg);
        while (m) {
          urls.push(m[1]);
          m = re.exec(bg);
        }
      }
    } catch {
      // ignore
    }
  }
  const dataSrc = el.getAttribute('data-src') || el.getAttribute('data-original');
  if (dataSrc) urls.push(dataSrc);
  const dataSrcset = el.getAttribute('data-srcset');
  if (dataSrcset) {
    for (const part of dataSrcset.split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const url = seg.split(/\s+/)[0];
      if (url) urls.push(url);
    }
  }
  return urls;
}

function candidateFromBackground(el: HTMLElement, site: SiteId): MediaCandidate | null {
  const rawUrl = pickBestUrl(collectBackgroundUrls(el), site);
  if (!rawUrl) return null;
  return { element: el, mediaUrl: normalizeMediaUrl(rawUrl), mediaType: 'image' };
}

export function findMediaCandidates(
  root: Document | Element,
  locHref: string,
  opts?: { dedupe?: boolean },
): MediaCandidate[] {
  const site = detectSite(locHref);
  if (site === 'other') return [];

  const candidates: MediaCandidate[] = [];
  const dedupe = opts?.dedupe ?? true;
  const seen = new Set<string>();

  const push = (candidate: MediaCandidate | null) => {
    if (!candidate) return;
    if (site === 'pixiv' && isPixivNovelElement(candidate.element, locHref)) return;
    if (site === 'pixiv' && isPixivAdElement(candidate.element, locHref)) return;
    if (dedupe) {
      if (seen.has(candidate.mediaUrl)) return;
      seen.add(candidate.mediaUrl);
    }
    candidates.push(candidate);
  };

  const imgs = Array.from(root.querySelectorAll<HTMLImageElement>('img'));
  for (const img of imgs) push(candidateFromImage(img, site));

  const videos = Array.from(root.querySelectorAll<HTMLVideoElement>('video'));
  for (const v of videos) push(candidateFromVideo(v, site));

  if (site !== 'other') {
    const bgEls = Array.from(root.querySelectorAll<HTMLElement>('[style*="background-image"]'));
    for (const el of bgEls) push(candidateFromBackground(el, site));
    const dataEls = Array.from(
      root.querySelectorAll<HTMLElement>('[data-src], [data-original], [data-lazy], [data-lazy-src], [data-raw]'),
    );
    for (const el of dataEls) push(candidateFromBackground(el, site));
  }

  return candidates;
}

export function findMediaElements(root: Document | Element, locHref: string): Element[] {
  return findMediaCandidates(root, locHref).map((c) => c.element);
}

export function findMediaElementsForUi(root: Document | Element, locHref: string): Element[] {
  return findMediaCandidates(root, locHref, { dedupe: false }).map((c) => c.element);
}

export function extractFromRoot(root: Document | Element, locHref: string): ExtractResult {
  const site = detectSite(locHref);
  const candidates = findMediaCandidates(root, locHref);
  const doc = root.nodeType === 9 ? (root as Document) : root.ownerDocument;
  const pageTitle = doc?.title;
  const extra = site === 'pixiv' && doc ? parsePixivMeta(doc, locHref) : undefined;
  return { items: buildItemsFromCandidates(candidates, locHref, site, pageTitle, extra) };
}

export function extractFromElement(el: Element, locHref: string): ExtractResult {
  const site = detectSite(locHref);
  const candidate = candidateFromElement(el, site);
  if (!candidate) return { items: [] };
  const doc = el.ownerDocument ?? undefined;
  const pageTitle = doc?.title;
  const extra = site === 'pixiv' && doc ? parsePixivMeta(doc, locHref) : undefined;
  return { items: buildItemsFromCandidates([candidate], locHref, site, pageTitle, extra) };
}

export function extractFromDocument(doc: Document, locHref: string): ExtractResult {
  return extractFromRoot(doc, locHref);
}
