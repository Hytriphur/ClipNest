import type { ExtractResult, IngestItem, SiteId } from './types';
import { normalizeMediaUrl } from './url-normalize';

export type MediaCandidate = {
  element: Element;
  mediaUrl: string;
  mediaType: 'image' | 'video';
  sourcePageUrl?: string;
};

export function detectSite(locHref: string): SiteId {
  try {
    const url = new URL(locHref);
    const host = url.hostname.toLowerCase();
    if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) {
      return 'x';
    }
    if (host === 'pixiv.net' || host.endsWith('.pixiv.net') || host.endsWith('.pximg.net')) {
      return 'pixiv';
    }
    if (host === 'duitang.com' || host.endsWith('.duitang.com')) {
      return 'duitang';
    }
    if (
      host === 'xiaohongshu.com' ||
      host.endsWith('.xiaohongshu.com') ||
      host === 'rednote.com' ||
      host.endsWith('.rednote.com') ||
      host.endsWith('.xhscdn.com')
    ) {
      return 'xiaohongshu';
    }
    if (host === 'image.baidu.com' || host.endsWith('.image.baidu.com')) {
      return 'baidu';
    }
    if (
      host === 'images.google.com' ||
      ((host === 'www.google.com' || host.endsWith('.google.com')) &&
        (url.pathname.startsWith('/search') && url.searchParams.get('tbm') === 'isch'))
    ) {
      return 'google';
    }
    if (
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtu.be' ||
      host.endsWith('.youtu.be')
    ) {
      return 'youtube';
    }
  } catch {
    // ignore
  }
  return 'other';
}

function hasMediaExtension(url: string): boolean {
  try {
    const pathname = new URL(url.startsWith('//') ? `https:${url}` : url).pathname.toLowerCase();
    return /\.(?:jpg|jpeg|png|webp|gif|bmp|avif|svg|mp4|webm|mov|m4v)(?:$|[?#])/i.test(pathname);
  } catch {
    return /\.(?:jpg|jpeg|png|webp|gif|bmp|avif|svg|mp4|webm|mov|m4v)(?:$|[?#])/i.test(url);
  }
}

function hasVideoExtension(url: string): boolean {
  try {
    const pathname = new URL(url.startsWith('//') ? `https:${url}` : url).pathname.toLowerCase();
    return /\.(?:mp4|m3u8|webm|mov|m4v)(?:$|[?#])/i.test(pathname);
  } catch {
    return /\.(?:mp4|m3u8|webm|mov|m4v)(?:$|[?#])/i.test(url);
  }
}

function hasImageExtension(url: string): boolean {
  try {
    const pathname = new URL(url.startsWith('//') ? `https:${url}` : url).pathname.toLowerCase();
    return /\.(?:jpg|jpeg|png|webp|gif|bmp|avif|svg)(?:$|[?#])/i.test(pathname);
  } catch {
    return /\.(?:jpg|jpeg|png|webp|gif|bmp|avif|svg)(?:$|[?#])/i.test(url);
  }
}

function hasBlockedDocumentExtension(url: string): boolean {
  try {
    const pathname = new URL(url.startsWith('//') ? `https:${url}` : url).pathname.toLowerCase();
    return /\.(?:pdf|doc|docx|ppt|pptx|xls|xlsx|txt|zip|rar|7z)(?:$|[?#])/i.test(pathname);
  } catch {
    return /\.(?:pdf|doc|docx|ppt|pptx|xls|xlsx|txt|zip|rar|7z)(?:$|[?#])/i.test(url);
  }
}

function tryAbsoluteUrl(rawUrl?: string | null, base?: string): string | undefined {
  if (!rawUrl) return undefined;
  const trimmed = rawUrl.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return undefined;
  }
}

function decodeEscapedUrlText(text: string): string {
  return text
    .replace(/\\u002f/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\x2f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&');
}

function cleanExtractedUrl(raw: string): string {
  return raw.replace(/["'`<>]+$/g, '').replace(/[),.;]+$/g, '');
}

function extractUrlsFromText(text: string, base?: string): string[] {
  const urls = new Set<string>();
  const normalized = decodeEscapedUrlText(text);
  const re = /(?:https?:\/\/|\/\/)[^\s"'<>`\\]+/g;
  let match: RegExpExecArray | null = re.exec(normalized);
  while (match) {
    const raw = cleanExtractedUrl(match[0] ?? '');
    const resolved = tryAbsoluteUrl(raw.startsWith('//') ? `https:${raw}` : raw, base);
    if (resolved) urls.add(resolved);
    match = re.exec(normalized);
  }
  return Array.from(urls);
}

function getQueryParamUrl(rawHref: string, locHref: string, names: string[]): string | undefined {
  try {
    const url = new URL(rawHref, locHref);
    for (const name of names) {
      const value = url.searchParams.get(name);
      const resolved = tryAbsoluteUrl(value, locHref);
      if (resolved) return resolved;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function getClosestAnchor(el: Element): HTMLAnchorElement | null {
  return el.closest('a[href]') as HTMLAnchorElement | null;
}

function resolveGoogleImageFromAnchor(el: Element, locHref: string) {
  const anchor = getClosestAnchor(el);
  const href = anchor?.getAttribute('href') ?? '';
  if (!href.includes('/imgres') && !href.includes('imgurl=')) return undefined;
  const mediaUrl = getQueryParamUrl(href, locHref, ['imgurl', 'mediaurl', 'url']);
  if (!mediaUrl) return undefined;
  return {
    mediaUrl,
    sourcePageUrl: getQueryParamUrl(href, locHref, ['imgrefurl', 'refurl']),
  };
}

function resolveBaiduImageFromAnchor(el: Element, locHref: string) {
  const anchor = getClosestAnchor(el);
  const href = anchor?.getAttribute('href') ?? '';
  if (!/objurl=|imgurl=|fromurl=|image\/detail|search\/detail/i.test(href)) return undefined;
  const mediaUrl = getQueryParamUrl(href, locHref, ['objurl', 'imgurl', 'original', 'image_url']);
  if (!mediaUrl) return undefined;
  return {
    mediaUrl,
    sourcePageUrl: getQueryParamUrl(href, locHref, ['fromurl', 'source', 'refer']),
  };
}

function resolveXiaohongshuSourcePageUrl(el: Element, locHref: string): string | undefined {
  const anchor = getClosestAnchor(el);
  const href = anchor?.getAttribute('href') ?? '';
  if (!href) return undefined;
  try {
    const url = new URL(href, locHref);
    if (
      /\/explore\/[a-z0-9]+/i.test(url.pathname) ||
      /\/discovery\/item\/[a-z0-9]+/i.test(url.pathname) ||
      /\/item\/[a-z0-9]+/i.test(url.pathname)
    ) {
      return url.toString();
    }
  } catch {
    // ignore
  }
  return undefined;
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
  if (site === 'xiaohongshu') {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      if (hasBlockedDocumentExtension(url)) return false;
      if ((host.endsWith('.xiaohongshu.com') || host.endsWith('.rednote.com')) && hasMediaExtension(url)) return true;
      if (host.endsWith('.xhscdn.com')) return classifyXiaohongshuMediaUrl(url) !== null;
      return hasMediaExtension(url);
    } catch {
      if (hasBlockedDocumentExtension(url)) return false;
      return hasMediaExtension(url);
    }
  }
  if (site === 'google' || site === 'baidu') {
    return hasMediaExtension(url);
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
  if (site === 'xiaohongshu') {
    if (/avatar|profile|icon|emoji|logo|badge|captcha/i.test(url)) return true;
  }
  if (site === 'google') {
    if (/googlelogo|favicon|sprite|logo/i.test(url)) return true;
    if (/gstatic\.com\/images/i.test(url)) return true;
  }
  if (site === 'baidu') {
    if (/avatar|profile|icon|logo|passport|captcha/i.test(url)) return true;
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

function parseXiaohongshuMeta(doc: Document): { authorHandle?: string; tags?: string[] } {
  const author =
    doc.querySelector<HTMLMetaElement>('meta[name="author"]')?.content ??
    doc.querySelector<HTMLMetaElement>('meta[property="og:article:author"]')?.content ??
    doc.querySelector<HTMLMetaElement>('meta[name="twitter:creator"]')?.content ??
    '';

  const keywords =
    doc.querySelector<HTMLMetaElement>('meta[name="keywords"]')?.content ??
    doc.querySelector<HTMLMetaElement>('meta[property="og:keywords"]')?.content ??
    '';

  const filteredTags = keywords
    .split(/[,\uff0c#\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag) => !/^(小红书|rednote|xiaohongshu|精选|推荐)$/i.test(tag));

  return {
    authorHandle: author.trim().replace(/^@/, '') || undefined,
    tags: Array.from(new Set(filteredTags)).slice(0, 24),
  };
}

function collectXiaohongshuMetaMedia(doc: Document): Array<{ mediaUrl: string; mediaType: 'image' | 'video' }> {
  const urls: Array<{ mediaUrl: string; mediaType: 'image' | 'video' }> = [];
  const push = (selector: string, mediaType: 'image' | 'video') => {
    const value = doc.querySelector<HTMLMetaElement>(selector)?.content;
    const resolved = tryAbsoluteUrl(value, doc.location?.href);
    if (!resolved) return;
    if (!isLikelyMediaUrl(resolved, 'xiaohongshu') || isNoiseAsset(resolved, 'xiaohongshu')) return;
    urls.push({ mediaUrl: resolved, mediaType });
  };
  push('meta[property="og:image"]', 'image');
  push('meta[name="twitter:image"]', 'image');
  push('meta[property="og:video:url"]', 'video');
  push('meta[property="og:video:secure_url"]', 'video');
  push('meta[property="og:video"]', 'video');
  push('meta[name="twitter:player:stream"]', 'video');
  push('meta[property="twitter:player:stream"]', 'video');
  return urls;
}

function classifyXiaohongshuMediaUrl(url: string): 'image' | 'video' | null {
  const lower = url.toLowerCase();
  if (hasBlockedDocumentExtension(lower)) return null;
  if (hasVideoExtension(lower)) return 'video';
  if (hasImageExtension(lower)) return 'image';
  try {
    const u = new URL(lower.startsWith('//') ? `https:${lower}` : lower);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const query = u.search.toLowerCase();
    const hostLooksVideo = /(?:^|[-.])video(?:[-.]|$)|fe-video|sns-video/.test(host);
    const hostLooksImage = /webpic|pic|image|photo|sns-img|sns-web/.test(host);
    const pathLooksVideo =
      /\/video\//.test(path) ||
      /\/stream\//.test(path) ||
      /\/playurl\//.test(path) ||
      /\/playlist\//.test(path) ||
      /\/master(?:\.m3u8)?$/i.test(path) ||
      /(?:^|[/_-])(fhd|uhd|hd|origin|originvideo|videoplay|playback)(?:[/_-]|$)/i.test(path);
    const pathLooksImage = /\/image\//.test(path) || /\/images\//.test(path);
    const queryLooksVideo = /(?:^|[?&])(format|mime|type)=(?:video|mp4|m3u8|application%2f(?:vnd\.apple\.mpegurl|x-mpegurl))/i.test(query);
    const queryLooksImage = /(?:^|[?&])(format|imageformat|imgtype)=(?:jpg|jpeg|png|webp|gif|avif)/i.test(query);

    if (pathLooksVideo || queryLooksVideo || (hostLooksVideo && !hostLooksImage && !pathLooksImage && !queryLooksImage)) {
      return 'video';
    }
    if (pathLooksImage || queryLooksImage || hostLooksImage) return 'image';
  } catch {
    if (hasBlockedDocumentExtension(lower)) return null;
    if (/video/.test(lower) && !/image|img|pic|photo/.test(lower)) return 'video';
    if (/img|image|pic|photo/.test(lower)) return 'image';
  }
  return null;
}

function collectElementAttributeUrls(el: Element): string[] {
  const urls = new Set<string>();
  const base = el.ownerDocument?.location?.href;
  for (const name of el.getAttributeNames()) {
    const value = el.getAttribute(name);
    if (!value) continue;
    const direct = tryAbsoluteUrl(value, base);
    if (direct) urls.add(direct);
    for (const extracted of extractUrlsFromText(value, base)) urls.add(extracted);
  }
  return Array.from(urls);
}

function collectXiaohongshuScriptMedia(doc: Document): Array<{ mediaUrl: string; mediaType: 'image' | 'video' }> {
  const items: Array<{ mediaUrl: string; mediaType: 'image' | 'video' }> = [];
  const seen = new Set<string>();
  const push = (rawUrl: string) => {
    const resolved = tryAbsoluteUrl(rawUrl, doc.location?.href);
    if (!resolved) return;
    if (!isLikelyMediaUrl(resolved, 'xiaohongshu') || isNoiseAsset(resolved, 'xiaohongshu')) return;
    const mediaType = classifyXiaohongshuMediaUrl(resolved);
    if (!mediaType) return;
    const normalized = normalizeMediaUrl(resolved);
    const key = `${mediaType}:${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ mediaUrl: normalized, mediaType });
  };

  const scripts = Array.from(doc.querySelectorAll<HTMLScriptElement>('script'));
  for (const script of scripts) {
    const text = script.textContent ?? '';
    if (!text) continue;
    if (!/(xhscdn|xiaohongshu|rednote|\.mp4|\.m3u8|\.jpg|\.jpeg|\.png|\.webp)/i.test(text)) continue;
    for (const url of extractUrlsFromText(text, doc.location?.href)) push(url);
  }

  return items;
}

function isXTweetStatusHref(href: string): boolean {
  return /\/(?:i\/)?status\/\d+/i.test(href);
}

function rectArea(rect: DOMRect | ClientRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function rectIntersectionArea(a: DOMRect | ClientRect, b: DOMRect | ClientRect): number {
  const left = Math.max(a.left, b.left);
  const right = Math.min(a.right, b.right);
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.bottom, b.bottom);
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  return width * height;
}

function rectCenterDistance(a: DOMRect | ClientRect, b: DOMRect | ClientRect): number {
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  const bx = b.left + b.width / 2;
  const by = b.top + b.height / 2;
  return Math.hypot(ax - bx, ay - by);
}

function getDomDistance(a: Element, b: Element, stop: Element): number {
  if (a === b) return 0;
  const distA = new Map<Element, number>();
  let cur: Element | null = a;
  let depth = 0;
  while (cur) {
    distA.set(cur, depth);
    if (cur === stop) break;
    cur = cur.parentElement;
    depth += 1;
  }
  cur = b;
  depth = 0;
  while (cur) {
    const existing = distA.get(cur);
    if (existing !== undefined) return existing + depth;
    if (cur === stop) break;
    cur = cur.parentElement;
    depth += 1;
  }
  return 999;
}

function normalizeXTweetHref(href: string, pageOrigin: string): string | undefined {
  try {
    const url = new URL(href, pageOrigin);
    if (!isXTweetStatusHref(url.pathname)) return undefined;
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

export function findClosestTweetUrl(el: Element, pageOrigin: string): string | undefined {
  const article = el.closest('article');
  if (!article) return undefined;

  const targetRect = el.getBoundingClientRect();
  const targetMediaRoot =
    el.closest('[data-testid="tweetPhoto"], [data-testid="videoPlayer"], a[href*="/status/"], a[href*="/i/status/"]') ??
    el;
  const targetIsVideo = !!(el.closest('[data-testid="videoPlayer"]') || el.tagName === 'VIDEO');

  const anchors = Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href]')).filter((anchor) => {
    if (anchor.closest('article') !== article) return false;
    const href = anchor.getAttribute('href') ?? '';
    return isXTweetStatusHref(href);
  });

  let bestUrl: string | undefined;
  let bestScore = -Infinity;

  for (const anchor of anchors) {
    const rawHref = anchor.getAttribute('href') ?? '';
    const normalized = normalizeXTweetHref(rawHref, pageOrigin);
    if (!normalized) continue;

    let score = 0;
    const anchorRect = anchor.getBoundingClientRect();
    const overlap = rectIntersectionArea(targetRect, anchorRect);
    const overlapRatio =
      overlap > 0 ? overlap / Math.max(1, Math.min(rectArea(targetRect), Math.max(1, rectArea(anchorRect)))) : 0;
    const distance = rectCenterDistance(targetRect, anchorRect);
    const domDistance = getDomDistance(anchor, el, article);
    const href = rawHref;
    const isVideoRoute = /\/video\/\d+$/i.test(href);
    const isPhotoRoute = /\/photo\/\d+$/i.test(href);
    const isBaseStatus = /\/(?:i\/)?status\/\d+\/?$/i.test(href);

    if (anchor === el) score += 4000;
    if (anchor.contains(el)) score += 3600;
    if (el.contains(anchor)) score += 3200;
    if (targetMediaRoot && anchor.closest('[data-testid="tweetPhoto"], [data-testid="videoPlayer"], a[href*="/status/"], a[href*="/i/status/"]') === targetMediaRoot) {
      score += 2800;
    }
    if (overlap > 0) {
      score += 1800 + overlapRatio * 2200;
    } else {
      score += Math.max(0, 1200 - distance);
    }
    score += Math.max(0, 900 - domDistance * 90);

    if (targetIsVideo && isVideoRoute) score += 2200;
    if (!targetIsVideo && isPhotoRoute) score += 1600;
    if (anchor.querySelector('time')) score += 260;
    if (isBaseStatus) score += 180;

    if (score > bestScore) {
      bestScore = score;
      bestUrl = normalized;
    }
  }

  return bestUrl;
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
  const contextTags = site === 'pixiv' ? extra?.tags ?? [] : [];

  const items: IngestItem[] = [];
  const collectedAt = new Date().toISOString();
  for (const candidate of candidates) {
    const tweetUrl = site === 'x' ? findClosestTweetUrl(candidate.element, pageOrigin) : undefined;
    const authorHandle =
      site === 'x' ? extractHandleFromTweetUrl(tweetUrl) : extra?.authorHandle ? extra.authorHandle : undefined;
    const artworkUrl = site === 'pixiv' ? resolvePixivArtworkUrl(candidate.element, locHref) : undefined;
    const effectiveSourcePageUrl =
      candidate.sourcePageUrl ?? (site === 'pixiv' && artworkUrl ? artworkUrl : sourcePageUrl);
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
        tags: contextTags,
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
  if (site === 'google') {
    const resolved = resolveGoogleImageFromAnchor(img, img.ownerDocument?.location?.href ?? '');
    if (resolved?.mediaUrl) {
      return {
        element: img,
        mediaUrl: normalizeMediaUrl(resolved.mediaUrl),
        mediaType: 'image',
        sourcePageUrl: resolved.sourcePageUrl,
      };
    }
  }

  if (site === 'baidu') {
    const resolved = resolveBaiduImageFromAnchor(img, img.ownerDocument?.location?.href ?? '');
    if (resolved?.mediaUrl) {
      return {
        element: img,
        mediaUrl: normalizeMediaUrl(resolved.mediaUrl),
        mediaType: 'image',
        sourcePageUrl: resolved.sourcePageUrl,
      };
    }
  }

  const rawUrl = pickBestUrl(collectImageUrls(img), site);
  if (!rawUrl) return null;
  return {
    element: img,
    mediaUrl: normalizeMediaUrl(rawUrl),
    mediaType: 'image',
    sourcePageUrl: site === 'xiaohongshu' ? resolveXiaohongshuSourcePageUrl(img, img.ownerDocument?.location?.href ?? '') : undefined,
  };
}

function pickVideoUrl(video: HTMLVideoElement, site: SiteId): string | null {
  const urls: string[] = [];
  const push = (value?: string | null) => {
    if (!value) return;
    const trimmed = value.trim();
    if (trimmed) urls.push(trimmed);
  };

  Array.from(video.querySelectorAll<HTMLSourceElement>('source'))
    .map((s) => s.src)
    .filter(Boolean)
    .forEach((src) => push(src));

  push(video.currentSrc);
  push(video.src);

  if (site === 'xiaohongshu') {
    collectElementAttributeUrls(video).forEach((url) => push(url));
    let cur: Element | null = video.parentElement;
    for (let depth = 0; cur && depth < 3; depth += 1) {
      collectElementAttributeUrls(cur).forEach((url) => push(url));
      cur = cur.parentElement;
    }
  }

  for (const src of urls) {
    if (!isLikelyMediaUrl(src, site) || isNoiseAsset(src, site)) continue;
    if (site === 'xiaohongshu' && classifyXiaohongshuMediaUrl(src) !== 'video') continue;
    return src;
  }

  return null;
}

function candidateFromVideo(video: HTMLVideoElement, site: SiteId): MediaCandidate | null {
  const rawUrl = pickVideoUrl(video, site);
  if (!rawUrl) return null;
  return {
    element: video,
    mediaUrl: normalizeMediaUrl(rawUrl),
    mediaType: 'video',
    sourcePageUrl:
      site === 'xiaohongshu' ? resolveXiaohongshuSourcePageUrl(video, video.ownerDocument?.location?.href ?? '') : undefined,
  };
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
  if (site === 'google') {
    const resolved = resolveGoogleImageFromAnchor(el, el.ownerDocument?.location?.href ?? '');
    if (resolved?.mediaUrl) {
      return {
        element: el,
        mediaUrl: normalizeMediaUrl(resolved.mediaUrl),
        mediaType: 'image',
        sourcePageUrl: resolved.sourcePageUrl,
      };
    }
  }

  if (site === 'baidu') {
    const resolved = resolveBaiduImageFromAnchor(el, el.ownerDocument?.location?.href ?? '');
    if (resolved?.mediaUrl) {
      return {
        element: el,
        mediaUrl: normalizeMediaUrl(resolved.mediaUrl),
        mediaType: 'image',
        sourcePageUrl: resolved.sourcePageUrl,
      };
    }
  }

  const rawUrl = pickBestUrl(collectBackgroundUrls(el), site);
  if (!rawUrl) return null;
  return {
    element: el,
    mediaUrl: normalizeMediaUrl(rawUrl),
    mediaType: 'image',
    sourcePageUrl: site === 'xiaohongshu' ? resolveXiaohongshuSourcePageUrl(el, el.ownerDocument?.location?.href ?? '') : undefined,
  };
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

  const doc = root.nodeType === 9 ? (root as Document) : root.ownerDocument;
  if (site === 'xiaohongshu' && root.nodeType === 9 && doc) {
    for (const meta of collectXiaohongshuMetaMedia(doc)) {
      push({
        element: doc.documentElement,
        mediaUrl: normalizeMediaUrl(meta.mediaUrl),
        mediaType: meta.mediaType,
        sourcePageUrl: doc.location?.href,
      });
    }
    for (const media of collectXiaohongshuScriptMedia(doc)) {
      push({
        element: doc.documentElement,
        mediaUrl: normalizeMediaUrl(media.mediaUrl),
        mediaType: media.mediaType,
        sourcePageUrl: doc.location?.href,
      });
    }
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
  const extra =
    site === 'pixiv' && doc ? parsePixivMeta(doc, locHref) : site === 'xiaohongshu' && doc ? parseXiaohongshuMeta(doc) : undefined;
  return { items: buildItemsFromCandidates(candidates, locHref, site, pageTitle, extra) };
}

export function extractFromElement(el: Element, locHref: string): ExtractResult {
  const site = detectSite(locHref);
  const candidate = candidateFromElement(el, site);
  if (!candidate) return { items: [] };
  const doc = el.ownerDocument ?? undefined;
  const pageTitle = doc?.title;
  const extra =
    site === 'pixiv' && doc ? parsePixivMeta(doc, locHref) : site === 'xiaohongshu' && doc ? parseXiaohongshuMeta(doc) : undefined;
  return { items: buildItemsFromCandidates([candidate], locHref, site, pageTitle, extra) };
}

export function extractFromDocument(doc: Document, locHref: string): ExtractResult {
  return extractFromRoot(doc, locHref);
}
