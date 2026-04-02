import type { MediaCandidate } from './lib/extract';
import type { IngestItem } from './lib/types';
import {
  detectSite,
  extractFromDocument,
  extractFromElement,
  extractFromRoot,
  findMediaCandidates,
  findClosestTweetUrl as findClosestTweetUrlFromLib,
  findMediaElementsForUi,
  isPixivAdElement,
  isPixivNovelElement,
  resolvePixivArtworkUrl,
} from './lib/extract';
import { normalizeMediaUrl } from './lib/url-normalize';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'XIC_INGEST_PROGRESS') {
    if (msg.event === 'progress') {
      applyProgressEvent(msg.data);
    } else if (msg.event === 'done' && Array.isArray(msg?.data?.results)) {
      applyIngestResults(msg.data.results);
    } else if (msg.event === 'error') {
      const errText = typeof msg?.data?.error === 'string' ? msg.data.error : '未知错误';
      showToast(`下载失败：${errText}`, 2400);
    }
    return;
  }
  if (msg.type === 'XIC_EXTRACT_X_VIDEO_FOR_TWEET') {
    (async () => {
      const tweetUrl = typeof (msg as any)?.tweetUrl === 'string' ? String((msg as any).tweetUrl) : location.href;
      const hintIds = Array.isArray((msg as any)?.hintIds)
        ? (msg as any).hintIds.map((v: any) => String(v ?? '').trim()).filter(Boolean)
        : [];
      const tweetId = extractTweetIdFromUrl(tweetUrl) ?? extractTweetIdFromUrl(location.href);
      if (!tweetId) {
        sendResponse({ ok: false, error: 'missing tweet id', items: [] });
        return;
      }

      const article = await waitForXArticleByTweetId(tweetId, 6500);
      const root = article ?? document.documentElement;
      const target =
        (article?.querySelector('[data-testid="videoPlayer"]') as Element | null) ??
        (article?.querySelector('[data-testid="tweetPhoto"]') as Element | null) ??
        root;

      const effectiveHints = Array.from(new Set([...hintIds, tweetId])).slice(0, 8);
      let items = await tryExtractXVideoItems(target, { hintIds: effectiveHints });
      items = items.filter((it) => it && it.mediaType === 'video' && isHttpUrl(String(it.mediaUrl ?? '')));

      // If we extracted multiple videos, prefer those whose URL contains our hints.
      const hinted = items.filter((it) => urlMatchesAnyHint(String(it.mediaUrl ?? ''), effectiveHints));
      if (hinted.length) items = hinted;
      if (items.length > 1) items = items.slice(0, 1);

      sendResponse({ ok: true, items });
    })().catch((e) => {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e), items: [] });
    });
    return true;
  }
  if (msg.type === 'XIC_EXTRACT') {
    (async () => {
      const r = await extractFromDocumentSmart(document, location.href);
      sendResponse({ ok: true, ...r });
    })().catch((e) => {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    });
    return true;
  }
  return;
});

const BTN_CLASS = 'xic-save-btn';
const BTN_WRAPPER_CLASS = 'xic-save-wrap';
const BTN_WRAPPER_SINGLE = 'xic-save-wrap-single';
const BTN_WRAPPER_GROUP = 'xic-save-wrap-group';
const HOST_CLASS = 'xic-save-host';
const STYLE_ID = 'xic-style';
const BOUND_ATTR = 'data-xic-bound';
const GROUP_BOUND_ATTR = 'data-xic-group-bound';
const mediaByButton = new WeakMap<HTMLButtonElement, Element>();
const groupByButton = new WeakMap<HTMLButtonElement, Element>();
const groupSingleByButton = new WeakMap<HTMLButtonElement, Element>();
const NOTE_ID = 'xic-toast';
const QUEUE_ID = 'xic-queue';
const QUEUE_PANEL_CLASS = 'xic-queue-panel';
const QUEUE_HEADER_CLASS = 'xic-queue-header';
const QUEUE_TITLE_CLASS = 'xic-queue-title';
const QUEUE_ACTIONS_CLASS = 'xic-queue-actions';
const QUEUE_CLEAR_CLASS = 'xic-queue-clear';
const QUEUE_CLOSE_CLASS = 'xic-queue-close';
const QUEUE_SUMMARY_CLASS = 'xic-queue-summary';
const QUEUE_LIST_CLASS = 'xic-queue-list';
const QUEUE_ITEM_CLASS = 'xic-queue-item';
const QUEUE_NAME_CLASS = 'xic-queue-name';
const QUEUE_STATUS_CLASS = 'xic-queue-status';
const QUEUE_META_CLASS = 'xic-queue-meta';
const QUEUE_BAR_CLASS = 'xic-queue-bar';
const QUEUE_BAR_INNER_CLASS = 'xic-queue-bar-inner';
const QUEUE_TOGGLE_CLASS = 'xic-queue-toggle';
const QUEUE_TOGGLE_TEXT_CLASS = 'xic-queue-toggle-text';
const QUEUE_TOGGLE_COUNT_CLASS = 'xic-queue-toggle-count';
const DEBUG = (() => {
  try {
    const fromQuery = new URLSearchParams(location.search).get('clipnest_debug');
    if (fromQuery === '1' || String(fromQuery).toLowerCase() === 'true') return true;
    const fromStorage = window.localStorage?.getItem('clipnest_debug');
    if (fromStorage === '1' || String(fromStorage).toLowerCase() === 'true') return true;
  } catch {
    // ignore
  }
  return false;
})();
const DEFAULT_SERVER_URL = 'http://localhost:5174';
const PROGRESS_POLL_INTERVAL_MS = 800;
const PROGRESS_MAX_AGE_MS = 15 * 60 * 1000;
const QUEUED_STALE_MS = 1800;
const SUPPRESS_TTL_MS = 30 * 60 * 1000;

type SaveMode = 'single' | 'group' | 'group-active';

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .${BTN_WRAPPER_CLASS} {
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 2147483647;
      display: flex;
      gap: 6px;
      transition: opacity 140ms ease, transform 180ms ease;
    }
    .${BTN_WRAPPER_SINGLE} {
      left: 8px;
      right: auto;
    }
    .${BTN_WRAPPER_GROUP} {
      right: 8px;
      left: auto;
      flex-direction: column;
      align-items: flex-end;
    }
    .${BTN_WRAPPER_CLASS}[data-site="pixiv"],
    .${BTN_WRAPPER_CLASS}[data-site="x"],
    .${BTN_WRAPPER_CLASS}[data-site="xiaohongshu"],
    .${BTN_WRAPPER_CLASS}[data-site="youtube"] {
      opacity: 0;
      transform: translateY(-4px) scale(0.98);
      pointer-events: none;
    }
    .${HOST_CLASS}:hover > .${BTN_WRAPPER_CLASS}[data-site="pixiv"],
    .${HOST_CLASS}:hover > .${BTN_WRAPPER_CLASS}[data-site="x"],
    .${HOST_CLASS}:hover > .${BTN_WRAPPER_CLASS}[data-site="xiaohongshu"],
    .${HOST_CLASS}:hover > .${BTN_WRAPPER_CLASS}[data-site="youtube"] {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: auto;
    }
    .${BTN_WRAPPER_CLASS}[data-site="pixiv"][data-role="single"] {
      top: auto;
      bottom: 6px;
      right: 6px;
      left: auto;
    }
    .${BTN_WRAPPER_CLASS}[data-site="x"][data-role="single"] {
      top: auto;
      bottom: 6px;
      left: 6px;
      right: auto;
    }
    .${BTN_WRAPPER_CLASS}[data-site="xiaohongshu"][data-role="single"] {
      top: 8px;
      right: 8px;
      left: auto;
      bottom: auto;
    }
    .${BTN_WRAPPER_CLASS}[data-site="youtube"][data-role="single"] {
      top: 10px;
      left: 10px;
      right: auto;
      bottom: auto;
    }
    .${BTN_WRAPPER_CLASS}[data-site="pixiv"][data-role="group"],
    .${BTN_WRAPPER_CLASS}[data-site="x"][data-role="group"] {
      top: 6px;
      left: 6px;
      right: auto;
      flex-direction: row;
      align-items: center;
      gap: 4px;
    }
    .${BTN_CLASS} {
      border: 1px solid rgba(15, 23, 42, 0.18);
      background: rgba(255, 255, 255, 0.92);
      color: #0f172a;
      font-size: 11px;
      padding: 6px 10px;
      border-radius: 999px;
      cursor: pointer;
      font-family: system-ui, -apple-system, Segoe UI, sans-serif;
      letter-spacing: 0.02em;
      pointer-events: auto;
      box-shadow: 0 8px 20px rgba(15, 23, 42, 0.16);
      backdrop-filter: blur(6px);
    }
    .${BTN_CLASS}[data-site="pixiv"],
    .${BTN_CLASS}[data-site="x"],
    .${BTN_CLASS}[data-site="xiaohongshu"],
    .${BTN_CLASS}[data-site="youtube"] {
      font-size: 9px;
      padding: 3px 6px;
      border-radius: 10px;
      box-shadow: 0 4px 10px rgba(15, 23, 42, 0.12);
    }
    .${BTN_CLASS}:hover {
      border-color: rgba(59, 130, 246, 0.4);
      background: linear-gradient(135deg, rgba(255,255,255,0.98), rgba(224,242,255,0.9));
    }
    .${BTN_CLASS}[data-busy="1"] {
      opacity: 0.7;
    }
    #${NOTE_ID} {
      position: fixed;
      bottom: 22px;
      right: 406px;
      z-index: 2147483647;
      background: linear-gradient(135deg, rgba(255, 255, 255, 0.98), rgba(246, 250, 255, 0.94));
      color: #0f172a;
      border: 1px solid rgba(96, 165, 250, 0.22);
      border-radius: 14px;
      padding: 10px 12px;
      font-size: 12px;
      font-family: system-ui, -apple-system, Segoe UI, sans-serif;
      line-height: 1.45;
      max-width: 280px;
      box-shadow: 0 22px 44px rgba(15, 23, 42, 0.16);
      backdrop-filter: blur(14px);
    }
    #${QUEUE_ID} {
      position: fixed;
      bottom: 18px;
      right: 18px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      font-family: system-ui, -apple-system, Segoe UI, sans-serif;
    }
    #${QUEUE_ID}[data-empty="1"] {
      display: none;
    }
    .${QUEUE_TOGGLE_CLASS} {
      border: 1px solid rgba(96, 165, 250, 0.18);
      background: linear-gradient(135deg, rgba(255, 255, 255, 0.98), rgba(242, 247, 255, 0.94));
      color: #0f172a;
      border-radius: 999px;
      padding: 10px 14px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-size: 12px;
      box-shadow: 0 16px 34px rgba(15, 23, 42, 0.15);
      backdrop-filter: blur(14px);
    }
    .${QUEUE_TOGGLE_CLASS}:hover {
      border-color: rgba(59, 130, 246, 0.36);
      background: linear-gradient(135deg, rgba(255,255,255,1), rgba(230,244,255,0.98));
      transform: translateY(-1px);
    }
    .${QUEUE_TOGGLE_TEXT_CLASS} {
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .${QUEUE_TOGGLE_COUNT_CLASS} {
      font-weight: 600;
      font-size: 11px;
      padding: 3px 7px;
      border-radius: 999px;
      color: #f8fafc;
      background: linear-gradient(135deg, #0f172a, #2563eb);
    }
    .${QUEUE_PANEL_CLASS} {
      width: 386px;
      background:
        radial-gradient(circle at top right, rgba(191, 219, 254, 0.45), transparent 32%),
        linear-gradient(160deg, rgba(255, 255, 255, 0.98), rgba(245, 249, 255, 0.94));
      color: #0f172a;
      border: 1px solid rgba(148, 163, 184, 0.24);
      border-radius: 20px;
      padding: 14px 14px 12px;
      font-size: 12px;
      box-shadow: 0 28px 60px rgba(15, 23, 42, 0.16);
      backdrop-filter: blur(18px);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    #${QUEUE_ID}[data-hidden="1"] .${QUEUE_PANEL_CLASS} {
      display: none;
    }
    #${QUEUE_ID}[data-hidden="1"] .${QUEUE_TOGGLE_CLASS} {
      display: inline-flex;
    }
    #${QUEUE_ID}:not([data-hidden="1"]) .${QUEUE_TOGGLE_CLASS} {
      display: none;
    }
    .${QUEUE_HEADER_CLASS} {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .${QUEUE_TITLE_CLASS} {
      font-weight: 700;
      font-size: 13px;
      letter-spacing: 0.03em;
    }
    .${QUEUE_ACTIONS_CLASS} {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .${QUEUE_CLEAR_CLASS},
    .${QUEUE_CLOSE_CLASS} {
      border: 1px solid rgba(148, 163, 184, 0.22);
      background: rgba(255, 255, 255, 0.88);
      color: #0f172a;
      font-size: 11px;
      border-radius: 999px;
      padding: 4px 10px;
      cursor: pointer;
      transition: border-color 140ms ease, transform 140ms ease, background 140ms ease;
    }
    .${QUEUE_CLEAR_CLASS}:hover,
    .${QUEUE_CLOSE_CLASS}:hover {
      border-color: rgba(59, 130, 246, 0.35);
      color: #1d4ed8;
      background: rgba(239, 246, 255, 0.95);
      transform: translateY(-1px);
    }
    .${QUEUE_SUMMARY_CLASS} {
      font-size: 11px;
      color: rgba(15, 23, 42, 0.62);
      line-height: 1.5;
    }
    .${QUEUE_LIST_CLASS} {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-height: 360px;
      overflow: auto;
      padding-right: 4px;
    }
    .${QUEUE_ITEM_CLASS} {
      border: 1px solid rgba(148, 163, 184, 0.16);
      border-radius: 16px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 7px;
      background: rgba(255, 255, 255, 0.82);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8);
    }
    .${QUEUE_ITEM_CLASS}[data-status="done"] {
      border-color: rgba(16, 185, 129, 0.35);
      background: rgba(236, 253, 245, 0.9);
    }
    .${QUEUE_ITEM_CLASS}[data-status="exists"] {
      border-color: rgba(59, 130, 246, 0.3);
      background: rgba(239, 246, 255, 0.9);
    }
    .${QUEUE_ITEM_CLASS}[data-status="failed"] {
      border-color: rgba(248, 113, 113, 0.45);
      background: rgba(254, 242, 242, 0.95);
    }
    .${QUEUE_NAME_CLASS} {
      font-weight: 700;
      font-size: 12px;
      color: #0f172a;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .${QUEUE_META_CLASS} {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 11px;
      color: rgba(15, 23, 42, 0.7);
    }
    .${QUEUE_STATUS_CLASS} {
      font-weight: 500;
    }
    .${QUEUE_BAR_CLASS} {
      position: relative;
      width: 100%;
      height: 7px;
      border-radius: 999px;
      background: rgba(148, 163, 184, 0.18);
      overflow: hidden;
    }
    .${QUEUE_BAR_INNER_CLASS} {
      position: absolute;
      inset: 0 auto 0 0;
      width: 0%;
      background: linear-gradient(90deg, rgba(96, 165, 250, 0.28), rgba(37, 99, 235, 0.96));
      transition: width 0.24s ease;
    }
    .${QUEUE_BAR_CLASS}[data-indeterminate="1"] .${QUEUE_BAR_INNER_CLASS} {
      width: 40%;
      animation: xic-queue-indeterminate 1.1s ease-in-out infinite;
    }
    @keyframes xic-queue-indeterminate {
      0% {
        transform: translateX(-120%);
      }
      60% {
        transform: translateX(40%);
      }
      100% {
        transform: translateX(220%);
      }
    }
  `;
  document.head.appendChild(style);
}

function findAnchorForMedia(
  mediaEl: Element,
  siteId: ReturnType<typeof detectSite>,
  locHref: string,
): HTMLElement | null {
  if (siteId === 'x') {
    const found = mediaEl.closest('[data-testid="tweetPhoto"], [data-testid="videoPlayer"]');
    if (found instanceof HTMLElement) return found;
  }

  let anchor: HTMLElement | null = null;
  if (mediaEl instanceof HTMLImageElement || mediaEl instanceof HTMLVideoElement) {
    anchor = mediaEl.closest<HTMLElement>('figure, picture, a') ?? mediaEl.parentElement;
  } else {
    anchor = mediaEl.closest<HTMLElement>('figure, picture, a, div');
  }

  if (anchor instanceof HTMLImageElement || anchor instanceof HTMLVideoElement) {
    anchor = anchor.parentElement;
  }

  if (!anchor && mediaEl instanceof HTMLElement) {
    anchor = mediaEl.parentElement ?? null;
  }

  if (!anchor) return null;

  const count = findMediaCandidates(anchor, locHref).length;
  if (count > 1 && mediaEl instanceof HTMLElement) {
    const parent = mediaEl.parentElement;
    if (parent && parent !== anchor) {
      const parentCount = findMediaCandidates(parent, locHref).length;
      if (parentCount <= count) anchor = parent;
    }
  }

  return anchor;
}

function ensureRelative(el: HTMLElement) {
  const style = window.getComputedStyle(el);
  if (style.position === 'static') {
    el.style.position = 'relative';
  }
  if (style.pointerEvents === 'none') {
    el.style.pointerEvents = 'auto';
  }
}

function ensureClickableChain(el: HTMLElement) {
  let cur: HTMLElement | null = el;
  while (cur && cur !== document.body) {
    const style = window.getComputedStyle(cur);
    if (style.pointerEvents === 'none') {
      cur.style.pointerEvents = 'auto';
    }
    if (cur.tagName === 'ARTICLE') break;
    cur = cur.parentElement;
  }
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

function isVisibleElement(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const opacity = Number(style.opacity);
  if (Number.isFinite(opacity) && opacity <= 0.01) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 12 || rect.height < 12) return false;
  return true;
}

function pickActiveCandidate(candidates: MediaCandidate[]): MediaCandidate | null {
  if (!candidates.length) return null;
  let best: MediaCandidate | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const el = candidate.element;
    if (!isVisibleElement(el)) continue;
    const rect = el.getBoundingClientRect();
    const score = rect.width * rect.height;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (best) return best;
  return candidates[0] ?? null;
}

function isXDetailUrl(href = location.href): boolean {
  try {
    const u = new URL(href);
    return u.pathname.includes('/status/') || u.pathname.includes('/i/status/');
  } catch {
    return href.includes('/status/') || href.includes('/i/status/');
  }
}

function isXiaohongshuDetailUrl(href = location.href): boolean {
  try {
    const u = new URL(href);
    return (
      /^\/explore\/[^/]+/i.test(u.pathname) ||
      /^\/discovery\/item\/[^/]+/i.test(u.pathname) ||
      /^\/item\/[^/]+/i.test(u.pathname)
    );
  } catch {
    return /\/(explore|discovery\/item|item)\//i.test(href);
  }
}

function isYouTubeDetailUrl(href = location.href): boolean {
  try {
    const u = new URL(href);
    const host = u.hostname.toLowerCase();
    if (!(host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be' || host.endsWith('.youtu.be'))) {
      return false;
    }
    if (host === 'youtu.be' || host.endsWith('.youtu.be')) return true;
    if (u.pathname.startsWith('/watch')) return Boolean(u.searchParams.get('v'));
    if (/^\/shorts\/[^/]+/i.test(u.pathname)) return true;
    if (/^\/live\/[^/]+/i.test(u.pathname)) return true;
    return false;
  } catch {
    return /youtube\.com\/watch\?/.test(href) || /youtube\.com\/shorts\//.test(href) || /youtu\.be\//.test(href);
  }
}

function extractYouTubeVideoIdFromUrl(href = location.href): string | null {
  try {
    const u = new URL(href);
    const host = u.hostname.toLowerCase();
    if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
      const seg = u.pathname.split('/').filter(Boolean)[0];
      return seg ? seg.trim() : null;
    }
    const v = u.searchParams.get('v');
    if (v) return v.trim();
    const shorts = u.pathname.match(/^\/shorts\/([^/?#]+)/i);
    if (shorts?.[1]) return shorts[1].trim();
    const live = u.pathname.match(/^\/live\/([^/?#]+)/i);
    if (live?.[1]) return live[1].trim();
  } catch {
    // ignore
  }
  return null;
}

function normalizeYouTubeWatchUrl(videoId?: string | null): string {
  const id = String(videoId ?? '').trim();
  if (id) return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  return location.href;
}

function sanitizeDisplayName(value: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return 'youtube-video';
  const sanitized = trimmed.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!sanitized) return 'youtube-video';
  return sanitized.slice(0, 96);
}

function extractJsonObjectAfterMarker(text: string, marker: string): string | null {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  let start = markerIndex + marker.length;
  while (start < text.length && text[start] !== '{') start += 1;
  if (start >= text.length || text[start] !== '{') return null;

  let depth = 0;
  let inString = false;
  let quoteChar = '';
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quoteChar) {
        inString = false;
        quoteChar = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quoteChar = ch;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function parseJsonObjectAfterMarker(text: string, marker: string): any | null {
  const raw = extractJsonObjectAfterMarker(text, marker);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

type YouTubeStream = {
  url: string;
  mimeType: string;
  container: string;
  mediaKind: 'video' | 'audio' | 'other';
  itag?: number;
  bitrate?: number;
  width?: number;
  height?: number;
  fps?: number;
  qualityLabel?: string;
  hasAudio: boolean;
};

function isBlockedYouTubePlaybackUrl(rawUrl: string): boolean {
  const raw = String(rawUrl ?? '').trim();
  if (!raw) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if (host === 'redirector.googlevideo.com' || host.endsWith('.redirector.googlevideo.com')) {
      return true;
    }
    const isGoogleVideo = host === 'googlevideo.com' || host.endsWith('.googlevideo.com');
    if (!isGoogleVideo || !path.includes('videoplayback')) return false;
    const client = (u.searchParams.get('c') ?? '').trim().toUpperCase();
    const sabr = (u.searchParams.get('sabr') ?? '').trim();
    return client === 'WEB' && sabr === '1';
  } catch {
    return false;
  }
}

function isYouTubeManifestLikeUrl(rawUrl: string): boolean {
  const raw = String(rawUrl ?? '').trim();
  if (!raw || !isHttpUrl(raw)) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const query = u.search.toLowerCase();
    const isYouTubeHost =
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'googlevideo.com' ||
      host.endsWith('.googlevideo.com');
    if (!isYouTubeHost) return false;
    if (/\.(?:m3u8|mpd)(?:$|[?#])/i.test(raw)) return true;
    if (/\/manifest\/|\/api\/manifest\//i.test(path)) return true;
    if (/[?&](?:manifest|playlist|hls|dash)=/i.test(query)) return true;
    return false;
  } catch {
    return false;
  }
}

function isYouTubeMediaCandidateUrl(rawUrl: string): boolean {
  const raw = String(rawUrl ?? '').trim();
  if (!raw || !isHttpUrl(raw)) return false;
  if (isBlockedYouTubePlaybackUrl(raw)) return false;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const query = u.search.toLowerCase();
    const isGoogleVideo = host === 'googlevideo.com' || host.endsWith('.googlevideo.com');
    const isYouTubeHost = host === 'youtube.com' || host.endsWith('.youtube.com');
    if (isGoogleVideo) {
      return /videoplayback|manifest|\.m3u8|\.mpd/i.test(`${path}${query}`);
    }
    if (isYouTubeHost) {
      return /\/manifest\/|\/api\/manifest\/|\.m3u8|\.mpd/i.test(`${path}${query}`);
    }
    return false;
  } catch {
    return false;
  }
}

function collectYouTubeManifestUrls(response: any): string[] {
  const normalized = normalizeYouTubePlayerResponse(response);
  const urls: string[] = [];
  const seen = new Set<string>();
  const push = (raw?: string | null) => {
    const value = String(raw ?? '').trim();
    if (!value || !isYouTubeMediaCandidateUrl(value)) return;
    if (seen.has(value)) return;
    seen.add(value);
    urls.push(value);
  };
  if (normalized?.streamingData) {
    push(normalized.streamingData.dashManifestUrl);
    push(normalized.streamingData.hlsManifestUrl);
  }
  return urls;
}

function resolveYouTubeStreamUrl(raw: any): { url?: string; needsDecipher: boolean } {
  const directUrl = typeof raw?.url === 'string' ? raw.url.trim() : '';
  if (directUrl) {
    return isYouTubeMediaCandidateUrl(directUrl) ? { url: directUrl, needsDecipher: false } : { needsDecipher: false };
  }

  const cipher = typeof raw?.signatureCipher === 'string' ? raw.signatureCipher : typeof raw?.cipher === 'string' ? raw.cipher : '';
  if (!cipher) return { needsDecipher: false };
  try {
    const params = new URLSearchParams(cipher);
    const base = params.get('url');
    if (!base) return { needsDecipher: false };
    const sig = params.get('sig') || params.get('signature');
    const encrypted = params.get('s');
    if (!sig && encrypted) {
      return { needsDecipher: true };
    }
    const sp = params.get('sp') || 'signature';
    const u = new URL(base);
    if (sig) u.searchParams.set(sp, sig);
    const resolvedUrl = u.toString();
    return isYouTubeMediaCandidateUrl(resolvedUrl) ? { url: resolvedUrl, needsDecipher: false } : { needsDecipher: false };
  } catch {
    return { needsDecipher: false };
  }
}

function toYouTubeStream(raw: any): YouTubeStream | null {
  const resolved = resolveYouTubeStreamUrl(raw);
  if (!resolved.url || resolved.needsDecipher) return null;
  const url = resolved.url.trim();
  if (!isHttpUrl(url)) return null;

  const mimeType = typeof raw?.mimeType === 'string' ? raw.mimeType : '';
  const mimeMain = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  const [kind, subtype] = mimeMain.split('/');
  const codecs = mimeType.match(/codecs="([^"]+)"/i)?.[1] ?? '';
  const hasAudio =
    Boolean(raw?.audioQuality) ||
    Number(raw?.audioChannels ?? 0) > 0 ||
    /mp4a|opus|vorbis|aac/i.test(codecs) ||
    String(kind) === 'audio';

  const mediaKind: 'video' | 'audio' | 'other' =
    kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'other';

  return {
    url,
    mimeType,
    container: String(subtype ?? '').trim().toLowerCase(),
    mediaKind,
    itag: Number.isFinite(Number(raw?.itag)) ? Number(raw.itag) : undefined,
    bitrate: Number.isFinite(Number(raw?.bitrate)) ? Number(raw.bitrate) : undefined,
    width: Number.isFinite(Number(raw?.width)) ? Number(raw.width) : undefined,
    height: Number.isFinite(Number(raw?.height)) ? Number(raw.height) : undefined,
    fps: Number.isFinite(Number(raw?.fps)) ? Number(raw.fps) : undefined,
    qualityLabel: typeof raw?.qualityLabel === 'string' ? raw.qualityLabel : undefined,
    hasAudio,
  };
}

function rankYouTubeVideos(a: YouTubeStream, b: YouTubeStream): number {
  const aMp4 = a.container === 'mp4' ? 1 : 0;
  const bMp4 = b.container === 'mp4' ? 1 : 0;
  if (bMp4 !== aMp4) return bMp4 - aMp4;
  const aPx = (a.width ?? 0) * (a.height ?? 0);
  const bPx = (b.width ?? 0) * (b.height ?? 0);
  if (bPx !== aPx) return bPx - aPx;
  const aFps = a.fps ?? 0;
  const bFps = b.fps ?? 0;
  if (bFps !== aFps) return bFps - aFps;
  const aBitrate = a.bitrate ?? 0;
  const bBitrate = b.bitrate ?? 0;
  if (bBitrate !== aBitrate) return bBitrate - aBitrate;
  const aWithAudio = a.hasAudio ? 1 : 0;
  const bWithAudio = b.hasAudio ? 1 : 0;
  return bWithAudio - aWithAudio;
}

function rankYouTubeAudios(a: YouTubeStream, b: YouTubeStream): number {
  const aMp4 = a.container === 'mp4' ? 1 : 0;
  const bMp4 = b.container === 'mp4' ? 1 : 0;
  if (bMp4 !== aMp4) return bMp4 - aMp4;
  const aBitrate = a.bitrate ?? 0;
  const bBitrate = b.bitrate ?? 0;
  return bBitrate - aBitrate;
}

function findYouTubePlayerResponse(doc: Document = document): any | null {
  const markers = [
    'ytInitialPlayerResponse =',
    'var ytInitialPlayerResponse =',
    'window["ytInitialPlayerResponse"] =',
    'window.ytInitialPlayerResponse =',
  ];

  const scripts = Array.from(doc.querySelectorAll<HTMLScriptElement>('script'));
  for (const script of scripts) {
    const text = script.textContent ?? '';
    if (!text) continue;
    for (const marker of markers) {
      if (!text.includes(marker)) continue;
      const parsed = parseJsonObjectAfterMarker(text, marker);
      if (parsed?.streamingData) return parsed;
    }
    if (text.includes('"playerResponse":')) {
      const parsed = parseJsonObjectAfterMarker(text, '"playerResponse":');
      if (parsed?.streamingData) return parsed;
    }
  }

  const html = doc.documentElement?.innerHTML ?? '';
  for (const marker of markers) {
    if (!html.includes(marker)) continue;
    const parsed = parseJsonObjectAfterMarker(html, marker);
    if (parsed?.streamingData) return parsed;
  }

  return null;
}

function findYouTubePlayerHost(): HTMLElement | null {
  const hostSelectors = ['#movie_player', 'ytd-player', 'ytd-reel-video-renderer', 'ytd-shorts-player'];
  for (const selector of hostSelectors) {
    const host = document.querySelector(selector);
    if (host instanceof HTMLElement && isVisibleElement(host)) return host;
  }
  const video = document.querySelector('video.html5-main-video, ytd-reel-video-renderer video, ytd-player video');
  if (video instanceof HTMLVideoElement) {
    const host = video.closest('#movie_player, ytd-player, ytd-reel-video-renderer, ytd-shorts-player');
    if (host instanceof HTMLElement) return host;
    if (video.parentElement instanceof HTMLElement) return video.parentElement;
  }
  return null;
}

function extractYouTubeTags(playerResponse: any): string[] {
  const set = new Set<string>();
  const keywords = playerResponse?.videoDetails?.keywords;
  if (Array.isArray(keywords)) {
    for (const keyword of keywords) {
      const tag = String(keyword ?? '').trim();
      if (tag) set.add(tag);
      if (set.size >= 40) break;
    }
  }
  const metaKeywords = document.querySelector<HTMLMetaElement>('meta[name="keywords"]')?.content ?? '';
  if (metaKeywords.trim()) {
    for (const raw of metaKeywords.split(',')) {
      const tag = raw.trim();
      if (tag) set.add(tag);
      if (set.size >= 40) break;
    }
  }
  return Array.from(set);
}

function normalizeYouTubePlayerResponse(candidate: any): any | null {
  if (!candidate) return null;

  const tryParse = (value: any): any | null => {
    if (!value) return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const direct = tryParse(candidate);
  if (direct?.streamingData) return direct;
  if (direct?.playerResponse) {
    const nested = tryParse(direct.playerResponse);
    if (nested?.streamingData) return nested;
  }
  return null;
}

function buildYouTubeVideoItemsFromResponse(response: any): IngestItem[] {
  const normalized = normalizeYouTubePlayerResponse(response);
  if (!normalized) return [];
  const responseObj = normalized;
  const streamingData = responseObj?.streamingData;
  if (!streamingData) return [];

  const formats = Array.isArray(streamingData?.formats) ? streamingData.formats : [];
  const adaptiveFormats = Array.isArray(streamingData?.adaptiveFormats) ? streamingData.adaptiveFormats : [];
  const allRaw = [...formats, ...adaptiveFormats];
  const streams = allRaw.map((raw) => toYouTubeStream(raw)).filter(Boolean) as YouTubeStream[];
  const dashManifestUrlRaw = typeof streamingData?.dashManifestUrl === 'string' ? streamingData.dashManifestUrl.trim() : '';
  const dashManifestUrl = isHttpUrl(dashManifestUrlRaw) ? dashManifestUrlRaw : '';
  const hlsManifestUrlRaw = typeof streamingData?.hlsManifestUrl === 'string' ? streamingData.hlsManifestUrl.trim() : '';
  const hlsManifestUrl = isHttpUrl(hlsManifestUrlRaw) ? hlsManifestUrlRaw : '';

  const videoStreams = streams.filter((stream) => stream.mediaKind === 'video').sort(rankYouTubeVideos);
  const primaryVideo = videoStreams[0];

  const audioStreams = streams.filter((stream) => stream.mediaKind === 'audio').sort(rankYouTubeAudios);
  const primaryAudio = primaryVideo && !primaryVideo.hasAudio ? audioStreams[0] : undefined;
  const alternateVideoUrls = videoStreams
    .slice(primaryVideo ? 1 : 0)
    .map((stream) => stream.url)
    .filter((url) => url && url !== primaryVideo?.url)
    .slice(0, 8);
  const alternateAudioUrls = audioStreams
    .slice(primaryAudio ? 1 : 0)
    .map((stream) => stream.url)
    .filter((url) => url && url !== primaryAudio?.url)
    .slice(0, 6);

  const videoId = String(responseObj?.videoDetails?.videoId ?? '').trim() || extractYouTubeVideoIdFromUrl(location.href);
  const sourceUrl = normalizeYouTubeWatchUrl(videoId);
  const title = String(responseObj?.videoDetails?.title ?? document.title ?? '').trim();
  const author = String(responseObj?.videoDetails?.author ?? '').trim() || undefined;
  const qualityLabel = primaryVideo?.qualityLabel ?? (dashManifestUrl ? 'DASH' : hlsManifestUrl ? 'HLS' : undefined);
  const tags = extractYouTubeTags(responseObj);
  const resolvedMediaUrl = dashManifestUrl || hlsManifestUrl || primaryVideo?.url;
  if (!resolvedMediaUrl || !isHttpUrl(resolvedMediaUrl)) return [];
  const mergedAlternateVideoUrls: string[] = [];
  const pushAltVideoUrl = (url?: string | null) => {
    const value = String(url ?? '').trim();
    if (!value || value === resolvedMediaUrl || mergedAlternateVideoUrls.includes(value)) return;
    mergedAlternateVideoUrls.push(value);
  };
  pushAltVideoUrl(dashManifestUrl);
  pushAltVideoUrl(hlsManifestUrl);
  pushAltVideoUrl(primaryVideo?.url);
  alternateVideoUrls.forEach((url) => pushAltVideoUrl(url));
  const displayName = sanitizeDisplayName(
    `${title || videoId || 'youtube-video'}${qualityLabel ? `_${qualityLabel}` : ''}.mp4`,
  );

  return [
    {
      sourcePageUrl: sourceUrl,
      tweetUrl: sourceUrl,
      authorHandle: author,
      mediaUrl: resolvedMediaUrl,
      mediaType: 'video',
      collectedAt: new Date().toISOString(),
      context: {
        site: 'youtube',
        referer: location.href,
        pageTitle: title || undefined,
        tags,
        alternateMediaUrls: mergedAlternateVideoUrls,
        youtubeAudioUrl: primaryAudio?.url,
        youtubeAudioAltUrls: alternateAudioUrls,
        youtubeQualityLabel: qualityLabel,
        displayName,
      },
    },
  ];
}

function findYouTubeVideoElementUrl(targetEl: Element): string | null {
  const videos = new Set<HTMLVideoElement>();
  if (targetEl instanceof HTMLVideoElement) videos.add(targetEl);
  targetEl.querySelectorAll?.('video').forEach((video) => {
    if (video instanceof HTMLVideoElement) videos.add(video);
  });
  document.querySelectorAll('video.html5-main-video, ytd-player video, ytd-shorts-player video').forEach((video) => {
    if (video instanceof HTMLVideoElement) videos.add(video);
  });

  const candidates: string[] = [];
  for (const video of videos) {
    const push = (raw?: string | null) => {
      const value = String(raw ?? '').trim();
      if (!value || value.startsWith('blob:') || value.startsWith('data:')) return;
      if (isYouTubeMediaCandidateUrl(value)) candidates.push(value);
    };
    push(video.currentSrc);
    push(video.src);
    Array.from(video.querySelectorAll('source')).forEach((source) => push((source as HTMLSourceElement).src));
  }

  if (!candidates.length) return null;
  const best =
    candidates.find((url) => isYouTubeManifestLikeUrl(url)) ??
    candidates.find((url) => /googlevideo\.com/i.test(url)) ??
    candidates[0];
  return best && isHttpUrl(best) ? best : null;
}

type YouTubePerfMedia = {
  url: string;
  kind: 'video' | 'audio' | 'other';
  qualityLabel?: string;
  contentLength?: number;
  ts: number;
};

const YOUTUBE_AUDIO_ITAGS = new Set([
  139, 140, 141, 171, 172, 249, 250, 251, 256, 258, 325, 328, 599, 600,
]);

function normalizeYouTubePlaybackUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    // Keep signed params intact; only drop explicit byte range so server can request full payload.
    // Removing signed params like `rqh` can cause 403 on googlevideo URLs.
    u.searchParams.delete('range');
    return u.toString();
  } catch {
    return rawUrl;
  }
}

function parseYouTubePerfKind(url: URL): 'video' | 'audio' | 'other' {
  const mimeRaw = decodeURIComponent(url.searchParams.get('mime') ?? url.searchParams.get('type') ?? '').toLowerCase();
  if (mimeRaw.startsWith('audio/')) return 'audio';
  if (mimeRaw.startsWith('video/')) return 'video';
  const itag = Number(url.searchParams.get('itag') ?? NaN);
  if (Number.isFinite(itag) && YOUTUBE_AUDIO_ITAGS.has(itag)) return 'audio';
  if (url.pathname.toLowerCase().includes('videoplayback')) return 'video';
  if (
    url.pathname.toLowerCase().includes('.m3u8') ||
    url.pathname.toLowerCase().includes('.mpd') ||
    url.pathname.toLowerCase().includes('/manifest/')
  ) {
    return 'video';
  }
  return 'other';
}

function parseYouTubeMediaFromUrl(rawUrl: string, ts = Date.now()): YouTubePerfMedia | null {
  const raw = String(rawUrl ?? '').trim();
  if (!raw) return null;
  if (!isYouTubeMediaCandidateUrl(raw)) return null;
  try {
    const u = new URL(raw);
    const qualityLabelRaw = u.searchParams.get('quality_label') ?? u.searchParams.get('quality') ?? '';
    const clen = Number(u.searchParams.get('clen') ?? NaN);
    return {
      url: normalizeYouTubePlaybackUrl(raw),
      kind: parseYouTubePerfKind(u),
      qualityLabel: qualityLabelRaw ? qualityLabelRaw.trim() : undefined,
      contentLength: Number.isFinite(clen) && clen > 0 ? clen : undefined,
      ts,
    };
  } catch {
    return null;
  }
}

function collectYouTubeMediaFromPerformance(maxAgeMs = 60_000): YouTubePerfMedia[] {
  const now = performance.now();
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  const dedup = new Map<string, YouTubePerfMedia>();

  for (const entry of entries) {
    const raw = String((entry as any)?.name ?? '').trim();
    if (!raw) continue;
    const age = now - (Number.isFinite(entry.responseEnd) ? entry.responseEnd : now);
    if (Number.isFinite(age) && age > maxAgeMs) continue;
    const media = parseYouTubeMediaFromUrl(raw, Date.now() - Math.max(0, age));
    if (!media) continue;
    const key = `${media.kind}|${media.url}`;
    const existing = dedup.get(key);
    if (!existing || (media.contentLength ?? 0) > (existing.contentLength ?? 0)) {
      dedup.set(key, media);
    }
  }

  return Array.from(dedup.values());
}

function qualityLabelScore(label?: string): number {
  const raw = String(label ?? '').trim().toLowerCase();
  if (!raw) return 0;
  const p = raw.match(/(\d{3,4})p/i);
  if (p?.[1]) return Number(p[1]);
  const hd = raw.match(/(\d{3,4})/);
  if (hd?.[1]) return Number(hd[1]);
  if (raw.includes('high')) return 720;
  if (raw.includes('medium')) return 480;
  if (raw.includes('low')) return 360;
  return 0;
}

function scoreYouTubePerfVideo(item: YouTubePerfMedia): number {
  let score = 0;
  if (/\.mpd(\?|$)|\/manifest\/dash(?:\/|$)|\/api\/manifest\/dash(?:\/|$)|[?&](?:manifest|dash)=/i.test(item.url)) {
    score += 12000;
  } else if (/\.m3u8(\?|$)|\/manifest\/hls(?:\/|$)|\/manifest\//i.test(item.url)) {
    score += 10800;
  }
  if (/dash/i.test(item.url)) score += 1800;
  if (/hls/i.test(item.url)) score += 1200;
  if (/googlevideo\.com/i.test(item.url)) score += 1800;
  if (/mime=video/i.test(item.url)) score += 1600;
  if (/videoplayback/i.test(item.url)) score += 800;
  score += qualityLabelScore(item.qualityLabel) * 8;
  if (Number.isFinite(item.contentLength)) {
    score += Math.min(280, Math.floor((item.contentLength ?? 0) / (1024 * 1024)));
  }
  return score;
}

function scoreYouTubePerfAudio(item: YouTubePerfMedia): number {
  let score = 0;
  if (/mime=audio/i.test(item.url)) score += 1800;
  if (/googlevideo\.com/i.test(item.url)) score += 1000;
  if (Number.isFinite(item.contentLength)) {
    score += Math.min(240, Math.floor((item.contentLength ?? 0) / (1024 * 1024)));
  }
  return score;
}

function scoreYouTubePlayerResponse(response: any): number {
  const normalized = normalizeYouTubePlayerResponse(response);
  if (!normalized?.streamingData) return -100000;

  let score = 0;
  const manifests = collectYouTubeManifestUrls(normalized);
  if (manifests.length) {
    score += manifests.some((url) => /\.mpd(?:$|[?#])|\/manifest\/dash|\/api\/manifest\/dash/i.test(url)) ? 14000 : 0;
    score += manifests.some((url) => /\.m3u8(?:$|[?#])|\/manifest\/hls|\/api\/manifest\/hls/i.test(url)) ? 13200 : 0;
    score += manifests.length * 320;
  }

  const formats = Array.isArray(normalized?.streamingData?.formats) ? normalized.streamingData.formats : [];
  const adaptiveFormats = Array.isArray(normalized?.streamingData?.adaptiveFormats) ? normalized.streamingData.adaptiveFormats : [];
  const usableStreams = [...formats, ...adaptiveFormats]
    .map((raw) => toYouTubeStream(raw))
    .filter(Boolean) as YouTubeStream[];

  const videos = usableStreams.filter((stream) => stream.mediaKind === 'video').sort(rankYouTubeVideos);
  const audios = usableStreams.filter((stream) => stream.mediaKind === 'audio').sort(rankYouTubeAudios);
  if (videos.length) {
    score += 7200;
    const bestVideo = videos[0];
    if (bestVideo) {
      score += (bestVideo.width ?? 0) * (bestVideo.height ?? 0) > 0 ? Math.min(2600, Math.floor(((bestVideo.width ?? 0) * (bestVideo.height ?? 0)) / 400)) : 0;
      score += (bestVideo.fps ?? 0) * 4;
      score += bestVideo.hasAudio ? 1200 : 0;
    }
  }
  if (audios.length) score += 1800;
  if (!videos.length && !manifests.length) return -100000;
  return score;
}

function scoreYouTubeIngestItem(item: IngestItem): number {
  let score = 0;
  const mediaUrl = String(item.mediaUrl ?? '').trim();
  const quality = typeof item.context?.youtubeQualityLabel === 'string' ? item.context.youtubeQualityLabel : undefined;
  if (isYouTubeManifestLikeUrl(mediaUrl)) score += 16000;
  if (/googlevideo\.com/i.test(mediaUrl)) score += 8200;
  if (item.context?.youtubeAudioUrl) score += 2200;
  if (Array.isArray(item.context?.alternateMediaUrls)) score += Math.min(item.context.alternateMediaUrls.length, 8) * 110;
  score += qualityLabelScore(quality) * 8;
  return score;
}

function chooseBestYouTubeItemSet(
  groups: Array<{ label: string; items: IngestItem[] }>,
): { label: string; items: IngestItem[] } | null {
  let best: { label: string; items: IngestItem[] } | null = null;
  let bestScore = -100000;
  for (const group of groups) {
    if (!group.items.length) continue;
    const score = Math.max(...group.items.map((item) => scoreYouTubeIngestItem(item)));
    if (!best || score > bestScore) {
      best = group;
      bestScore = score;
    }
  }
  return best;
}

function findYouTubeMainVideo(targetEl: Element): HTMLVideoElement | null {
  if (targetEl instanceof HTMLVideoElement) return targetEl;
  const local = targetEl.querySelector('video.html5-main-video, video');
  if (local instanceof HTMLVideoElement) return local;
  const global = document.querySelector('video.html5-main-video, ytd-player video, ytd-shorts-player video');
  return global instanceof HTMLVideoElement ? global : null;
}

async function nudgeYouTubePlayback(targetEl: Element): Promise<void> {
  const video = findYouTubeMainVideo(targetEl);
  if (!video) return;
  if (!video.paused) {
    await sleep(220);
    return;
  }
  try {
    video.muted = true;
    const played = video.play();
    if (played && typeof (played as Promise<void>).then === 'function') {
      await Promise.race([played, sleep(450)]);
    } else {
      await sleep(220);
    }
    await sleep(420);
    video.pause();
  } catch {
    // autoplay restrictions are expected on some contexts.
  }
}

function buildYouTubeVideoItemsFromMediaCandidates(
  candidates: YouTubePerfMedia[],
  targetEl: Element,
  playerResponse?: any | null,
): IngestItem[] {
  if (!candidates.length) return [];
  const normalizedResponse = normalizeYouTubePlayerResponse(playerResponse);
  const manifestItems: YouTubePerfMedia[] = collectYouTubeManifestUrls(normalizedResponse).map((url) => ({
    url,
    kind: 'video',
    qualityLabel: /\.mpd(?:$|[?#])|\/manifest\/dash(?:\/|$)|\/api\/manifest\/dash(?:\/|$)|[?&](?:manifest|dash)=/i.test(url)
      ? 'DASH'
      : /hls|\.m3u8/i.test(url)
        ? 'HLS'
        : 'Manifest',
    ts: Date.now(),
  }));

  const dedup = new Map<string, YouTubePerfMedia>();
  for (const item of manifestItems) {
    const key = `${item.kind}|${item.url}`;
    dedup.set(key, item);
  }
  for (const item of candidates) {
    if (!item?.url) continue;
    const key = `${item.kind}|${item.url}`;
    const existing = dedup.get(key);
    if (!existing || (item.contentLength ?? 0) > (existing.contentLength ?? 0)) {
      dedup.set(key, item);
    }
  }
  const normalized = Array.from(dedup.values());

  const videos = normalized.filter((item) => item.kind === 'video').sort((a, b) => scoreYouTubePerfVideo(b) - scoreYouTubePerfVideo(a));
  if (!videos.length) return [];
  const primaryVideo = videos[0]!;
  const alternates = videos
    .slice(1)
    .map((item) => item.url)
    .filter((url) => url && url !== primaryVideo.url)
    .slice(0, 8);
  const audios = normalized.filter((item) => item.kind === 'audio').sort((a, b) => scoreYouTubePerfAudio(b) - scoreYouTubePerfAudio(a));
  const primaryAudio = audios[0];
  const audioAlternates = audios
    .slice(primaryAudio ? 1 : 0)
    .map((item) => item.url)
    .filter((url) => url && url !== primaryAudio?.url)
    .slice(0, 6);

  const details = normalizedResponse?.videoDetails ?? null;
  const responseVideoId = String(details?.videoId ?? '').trim();
  const videoId = responseVideoId || extractYouTubeVideoIdFromUrl(location.href);
  const sourceUrl = normalizeYouTubeWatchUrl(videoId);
  const title = String(details?.title ?? document.title ?? '').trim();
  const qualityLabel = primaryVideo.qualityLabel;
  const tags = extractYouTubeTags(normalizedResponse ?? null);
  const displayName = sanitizeDisplayName(
    `${title || videoId || 'youtube-video'}${qualityLabel ? `_${qualityLabel}` : ''}.mp4`,
  );
  const channelMeta =
    document.querySelector<HTMLMetaElement>('meta[itemprop="author"]')?.content ??
    document.querySelector<HTMLMetaElement>('meta[name="author"]')?.content ??
    '';
  const responseAuthor = String(details?.author ?? '').trim();
  const authorHandle = responseAuthor || channelMeta.trim() || undefined;

  const chosenTarget = findYouTubeMainVideo(targetEl);
  const referer = location.href || sourceUrl;
  const pageTitle = title || chosenTarget?.getAttribute('title') || undefined;

  return [
    {
      sourcePageUrl: sourceUrl,
      tweetUrl: sourceUrl,
      authorHandle,
      mediaUrl: primaryVideo.url,
      mediaType: 'video',
      collectedAt: new Date().toISOString(),
      context: {
        site: 'youtube',
        referer,
        pageTitle,
        tags,
        alternateMediaUrls: alternates,
        youtubeAudioUrl: primaryAudio?.url,
        youtubeAudioAltUrls: audioAlternates,
        youtubeQualityLabel: qualityLabel,
        displayName,
      },
    },
  ];
}

function buildYouTubeVideoItemsFromPerformance(targetEl: Element, playerResponse?: any | null): IngestItem[] {
  const perfItems = collectYouTubeMediaFromPerformance();
  return buildYouTubeVideoItemsFromMediaCandidates(perfItems, targetEl, playerResponse);
}

async function requestYouTubeMediaFromBackground(): Promise<YouTubePerfMedia[]> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'XIC_GET_RECENT_YOUTUBE_MEDIA_URLS' });
      const items = Array.isArray(r?.items) ? r.items : [];
      const parsed = items
        .map((raw: any) => {
          const url = typeof raw?.url === 'string' ? raw.url : '';
          const ts = Number.isFinite(raw?.ts) ? Number(raw.ts) : Date.now();
          const media = parseYouTubeMediaFromUrl(url, ts);
          if (!media) return null;
          const kind = raw?.kind === 'video' || raw?.kind === 'audio' || raw?.kind === 'other' ? raw.kind : media.kind;
          const contentLength = Number.isFinite(raw?.contentLength) ? Number(raw.contentLength) : media.contentLength;
          const qualityLabel = typeof raw?.qualityLabel === 'string' ? raw.qualityLabel.trim() || undefined : media.qualityLabel;
          return {
            ...media,
            kind,
            contentLength,
            qualityLabel,
          } as YouTubePerfMedia;
        })
        .filter(Boolean) as YouTubePerfMedia[];
      if (parsed.length) return parsed;
    } catch {
      // ignore and retry
    }
    if (attempt < 2) await sleep(280 + attempt * 220);
  }
  return [];
}

async function requestYouTubePlayerResponseFromBackground(): Promise<{ response: any | null; meta?: any }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'XIC_YOUTUBE_GET_PLAYER_RESPONSE' });
      const normalized = normalizeYouTubePlayerResponse(r?.response);
      if (r?.ok && normalized) return { response: normalized, meta: r?.meta };
    } catch {
      // ignore and retry
    }
    if (attempt < 2) await sleep(450 + attempt * 350);
  }
  return { response: null };
}

async function extractYouTubeVideoItems(targetEl: Element): Promise<IngestItem[]> {
  const trace: Array<Record<string, unknown>> = [];
  const candidateGroups: Array<{ label: string; items: IngestItem[] }> = [];
  const localResponse = findYouTubePlayerResponse(document);
  const localScore = scoreYouTubePlayerResponse(localResponse);
  trace.push({
    stage: 'local-player-response',
    hasResponse: Boolean(localResponse),
    hasStreamingData: Boolean(localResponse?.streamingData),
    score: localScore,
  });

  const localItems = buildYouTubeVideoItemsFromResponse(localResponse);
  if (localItems.length) candidateGroups.push({ label: 'local-player-response', items: localItems });
  trace.push({
    stage: 'local-player-response-primary',
    items: localItems.length,
    score: localItems.length ? scoreYouTubeIngestItem(localItems[0]!) : -1,
  });

  const remotePayload = await requestYouTubePlayerResponseFromBackground();
  const remoteResponse = remotePayload.response;
  const remoteScore = scoreYouTubePlayerResponse(remoteResponse);
  const remoteItems = buildYouTubeVideoItemsFromResponse(remoteResponse);
  if (remoteItems.length) candidateGroups.push({ label: 'background-player-response', items: remoteItems });
  trace.push({
    stage: 'background-player-response-primary',
    hasResponse: Boolean(remoteResponse),
    items: remoteItems.length,
    hasStreamingData: Boolean(remoteResponse?.streamingData),
    score: remoteScore,
    meta: remotePayload.meta ?? null,
  });

  const effectiveResponse = remoteScore > localScore ? remoteResponse : localResponse;

  await nudgeYouTubePlayback(targetEl);
  const perfItems = buildYouTubeVideoItemsFromPerformance(targetEl, effectiveResponse);
  if (perfItems.length) candidateGroups.push({ label: 'performance-fallback', items: perfItems });
  trace.push({
    stage: 'performance-fallback',
    items: perfItems.length,
    score: perfItems.length ? scoreYouTubeIngestItem(perfItems[0]!) : -1,
  });

  const bgMediaCandidates = await requestYouTubeMediaFromBackground();
  const bgMediaItems = buildYouTubeVideoItemsFromMediaCandidates(bgMediaCandidates, targetEl, effectiveResponse);
  if (bgMediaItems.length) candidateGroups.push({ label: 'background-webrequest-fallback', items: bgMediaItems });
  trace.push({
    stage: 'background-webrequest-fallback',
    candidates: bgMediaCandidates.length,
    items: bgMediaItems.length,
    score: bgMediaItems.length ? scoreYouTubeIngestItem(bgMediaItems[0]!) : -1,
  });

  const fallbackUrl = findYouTubeVideoElementUrl(targetEl);
  trace.push({
    stage: 'video-element-fallback',
    hasUrl: Boolean(fallbackUrl),
  });
  if (!fallbackUrl) {
    const bestWithoutFallback = chooseBestYouTubeItemSet(candidateGroups);
    if (!bestWithoutFallback) {
      logDebug('youtube extract failed', trace);
      return [];
    }
    trace.push({
      stage: 'choose-best',
      winner: bestWithoutFallback.label,
      score: bestWithoutFallback.items.length ? scoreYouTubeIngestItem(bestWithoutFallback.items[0]!) : -1,
    });
    logDebug('youtube extract success', trace);
    return bestWithoutFallback.items;
  }
  const videoId = extractYouTubeVideoIdFromUrl(location.href);
  const sourceUrl = normalizeYouTubeWatchUrl(videoId);
  const displayName = sanitizeDisplayName(`${videoId || document.title || 'youtube-video'}.mp4`);

  const result = [
    {
      sourcePageUrl: sourceUrl,
      tweetUrl: sourceUrl,
      mediaUrl: fallbackUrl,
      mediaType: 'video',
      collectedAt: new Date().toISOString(),
      context: {
        site: 'youtube',
        referer: location.href,
        pageTitle: document.title || undefined,
        displayName,
      },
    },
  ];
  candidateGroups.push({ label: 'video-element-fallback', items: result });

  const best = chooseBestYouTubeItemSet(candidateGroups);
  if (!best) {
    logDebug('youtube extract failed', trace);
    return [];
  }

  trace.push({
    stage: 'choose-best',
    winner: best.label,
    score: best.items.length ? scoreYouTubeIngestItem(best.items[0]!) : -1,
  });
  logDebug('youtube extract success', trace);
  return best.items;
}

function isXiaohongshuUiNoise(el: HTMLElement): boolean {
  // XHS comments contain lots of small emoji/stickers rendered as <img>.
  // We only show save UI for "real" media (usually large), so we filter by size.
  const rect = el.getBoundingClientRect();
  const area = rectArea(rect);
  const maxDim = Math.max(rect.width, rect.height);
  const minDim = Math.min(rect.width, rect.height);

  // Very small items are never "main media" on XHS detail pages.
  if (maxDim > 0 && maxDim < 92) return true;
  if (minDim > 0 && minDim < 70) return true;
  if (area > 0 && area < 9000) return true;

  if (el instanceof HTMLImageElement) {
    const src = el.currentSrc || el.src || '';
    const alt = el.alt || '';
    if (/emoji|emoticon|sticker|icon/i.test(src)) return true;
    if (/表情|emoji/i.test(alt)) return true;
  }

  // If the image is inside a comment-like region and not large, treat as noise.
  const commentLike = el.closest(
    '[class*="comment" i], [class*="reply" i], [aria-label*="评论"], [aria-label*="comment" i], [data-testid*="comment" i]',
  );
  if (commentLike && area > 0 && area < 60000) return true;

  return false;
}

function hasXiaohongshuVideoMeta(doc: Document = document): boolean {
  return Boolean(
    doc.querySelector(
      'meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[property="og:video"], meta[name="twitter:player:stream"], meta[property="twitter:player:stream"]',
    ),
  );
}

function isXiaohongshuVideoContext(targetEl: Element): boolean {
  if (targetEl instanceof HTMLVideoElement) return true;
  if (targetEl.closest('video')) return true;
  if (targetEl.querySelector('video')) return true;

  let cur: Element | null = targetEl;
  for (let depth = 0; cur && depth < 4; depth += 1) {
    if (cur.querySelector('video')) return true;
    if (cur instanceof HTMLElement) {
      const attrs = Array.from(cur.attributes)
        .map((attr) => attr.value ?? '')
        .join(' ');
      if (/(xhscdn|xiaohongshu|rednote).*(?:\.mp4|\.m3u8)|(?:\.mp4|\.m3u8).*(xhscdn|xiaohongshu|rednote)/i.test(attrs)) {
        return true;
      }
    }
    cur = cur.parentElement;
  }

  return hasXiaohongshuVideoMeta(document);
}

function extractXiaohongshuVideoItems(targetEl: Element): IngestItem[] {
  const roots: Array<Document | Element> = [];
  let cur: Element | null = targetEl;
  for (let depth = 0; cur && depth < 4; depth += 1) {
    roots.push(cur);
    cur = cur.parentElement;
  }
  roots.push(document);

  for (const root of roots) {
    const items =
      root instanceof Document ? extractFromDocument(root, location.href).items : extractFromRoot(root, location.href).items;
    const videoItems = items.filter((item) => item.mediaType === 'video');
    if (videoItems.length) return dedupeItems(videoItems);
  }

  return [];
}

function scoreXiaohongshuVideoUrl(url: string): number {
  const raw = String(url ?? '').trim().toLowerCase();
  if (!raw || !/^https?:/i.test(raw)) return -100000;
  if (/\.(?:pdf|doc|docx|ppt|pptx|xls|xlsx|txt|zip|rar|7z)(?:$|[?#])/i.test(raw)) return -90000;
  let score = 0;
  if (/\.mp4(?:$|[?#])/i.test(raw)) score += 4500;
  if (/\.m3u8(?:$|[?#])/i.test(raw)) score += 4200;
  if (/(?:^|[-.])video(?:[-.]|$)|fe-video|sns-video/.test(raw)) score += 1800;
  if (/\/stream\/|\/playurl\/|\/playlist\/|\/master(?:\.m3u8)?(?:$|[/?#])/.test(raw)) score += 1600;
  if (/(?:^|[/_-])(fhd|uhd|hd|origin|playback|videoplay)(?:[/_-]|$)/.test(raw)) score += 900;
  if (/image|img|photo|cover|poster/.test(raw)) score -= 1200;
  return score;
}

function selectPreferredXiaohongshuVideoItems(items: IngestItem[]): IngestItem[] {
  const videoItems = items
    .filter((item) => item.mediaType === 'video')
    .filter((item) => {
      const url = String(item.mediaUrl ?? '').trim();
      return /^https?:/i.test(url) && !/\.(?:pdf|doc|docx|ppt|pptx|xls|xlsx|txt|zip|rar|7z)(?:$|[?#])/i.test(url);
    });
  if (!videoItems.length) return [];
  const ranked = [...videoItems].sort(
    (a, b) => scoreXiaohongshuVideoUrl(String(b.mediaUrl ?? '')) - scoreXiaohongshuVideoUrl(String(a.mediaUrl ?? '')),
  );
  const best = ranked[0];
  if (!best) return [];
  const alternateMediaUrls = ranked
    .slice(1)
    .map((item) => String(item.mediaUrl ?? '').trim())
    .filter((url) => url && url !== best.mediaUrl)
    .slice(0, 6);
  return [
    {
      ...best,
      context: {
        ...(best.context ?? {}),
        alternateMediaUrls,
      },
    },
  ];
}

function hasDirectXVideoMedia(root: Element): boolean {
  if (root instanceof HTMLVideoElement) return true;
  if (root instanceof HTMLElement && root.matches('[data-testid="videoPlayer"]')) return true;
  return Boolean(
    root.querySelector(
      '[data-testid="videoPlayer"], video, img[src*="ext_tw_video_thumb"], img[src*="amplify_video_thumb"], img[src*="tweet_video_thumb"], img[src*="video_thumb"]',
    ),
  );
}

function isDirectXVideoMedia(targetEl: Element): boolean {
  if (targetEl instanceof HTMLVideoElement) return true;
  if (targetEl instanceof HTMLElement && targetEl.matches('[data-testid="videoPlayer"]')) return true;
  if (targetEl.closest('[data-testid="videoPlayer"]')) return true;
  if (targetEl instanceof HTMLImageElement) {
    const src = targetEl.currentSrc || targetEl.src || '';
    if (isXVideoThumbUrl(src)) return true;
  }
  return hasDirectXVideoMedia(targetEl);
}

function isXVideoContext(targetEl: Element): boolean {
  if (targetEl.closest('[data-testid="videoPlayer"]')) return true;
  const article = targetEl.closest('article');
  if (!article) return false;
  if (article.querySelector('[data-testid="videoPlayer"]')) return true;
  if (article.querySelector('video')) return true;
  if (article.querySelector('img[src*="video_thumb"], img[src*="amplify_video_thumb"], img[src*="tweet_video_thumb"]')) {
    return true;
  }
  return false;
}

function isXVideoThumbUrl(url: string): boolean {
  return /pbs\.twimg\.com\/(?:ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)/i.test(url);
}

function extractXVideoOwnerIdFromThumbUrl(url: string): string | null {
  const m = String(url ?? '').match(
    /pbs\.twimg\.com\/(?:ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\/(\d{8,25})\//i,
  );
  return m?.[1] ?? null;
}

function extractXVideoOwnerIdFromVideoUrl(url: string): string | null {
  const m = String(url ?? '').match(/video\.twimg\.com\/(?:ext_tw_video|amplify_video|tweet_video)\/(\d{8,25})\//i);
  return m?.[1] ?? null;
}

function pickClosestXVideoThumbId(targetEl: Element, imgs: HTMLImageElement[]): string | null {
  if (!imgs.length) return null;
  const targetRect = targetEl.getBoundingClientRect();
  let bestId: string | null = null;
  let bestScore = -Infinity;
  for (const img of imgs) {
    const src = img.currentSrc || img.src || '';
    const id = extractXVideoOwnerIdFromThumbUrl(src);
    if (!id) continue;
    const rect = img.getBoundingClientRect();
    const overlap = rectIntersectionArea(targetRect, rect);
    const distance = rectCenterDistance(targetRect, rect);
    let score = 0;
    if (overlap > 0) score += 2000 + overlap;
    score += Math.max(0, 1200 - distance);
    if (img.closest('[data-testid="videoPlayer"]') === targetEl.closest('[data-testid="videoPlayer"]')) {
      score += 900;
    }
    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }
  return bestId;
}

function findXVideoThumbOwnerId(targetEl: Element, videoEl: HTMLVideoElement | null): string | null {
  const fromPoster = extractXVideoOwnerIdFromThumbUrl(videoEl?.poster ?? '');
  if (fromPoster) return fromPoster;

  const container = targetEl.closest('[data-testid="videoPlayer"]') ?? targetEl;
  const imgs = Array.from(container.querySelectorAll<HTMLImageElement>('img[src]'));
  const containerId = pickClosestXVideoThumbId(targetEl, imgs);
  if (containerId) return containerId;

  const article = targetEl.closest('article');
  if (article) {
    const imgs2 = Array.from(
      article.querySelectorAll<HTMLImageElement>(
        'img[src*="ext_tw_video_thumb"], img[src*="amplify_video_thumb"], img[src*="tweet_video_thumb"], img[src*="video_thumb"]',
      ),
    );
    const articleId = pickClosestXVideoThumbId(targetEl, imgs2);
    if (articleId) return articleId;
  }

  return null;
}

function containsOnlyXVideoThumb(items: { mediaType?: string; mediaUrl?: string }[]): boolean {
  if (!items.length) return false;
  return items.every((item) => item.mediaType === 'image' && isXVideoThumbUrl(String(item.mediaUrl ?? '')));
}

function extractSingleFromGroup(groupRoot: Element): ReturnType<typeof extractFromRoot> {
  const candidates = findMediaCandidates(groupRoot, location.href, { dedupe: false });
  const active = pickActiveCandidate(candidates);
  if (!active) return { items: [] };
  return extractFromElement(active.element, location.href);
}

function dedupeItems(items: IngestItem[]): IngestItem[] {
  const seen = new Set<string>();
  const out: IngestItem[] = [];
  for (const item of items) {
    const url = String(item.mediaUrl ?? '').trim();
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(item);
  }
  return out;
}

function isHttpUrl(value?: string | null): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('blob:') || trimmed.startsWith('data:') || trimmed.startsWith('about:')) return false;
  if (trimmed.startsWith('//')) return true;
  return /^https?:/i.test(trimmed);
}

async function extractFromDocumentSmart(doc: Document, locHref: string): Promise<ReturnType<typeof extractFromDocument>> {
  const siteId = detectSite(locHref);
  if (siteId !== 'x') return extractFromDocument(doc, locHref);

  const candidates = findMediaCandidates(doc, locHref, { dedupe: false });
  const items: IngestItem[] = [];

  for (const candidate of candidates) {
    if (
      candidate.mediaType === 'image' &&
      (isXVideoThumbUrl(candidate.mediaUrl) || isXVideoContext(candidate.element))
    ) {
      const videoItems = await tryExtractXVideoItems(candidate.element);
      if (videoItems.length) {
        items.push(...videoItems);
      }
      continue;
    }
    const extracted = extractFromElement(candidate.element, locHref).items;
    if (extracted.length) items.push(...extracted);
  }

  return { items: dedupeItems(items) };
}

function logDebug(...args: unknown[]) {
  if (!DEBUG) return;
  // eslint-disable-next-line no-console
  console.debug('[xic]', ...args);
}

let toastTimer: number | null = null;

function showToast(text: string, timeoutMs = 1600) {
  let toast = document.getElementById(NOTE_ID) as HTMLDivElement | null;
  if (!toast) {
    toast = document.createElement('div');
    toast.id = NOTE_ID;
    document.body.appendChild(toast);
  }
  toast.textContent = text;

  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  if (timeoutMs > 0) {
    toastTimer = window.setTimeout(() => {
      if (toast && toast.parentElement) toast.parentElement.removeChild(toast);
      toastTimer = null;
    }, timeoutMs);
  }
}

const TASK_CREATED_TEXT = '已加入保存队列';

type QueueStatus = 'queued' | 'downloading' | 'done' | 'exists' | 'failed';

type QueueItem = {
  id: string;
  displayName: string;
  status: QueueStatus;
  stage?: string;
  bytes?: number;
  total?: number;
  mediaType?: 'image' | 'video';
  url?: string;
  usedUrl?: string;
  error?: string;
  updatedAt: number;
};

const queueItems = new Map<string, QueueItem>();
const knownClientIds = new Set<string>();
const suppressedClientIds = new Map<string, number>();
const lastProgressTsById = new Map<string, number>();
let queueHidden = false;
let renderScheduled = false;
let allowUnknownUntil = 0;
const portByClientId = new Map<string, chrome.runtime.Port>();
const pendingByPort = new Map<chrome.runtime.Port, Set<string>>();
const PORT_TIMEOUT_MS = 180000;
let cachedServerUrl = DEFAULT_SERVER_URL;
let cachedServerCheckedAt = 0;
let progressPollTimer: number | null = null;

function ensureQueueRoot() {
  let root = document.getElementById(QUEUE_ID) as HTMLDivElement | null;
  if (root) {
    const hasPanel = root.querySelector(`.${QUEUE_PANEL_CLASS}`);
    const hasList = root.querySelector(`.${QUEUE_LIST_CLASS}`);
    const hasToggle = root.querySelector(`.${QUEUE_TOGGLE_CLASS}`);
    if (!hasPanel || !hasList || !hasToggle) {
      root.remove();
      root = null;
    }
  }
  if (!root) {
    root = document.createElement('div');
    root.id = QUEUE_ID;

    const toggle = document.createElement('button');
    toggle.className = QUEUE_TOGGLE_CLASS;
    toggle.type = 'button';
    const toggleText = document.createElement('span');
    toggleText.className = QUEUE_TOGGLE_TEXT_CLASS;
    toggleText.textContent = '保存管理';
    const toggleCount = document.createElement('span');
    toggleCount.className = QUEUE_TOGGLE_COUNT_CLASS;
    toggleCount.textContent = '0';
    toggle.appendChild(toggleText);
    toggle.appendChild(toggleCount);
    toggle.addEventListener('click', () => {
      queueHidden = false;
      scheduleRenderQueue();
    });

    const panel = document.createElement('div');
    panel.className = QUEUE_PANEL_CLASS;

    const header = document.createElement('div');
    header.className = QUEUE_HEADER_CLASS;

    const title = document.createElement('div');
    title.className = QUEUE_TITLE_CLASS;
    title.textContent = '保存管理';

    const actions = document.createElement('div');
    actions.className = QUEUE_ACTIONS_CLASS;

    const clear = document.createElement('button');
    clear.className = QUEUE_CLEAR_CLASS;
    clear.type = 'button';
    clear.textContent = '清空记录';
    clear.addEventListener('click', () => {
      clearQueueItems();
    });

    const close = document.createElement('button');
    close.className = QUEUE_CLOSE_CLASS;
    close.type = 'button';
    close.textContent = '收起';
    close.addEventListener('click', () => {
      queueHidden = true;
      scheduleRenderQueue();
    });

    actions.appendChild(clear);
    actions.appendChild(close);
    header.appendChild(title);
    header.appendChild(actions);

    const summary = document.createElement('div');
    summary.className = QUEUE_SUMMARY_CLASS;

    const list = document.createElement('div');
    list.className = QUEUE_LIST_CLASS;

    panel.appendChild(header);
    panel.appendChild(summary);
    panel.appendChild(list);
    root.appendChild(toggle);
    root.appendChild(panel);
    document.body.appendChild(root);
  }
  return root;
}

function openIngestPort(): chrome.runtime.Port | null {
  const port: chrome.runtime.Port | null = null;
  try {
    const port = chrome.runtime.connect({ name: 'xic-ingest' });
    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'XIC_INGEST_PROGRESS') {
        if (msg.event === 'progress') {
          applyProgressEvent(msg.data);
        } else if (msg.event === 'done' && Array.isArray(msg?.data?.results)) {
          applyIngestResults(msg.data.results);
        } else if (msg.event === 'error') {
          const errText = typeof msg?.data?.error === 'string' ? msg.data.error : '未知错误';
          showToast(`下载失败：${errText}`, 2400);
        }
        return;
      }
      if (msg.event === 'progress' && msg.data) {
        applyProgressEvent(msg.data);
      }
    });
    pendingByPort.set(port, new Set());
    port.onDisconnect.addListener(() => {
      const pending = pendingByPort.get(port);
      if (pending) {
        for (const id of pending) {
          portByClientId.delete(id);
        }
      }
      pendingByPort.delete(port);
    });
    window.setTimeout(() => {
      if (!pendingByPort.has(port)) return;
      try {
        port.disconnect();
      } catch {
        // ignore
      }
    }, PORT_TIMEOUT_MS);
    return port;
  } catch {
    return null;
  }
}

function registerPortIds(port: chrome.runtime.Port | null, ids: string[]) {
  if (!port || !ids.length) return;
  let pending = pendingByPort.get(port);
  if (!pending) {
    pending = new Set<string>();
    pendingByPort.set(port, pending);
  }
  for (const id of ids) {
    if (!id) continue;
    pending.add(id);
    portByClientId.set(id, port);
  }
  try {
    port.postMessage({ type: 'XIC_REGISTER_CLIENTS', clientIds: ids });
  } catch {
    // ignore
  }
}

function scheduleRenderQueue() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderQueue();
  });
}

function getActiveClientIds() {
  const ids: string[] = [];
  for (const [id, item] of queueItems.entries()) {
    if (item.status === 'queued' || item.status === 'downloading') ids.push(id);
  }
  return ids;
}

function stopProgressPolling() {
  if (!progressPollTimer) return;
  clearInterval(progressPollTimer);
  progressPollTimer = null;
}

function getProgressEntryTs(entry: any): number | undefined {
  const ts =
    Number.isFinite(entry?.data?.ts) ? Number(entry.data.ts) : Number.isFinite(entry?.ts) ? Number(entry.ts) : undefined;
  if (!Number.isFinite(ts)) return undefined;
  return ts as number;
}

function getProgressEntryStage(entry: any): string {
  const nested = entry?.data;
  if (typeof nested?.stage === 'string') return nested.stage;
  if (typeof entry?.stage === 'string') return entry.stage;
  return '';
}

function isFreshProgressEntry(entry: any) {
  const ts = getProgressEntryTs(entry);
  if (!Number.isFinite(ts)) return true;
  return Date.now() - (ts as number) < PROGRESS_MAX_AGE_MS;
}

function isStaleQueuedEntry(entry: any) {
  const stage = getProgressEntryStage(entry);
  if (stage !== 'queued') return false;
  const ts = getProgressEntryTs(entry);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - (ts as number) > QUEUED_STALE_MS;
}

const STAGE_ORDER: Record<string, number> = {
  queued: 0,
  downloading: 1,
  downloaded: 2,
  created: 3,
  exists: 3,
  failed: 3,
};

function stageRank(stage?: string) {
  if (!stage) return 0;
  return STAGE_ORDER[stage] ?? 0;
}

function isStageAdvance(prev?: string, next?: string) {
  return stageRank(next) > stageRank(prev);
}

function getProgressEntryClientId(entry: any): string {
  const nested = entry?.data;
  const id =
    typeof nested?.clientId === 'string'
      ? nested.clientId
      : typeof entry?.clientId === 'string'
        ? entry.clientId
        : '';
  return id.trim();
}

function filterProgressEntries(entries: any[], activeIds: string[]) {
  if (!activeIds.length) return entries;
  const activeSet = new Set(activeIds);
  return entries.filter((entry) => {
    const id = getProgressEntryClientId(entry);
    if (id && activeSet.has(id)) return true;
    const data = entry?.data ?? entry;
    const byUrl = findQueueItemIdByUrl(data?.url, data?.usedUrl);
    if (byUrl) return true;
    const displayName =
      typeof data?.displayName === 'string' && data.displayName.trim()
        ? data.displayName.trim()
        : deriveNameFromUrl(data?.usedUrl ?? data?.url);
    const byName = findQueueItemIdByName(displayName);
    if (byName) return true;
    return !id;
  });
}

type ProgressSnapshot = {
  key: string;
  clientId: string;
  stage: string;
  ts?: number;
  data: any;
};

function getProgressSnapshot(entry: any, index: number): ProgressSnapshot | null {
  const data = entry?.data ?? entry;
  if (!data) return null;
  const clientId = getProgressEntryClientId(entry);
  const stage = getProgressEntryStage(entry);
  const ts = getProgressEntryTs(entry);
  const fallbackKeyParts = [
    stage,
    typeof data?.usedUrl === 'string' ? data.usedUrl : '',
    typeof data?.url === 'string' ? data.url : '',
    typeof data?.displayName === 'string' ? data.displayName : '',
    String(index),
  ];
  const key = clientId || fallbackKeyParts.join('|');
  return { key, clientId, stage, ts, data };
}

function getProgressDetailScore(snapshot: ProgressSnapshot) {
  const data = snapshot.data ?? {};
  let score = 0;
  if (Number.isFinite(data?.bytes)) score += 2;
  if (Number.isFinite(data?.total)) score += 2;
  if (typeof data?.usedUrl === 'string' && data.usedUrl.trim()) score += 1;
  if (typeof data?.error === 'string' && data.error.trim()) score += 1;
  return score;
}

function pickBetterSnapshot(current: ProgressSnapshot | undefined, next: ProgressSnapshot) {
  if (!current) return next;
  const currentTs = current.ts ?? -1;
  const nextTs = next.ts ?? -1;
  if (nextTs > currentTs) return next;
  if (nextTs < currentTs) return current;
  const currentRank = stageRank(current.stage);
  const nextRank = stageRank(next.stage);
  if (nextRank > currentRank) return next;
  if (nextRank < currentRank) return current;
  return getProgressDetailScore(next) >= getProgressDetailScore(current) ? next : current;
}

function mergeProgressEntries(...groups: any[][]) {
  const merged = new Map<string, ProgressSnapshot>();
  let index = 0;
  for (const entries of groups) {
    for (const entry of entries) {
      const snapshot = getProgressSnapshot(entry, index);
      index += 1;
      if (!snapshot) continue;
      if (!snapshot.clientId && !snapshot.data?.url && !snapshot.data?.displayName) continue;
      const current = merged.get(snapshot.key);
      merged.set(snapshot.key, pickBetterSnapshot(current, snapshot));
    }
  }
  return Array.from(merged.values());
}

async function fetchServerProgress(clientIds?: string[]) {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'XIC_GET_SERVER_PROGRESS', clientIds });
    if (r?.ok && Array.isArray(r.items)) {
      return r.items as any[];
    }
  } catch {
    // ignore
  }
  return [];
}

async function pollProgressOnce() {
  const activeIds = getActiveClientIds();
  if (!activeIds.length) {
    stopProgressPolling();
    return;
  }
  let items: any[] = [];
  try {
    const r = await chrome.runtime.sendMessage({ type: 'XIC_GET_PROGRESS', clientIds: activeIds });
    if (r?.ok && Array.isArray(r.items)) {
      items = filterProgressEntries(r.items as any[], activeIds);
    }
  } catch {
    // ignore
  }
  if (items.length === 0 || items.length < Math.min(activeIds.length, 2)) {
    try {
      const rAll = await chrome.runtime.sendMessage({ type: 'XIC_GET_PROGRESS' });
      if (rAll?.ok && Array.isArray(rAll.items) && rAll.items.length) {
        items = filterProgressEntries(rAll.items as any[], activeIds);
      }
    } catch {
      // ignore
    }
  }
  const hasFresh = items.some((entry) => isFreshProgressEntry(entry));
  const queuedOnly = items.length > 0 && items.every((entry) => getProgressEntryStage(entry) === 'queued');
  const hasStaleQueued = items.some((entry) => isStaleQueuedEntry(entry));
  const needsServer =
    items.length === 0 || !hasFresh || items.length < activeIds.length || queuedOnly || hasStaleQueued;
  let serverItems = needsServer ? await fetchServerProgress(activeIds) : [];
  if (needsServer && activeIds.length && serverItems.length === 0) {
    serverItems = await fetchServerProgress();
  }
  if (serverItems.length) {
    serverItems = filterProgressEntries(serverItems, activeIds);
  }
  const merged = mergeProgressEntries(items, serverItems);
  for (const entry of merged) {
    if (entry.ts !== undefined && !isFreshProgressEntry({ data: { ...entry.data, ts: entry.ts } })) continue;
    if (entry.data) applyProgressEvent(entry.data);
  }
}

function ensureProgressPolling() {
  const activeIds = getActiveClientIds();
  if (!activeIds.length) {
    stopProgressPolling();
    return;
  }
  if (progressPollTimer) return;
  progressPollTimer = window.setInterval(() => {
    void pollProgressOnce();
  }, PROGRESS_POLL_INTERVAL_MS);
  void pollProgressOnce();
}

function suppressClientId(clientId: string, ttlMs = SUPPRESS_TTL_MS) {
  suppressedClientIds.set(clientId, Date.now() + ttlMs);
}

function isSuppressedClientId(clientId: string) {
  const until = suppressedClientIds.get(clientId);
  if (!until) return false;
  if (Date.now() > until) {
    suppressedClientIds.delete(clientId);
    return false;
  }
  return true;
}

function clearQueueItems() {
  allowUnknownUntil = 0;
  const clearedIds = Array.from(queueItems.keys());
  for (const [id, item] of queueItems.entries()) {
    queueItems.delete(id);
    knownClientIds.delete(id);
    lastProgressTsById.delete(id);
    suppressClientId(id);
    portByClientId.delete(id);
    for (const pending of pendingByPort.values()) {
      pending.delete(id);
    }
  }
  if (clearedIds.length) {
    try {
      void chrome.runtime.sendMessage({ type: 'XIC_CLEAR_PROGRESS', clientIds: clearedIds });
    } catch {
      // ignore
    }
    try {
      void chrome.runtime.sendMessage({ type: 'XIC_CLEAR_SERVER_PROGRESS', clientIds: clearedIds });
    } catch {
      // ignore
    }
  }
  stopProgressPolling();
  scheduleRenderQueue();
}

function formatBytes(value?: number) {
  if (!Number.isFinite(value) || value === undefined) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = value;
  let idx = 0;
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx += 1;
  }
  const fixed = v < 10 && idx > 0 ? 1 : 0;
  return `${v.toFixed(fixed)} ${units[idx]}`;
}

function deriveNameFromUrl(url?: string) {
  if (!url) return 'media';
  try {
    const u = new URL(url);
    const base = u.pathname.split('/').filter(Boolean).pop();
    if (base) return decodeURIComponent(base);
  } catch {
    // ignore
  }
  const fallback = url.split('/').filter(Boolean).pop();
  return fallback || 'media';
}

function normalizeMatchUrl(value?: string) {
  if (!value) return '';
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  try {
    return normalizeMediaUrl(trimmed);
  } catch {
    return trimmed;
  }
}

function findQueueItemIdByUrl(url?: string, usedUrl?: string) {
  const primary = typeof url === 'string' && url.trim() ? url.trim() : '';
  const used = typeof usedUrl === 'string' && usedUrl.trim() ? usedUrl.trim() : '';
  const primaryNorm = primary ? normalizeMatchUrl(primary) : '';
  const usedNorm = used ? normalizeMatchUrl(used) : '';
  if (!primary && !used) return null;
  for (const [id, item] of queueItems.entries()) {
    const itemUrl = typeof item.url === 'string' ? item.url : '';
    const itemUsed = typeof item.usedUrl === 'string' ? item.usedUrl : '';
    if (primary && itemUrl && itemUrl === primary) return id;
    if (used && itemUsed && itemUsed === used) return id;
    if (used && itemUrl && itemUrl === used) return id;
    if (primary && itemUsed && itemUsed === primary) return id;
    if (primaryNorm) {
      const itemUrlNorm = itemUrl ? normalizeMatchUrl(itemUrl) : '';
      const itemUsedNorm = itemUsed ? normalizeMatchUrl(itemUsed) : '';
      if (itemUrlNorm && itemUrlNorm === primaryNorm) return id;
      if (itemUsedNorm && itemUsedNorm === primaryNorm) return id;
    }
    if (usedNorm) {
      const itemUrlNorm = itemUrl ? normalizeMatchUrl(itemUrl) : '';
      const itemUsedNorm = itemUsed ? normalizeMatchUrl(itemUsed) : '';
      if (itemUrlNorm && itemUrlNorm === usedNorm) return id;
      if (itemUsedNorm && itemUsedNorm === usedNorm) return id;
    }
  }
  return null;
}

function findQueueItemIdByName(name?: string) {
  const key = typeof name === 'string' ? name.trim() : '';
  if (!key) return null;
  let match: string | null = null;
  for (const [id, item] of queueItems.entries()) {
    if (item.displayName !== key) continue;
    if (match) return null;
    if (item.status === 'done' || item.status === 'exists' || item.status === 'failed') continue;
    match = id;
  }
  return match;
}

function statusLabel(item: QueueItem) {
  if (item.status === 'failed') {
    return item.error ? `失败：${item.error}` : '失败';
  }
  if (item.status === 'exists') return '已存在';
  if (item.status === 'done') return '已保存';
  if (item.stage === 'downloaded') return '处理中';
  if (item.status === 'downloading') return '下载中';
  return '排队中';
}

function getQueuePercent(item: QueueItem) {
  if (!Number.isFinite(item.total) || !Number.isFinite(item.bytes)) return null;
  const total = Number(item.total);
  const bytes = Number(item.bytes);
  if (total <= 0) return null;
  return Math.min(100, Math.floor((bytes / total) * 100));
}

function getQueueSizeText(item: QueueItem) {
  const bytes = formatBytes(item.bytes);
  const total = formatBytes(item.total);
  if (total) return `${bytes || '0 B'} / ${total}`;
  if (bytes) return `已下载 ${bytes}`;
  if (item.status === 'queued') return '等待下载';
  if (item.stage === 'downloaded') return '准备写入图库';
  return '';
}

function renderQueue() {
  const root = ensureQueueRoot();
  const totalCount = queueItems.size;
  if (totalCount === 0) {
    root.setAttribute('data-empty', '1');
    root.setAttribute('data-hidden', '1');
    return;
  }
  root.setAttribute('data-empty', '0');
  if (queueHidden) root.setAttribute('data-hidden', '1');
  else root.removeAttribute('data-hidden');

  const list = root.querySelector(`.${QUEUE_LIST_CLASS}`) as HTMLDivElement | null;
  const summary = root.querySelector(`.${QUEUE_SUMMARY_CLASS}`) as HTMLDivElement | null;
  const toggleText = root.querySelector(`.${QUEUE_TOGGLE_TEXT_CLASS}`) as HTMLSpanElement | null;
  const toggleCount = root.querySelector(`.${QUEUE_TOGGLE_COUNT_CLASS}`) as HTMLSpanElement | null;

  const items = Array.from(queueItems.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  let queued = 0;
  let downloading = 0;
  let done = 0;
  let exists = 0;
  let failed = 0;
  for (const item of items) {
    if (item.status === 'queued') queued += 1;
    if (item.status === 'downloading') downloading += 1;
    if (item.status === 'done') done += 1;
    if (item.status === 'exists') exists += 1;
    if (item.status === 'failed') failed += 1;
  }
  const active = queued + downloading;
  const completed = done + exists;
  if (summary) {
    summary.textContent = `进行中 ${active} · 已完成 ${completed} · 失败 ${failed}`;
  }
  if (toggleText) {
    toggleText.textContent = active > 0 ? `保存管理 · ${active} 项进行中` : '保存管理';
  }
  if (toggleCount) {
    toggleCount.textContent = String(totalCount);
  }

  if (!list) return;
  list.textContent = '';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = QUEUE_ITEM_CLASS;
    row.dataset.status = item.status;

    const name = document.createElement('div');
    name.className = QUEUE_NAME_CLASS;
    const mediaPrefix = item.mediaType === 'video' ? '视频' : item.mediaType === 'image' ? '图片' : '媒体';
    name.textContent = `${mediaPrefix} · ${item.displayName || 'media'}`;
    row.appendChild(name);

    const meta = document.createElement('div');
    meta.className = QUEUE_META_CLASS;

    const status = document.createElement('div');
    status.className = QUEUE_STATUS_CLASS;
    const sizeText = getQueueSizeText(item);
    const label = statusLabel(item);
    status.textContent = sizeText ? `${label} · ${sizeText}` : label;

    const percent = document.createElement('div');
    const pct = getQueuePercent(item);
    if (pct !== null) {
      percent.textContent = `${pct}%`;
    } else if (item.status === 'downloading') {
      percent.textContent = '传输中';
    } else {
      percent.textContent = '';
    }

    meta.appendChild(status);
    meta.appendChild(percent);
    row.appendChild(meta);

    const bar = document.createElement('div');
    bar.className = QUEUE_BAR_CLASS;
    const inner = document.createElement('div');
    inner.className = QUEUE_BAR_INNER_CLASS;
    if (pct !== null) {
      inner.style.width = `${pct}%`;
    } else if (item.status === 'downloading' || item.stage === 'downloaded') {
      bar.setAttribute('data-indeterminate', '1');
    } else {
      inner.style.width = item.status === 'done' || item.status === 'exists' ? '100%' : '0%';
    }
    bar.appendChild(inner);
    row.appendChild(bar);

    list.appendChild(row);
  }
}

function scheduleRemove(id: string, delayMs: number) {
  window.setTimeout(() => {
    const item = queueItems.get(id);
    if (!item) return;
    if (item.status === 'queued' || item.status === 'downloading') return;
    queueItems.delete(id);
    knownClientIds.delete(id);
    scheduleRenderQueue();
  }, delayMs);
}

function applyProgressEvent(payload: any) {
  const clientId = typeof payload?.clientId === 'string' ? payload.clientId : '';
  if (!clientId) return;
  if (isSuppressedClientId(clientId)) return;
  const stage = typeof payload?.stage === 'string' ? payload.stage : 'downloading';
  const prevStage = queueItems.get(clientId)?.stage;
  const incomingTs = Number.isFinite(payload?.ts) ? Number(payload.ts) : undefined;
  if (incomingTs !== undefined) {
    const lastTs = lastProgressTsById.get(clientId);
    if (lastTs !== undefined && incomingTs <= lastTs && !isStageAdvance(prevStage, stage)) return;
    if (lastTs === undefined || incomingTs > lastTs) {
      lastProgressTsById.set(clientId, incomingTs);
    }
  }
  if (!knownClientIds.has(clientId)) {
    const fallbackId =
      findQueueItemIdByUrl(payload?.url, payload?.usedUrl) ??
      findQueueItemIdByName(
        typeof payload?.displayName === 'string'
          ? payload.displayName
          : deriveNameFromUrl(payload?.usedUrl ?? payload?.url),
      );
    if (fallbackId) {
      const existing = queueItems.get(fallbackId);
      if (existing && fallbackId !== clientId) {
        queueItems.delete(fallbackId);
        knownClientIds.delete(fallbackId);
        existing.id = clientId;
        queueItems.set(clientId, existing);
      }
      knownClientIds.add(clientId);
    } else if (stage !== 'queued') {
      knownClientIds.add(clientId);
    } else if (Date.now() <= allowUnknownUntil) {
      knownClientIds.add(clientId);
    } else {
      return;
    }
  }
  logDebug('progress', { clientId, stage, bytes: payload?.bytes, total: payload?.total });
  let status: QueueStatus = 'downloading';
  if (stage === 'queued') status = 'queued';
  if (stage === 'created') status = 'done';
  if (stage === 'exists') status = 'exists';
  if (stage === 'failed') status = 'failed';

  const displayName =
    (typeof payload?.displayName === 'string' && payload.displayName.trim()) ||
    deriveNameFromUrl(payload?.usedUrl ?? payload?.url);

  const bytes = Number.isFinite(payload?.bytes) ? Number(payload.bytes) : undefined;
  const total = Number.isFinite(payload?.total) ? Number(payload.total) : undefined;

  const item = queueItems.get(clientId) ?? {
    id: clientId,
    displayName,
    status,
    updatedAt: Date.now(),
  };

  const prevBytes = Number.isFinite(item.bytes) ? Number(item.bytes) : undefined;
  const prevTotal = Number.isFinite(item.total) ? Number(item.total) : undefined;
  item.displayName = displayName || item.displayName;
  item.status = status;
  item.stage = stage;
  const isTransferStage = stage === 'queued' || stage === 'downloading' || stage === 'downloaded';
  if (isTransferStage) {
    if (Number.isFinite(bytes)) {
      item.bytes = prevBytes !== undefined ? Math.max(prevBytes, Number(bytes)) : Number(bytes);
    } else {
      item.bytes = prevBytes;
    }

    if (Number.isFinite(total)) {
      item.total = prevTotal !== undefined ? Math.max(prevTotal, Number(total)) : Number(total);
    } else {
      item.total = prevTotal;
    }
  } else {
    item.bytes = bytes ?? item.bytes;
    item.total = total ?? item.total;
  }
  if (Number.isFinite(item.bytes) && Number.isFinite(item.total) && Number(item.bytes) > Number(item.total)) {
    item.total = Number(item.bytes);
  }
  if ((stage === 'created' || stage === 'exists') && Number.isFinite(item.total) && Number.isFinite(item.bytes)) {
    item.bytes = Math.max(Number(item.bytes), Number(item.total));
  } else if ((stage === 'created' || stage === 'exists') && !Number.isFinite(item.total) && Number.isFinite(item.bytes)) {
    item.total = Number(item.bytes);
  }
  item.mediaType = payload?.mediaType ?? item.mediaType;
  item.url = typeof payload?.url === 'string' ? payload.url : item.url;
  item.usedUrl = typeof payload?.usedUrl === 'string' ? payload.usedUrl : item.usedUrl;
  item.error = payload?.error ?? item.error;
  item.updatedAt = Date.now();

  queueItems.set(clientId, item);
  queueHidden = false;
  scheduleRenderQueue();
  ensureProgressPolling();

  if (status === 'done' || status === 'exists') {
    scheduleRemove(clientId, 30000);
  }
  if (status === 'failed') {
    scheduleRemove(clientId, 60000);
  }

  if (status === 'done' || status === 'exists' || status === 'failed') {
    const port = portByClientId.get(clientId);
    if (port) {
      const pending = pendingByPort.get(port);
      if (pending) pending.delete(clientId);
      portByClientId.delete(clientId);
      if (pending && pending.size === 0) {
        pendingByPort.delete(port);
        try {
          port.disconnect();
        } catch {
          // ignore
        }
      }
    }
  }
}

function applyIngestResults(results: any[]) {
  for (const result of results) {
    const input = result?.input ?? {};
    const ctx = input?.context ?? {};
    const rawClientId = typeof ctx?.clientId === 'string' ? ctx.clientId : '';
    const fallbackId =
      findQueueItemIdByUrl(input?.mediaUrl, input?.usedUrl) ??
      findQueueItemIdByName(typeof ctx?.displayName === 'string' ? ctx.displayName : deriveNameFromUrl(input?.mediaUrl));
    const clientId = rawClientId || fallbackId;
    if (!clientId) continue;
    const status = result?.status === 'exists' ? 'exists' : result?.status === 'failed' ? 'failed' : 'created';
    applyProgressEvent({
      clientId,
      stage: status,
      url: input?.mediaUrl,
      mediaType: input?.mediaType,
      displayName: ctx?.displayName,
      error: result?.error,
    });
  }
}

function prepareQueueItems(items: IngestItem[]) {
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const clientIds: string[] = [];
  const prepared = items.map((item, index) => {
    const existingId = typeof item.context?.clientId === 'string' ? item.context.clientId.trim() : '';
    const clientId = existingId || `${requestId}-${index + 1}`;
    const existingName = typeof item.context?.displayName === 'string' ? item.context.displayName.trim() : '';
    const displayName = existingName || deriveNameFromUrl(item.mediaUrl);
    knownClientIds.add(clientId);
    clientIds.push(clientId);
    applyProgressEvent({
      clientId,
      stage: 'queued',
      url: item.mediaUrl,
      mediaType: item.mediaType,
      displayName,
    });
    return {
      ...item,
      context: {
        ...(item.context ?? {}),
        clientId,
        displayName,
      },
    };
  });
  return { items: prepared, clientIds };
}

function markQueueFailed(clientIds: string[], error: string) {
  for (const clientId of clientIds) {
    if (!clientId) continue;
    applyProgressEvent({ clientId, stage: 'failed', error });
  }
}

function startIngestViaPort(port: chrome.runtime.Port | null, items: IngestItem[]): boolean {
  if (!port || !items.length) return false;
  try {
    port.postMessage({ type: 'XIC_INGEST_ITEMS_STREAM', items });
    return true;
  } catch (err) {
    logDebug('port ingest failed', err);
    return false;
  }
}

async function handleSaveClick(btn: HTMLButtonElement, targetEl: Element, mode: SaveMode) {
  if (btn.dataset.busy === '1') return;
  btn.dataset.busy = '1';
  const currentText = btn.textContent ?? '保存';
  if (btn.dataset.xicPreviewVideoBlocked === '1') {
    btn.textContent = '请进详情';
    showToast('外部预览视频暂不支持直接保存，请打开帖子详情后保存', 2200);
    await sleep(700);
    btn.textContent = currentText;
    btn.dataset.busy = '0';
    return;
  }
  const originalText = btn.textContent ?? '保存';
  let preparedClientIds: string[] = [];
  btn.textContent = '加入队列...';
  try {
    const siteId = detectSite(location.href);
    let pixivBuiltItems: IngestItem[] | null = null;
    if (siteId === 'pixiv' && mode === 'group') {
      const artworkUrl = resolvePixivArtworkUrl(targetEl, location.href);
      if (artworkUrl) {
        logDebug('pixiv build items', artworkUrl);
        const r = await chrome.runtime.sendMessage({
          type: 'XIC_PIXIV_BUILD_ITEMS',
          artworkUrl,
        });
        if (r?.ok && Array.isArray(r.items) && r.items.length) {
          pixivBuiltItems = r.items as IngestItem[];
        } else {
          logDebug('pixiv build items failed', r);
          btn.textContent = '失败';
          showToast(`失败：${r?.error ?? '未知错误'}`, 2400);
          await sleep(600);
          return;
        }
      }
    }

    let items: IngestItem[] = [];
    if (siteId === 'youtube') {
      items = await extractYouTubeVideoItems(targetEl);
    } else {
      items =
        pixivBuiltItems ??
        (mode === 'group'
          ? extractFromRoot(targetEl, location.href).items
          : mode === 'group-active'
            ? extractSingleFromGroup(targetEl).items
            : extractFromElement(targetEl, location.href).items);
    }

    let preferVideo = false;
    const onXDetailPage = (() => {
      try {
        const u = new URL(location.href);
        return u.pathname.includes('/status/') || u.pathname.includes('/i/status/');
      } catch {
        return location.href.includes('/status/') || location.href.includes('/i/status/');
      }
    })();
    if (siteId === 'x') {
      const onlyVideoThumb = containsOnlyXVideoThumb(items);
      preferVideo = isXVideoContext(targetEl) || onlyVideoThumb;
      if (preferVideo || !items.length || onlyVideoThumb) {
        const videoItems = await tryExtractXVideoItems(targetEl);
        if (videoItems.length) {
          items = videoItems;
        } else if (onlyVideoThumb) {
          showToast(onXDetailPage ? '未检测到视频，请先播放后再保存' : '外部预览视频暂不稳定，请打开帖子详情后保存', 2200);
          btn.textContent = '未检测到视频';
          await sleep(600);
          btn.textContent = originalText;
          return;
        } else if (preferVideo) {
          items = items.filter((item) => item.mediaType === 'video');
        } else if (!items.length) {
          const fallback = extractFromRoot(targetEl, location.href).items;
          if (fallback.length) items = fallback;
        }
      }
    }

    if (
      siteId === 'x' &&
      items.length > 0 &&
      items.every((item) => item.mediaType === 'image' && isXVideoThumbUrl(String(item.mediaUrl ?? '')))
    ) {
      showToast(onXDetailPage ? '未检测到视频，请先播放后再保存' : '外部预览视频暂不稳定，请打开帖子详情后保存', 2200);
      btn.textContent = '未检测到视频';
      await sleep(600);
      btn.textContent = originalText;
      return;
    }

    if (siteId === 'x' && preferVideo && !items.length) {
      showToast(onXDetailPage ? '未检测到视频，请先播放后再保存' : '外部预览视频暂不稳定，请打开帖子详情后保存', 2200);
      btn.textContent = '未检测到视频';
      await sleep(600);
      btn.textContent = originalText;
      return;
    }

    if (siteId === 'xiaohongshu') {
      const preferXiaohongshuVideo = isXiaohongshuVideoContext(targetEl);
      if (preferXiaohongshuVideo) {
        const directVideoItems = items.filter((item) => item.mediaType === 'video');
        items = directVideoItems.length ? directVideoItems : extractXiaohongshuVideoItems(targetEl);
        items = selectPreferredXiaohongshuVideoItems(items);
      }
    }

    items = items.filter((item) => isHttpUrl(String(item.mediaUrl ?? '')));
    if (!items.length) {
      if (siteId === 'youtube') {
        showToast('未检测到媒体，请先播放 1-2 秒后再保存', 1800);
      } else {
        showToast('未检测到媒体', 1400);
      }
      btn.textContent = '没有媒体';
      await sleep(600);
      btn.textContent = originalText;
      return;
    }

    items = await enrichItemsViaBackground(items);
    const prepared = prepareQueueItems(items);
    preparedClientIds = prepared.clientIds;
    queueHidden = false;
    scheduleRenderQueue();
    ensureProgressPolling();

    logDebug('ingest items', prepared.items);
    const ingestPort = openIngestPort();
    registerPortIds(ingestPort, prepared.clientIds);
    const r = startIngestViaPort(ingestPort, prepared.items)
      ? { ok: true, count: prepared.items.length, queued: prepared.items.length }
      : await chrome.runtime.sendMessage({
          type: 'XIC_INGEST_ITEMS_STREAM',
          items: prepared.items,
        });

    if (!r?.ok) {
      const message = String(r?.error ?? '未知错误');
      markQueueFailed(prepared.clientIds, message);
      btn.textContent = '失败';
      showToast(`保存失败：${message}`, 2400);
      await sleep(600);
      return;
    }

    const queued = Number.isFinite(r?.queued) ? Number(r.queued) : prepared.items.length;
    btn.textContent = queued > 1 ? `已加入 ${queued}` : '已加入';
    showToast(queued > 1 ? `已加入保存队列，共 ${queued} 项` : TASK_CREATED_TEXT, 1800);
    await sleep(500);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logDebug('ingest error', e);
    if (preparedClientIds.length) {
      markQueueFailed(preparedClientIds, message);
    }
    btn.textContent = '错误';
    showToast(`发送请求失败：${message}`, 2400);
    await sleep(600);
  } finally {
    btn.textContent = originalText;
    btn.dataset.busy = '0';
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function resolveServerUrl(): Promise<string> {
  const now = Date.now();
  if (cachedServerUrl && now - cachedServerCheckedAt < 30000) return cachedServerUrl;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'XIC_PING' });
    const url = typeof r?.serverUrl === 'string' ? r.serverUrl.trim() : '';
    if (url) {
      cachedServerUrl = url;
      cachedServerCheckedAt = now;
      return url;
    }
  } catch {
    // ignore and keep last known server
  }
  cachedServerCheckedAt = now;
  return cachedServerUrl || DEFAULT_SERVER_URL;
}

async function enrichItemsViaBackground(items: IngestItem[]): Promise<IngestItem[]> {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'XIC_ENRICH_ITEMS', items });
    if (r?.ok && Array.isArray(r.items)) {
      return r.items as IngestItem[];
    }
  } catch {
    // ignore
  }
  return items;
}

async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: any) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let dataLines: string[] = [];

  const flush = () => {
    if (!dataLines.length) return;
    const raw = dataLines.join('\n');
    dataLines = [];
    let payload: any = raw;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { raw };
    }
    onEvent(eventName, payload);
    eventName = 'message';
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      flush();
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line) {
        flush();
      } else if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
      idx = buffer.indexOf('\n');
    }
  }
}

async function ingestStreamDirect(items: IngestItem[], clientIds: string[]) {
  const serverUrl = await resolveServerUrl();
  const res = await fetch(`${serverUrl}/api/ingest/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`server ingest failed: HTTP ${res.status}`);
  }
  let streamError: string | null = null;
  await consumeSseStream(res.body, (event, data) => {
    if (event === 'progress') {
      applyProgressEvent(data);
      return;
    }
    if (event === 'done' && Array.isArray(data?.results)) {
      applyIngestResults(data.results);
      return;
    }
    if (event === 'error') {
      streamError = typeof data?.error === 'string' ? data.error : 'unknown error';
    }
  });
  if (streamError) {
    markQueueFailed(clientIds, streamError);
    throw new Error(streamError);
  }
}

function createButton(label: string, title: string) {
  const btn = document.createElement('button');
  btn.className = BTN_CLASS;
  btn.type = 'button';
  btn.textContent = label;
  btn.title = title;
  return btn;
}

function createWrap(kind: 'single' | 'group') {
  const wrap = document.createElement('div');
  wrap.className = `${BTN_WRAPPER_CLASS} ${kind === 'group' ? BTN_WRAPPER_GROUP : BTN_WRAPPER_SINGLE}`;
  wrap.style.zIndex = '2147483647';
  return wrap;
}

function positionXSingleWrap(wrap: HTMLElement, anchor: HTMLElement) {
  const grok = anchor.querySelector<HTMLElement>(
    '[aria-label*="Grok" i], [title*="Grok" i], [data-testid*="grok" i], [data-testid*="Grok" i]',
  );
  if (!grok) return;
  const aRect = anchor.getBoundingClientRect();
  const gRect = grok.getBoundingClientRect();
  if (!aRect.width || !aRect.height) return;
  const isLeft = gRect.left + gRect.width / 2 < aRect.left + aRect.width / 2;
  const isTop = gRect.top + gRect.height / 2 < aRect.top + aRect.height / 2;
  const placeLeft = !isLeft;
  const placeTop = !isTop;
  wrap.style.left = placeLeft ? '6px' : 'auto';
  wrap.style.right = placeLeft ? 'auto' : '6px';
  wrap.style.top = placeTop ? '6px' : 'auto';
  wrap.style.bottom = placeTop ? 'auto' : '6px';
}

function placeWrap(anchor: HTMLElement, wrap: HTMLElement) {
  if (wrap.dataset.site === 'pixiv' || wrap.dataset.site === 'x') return;
  const existing = anchor.querySelectorAll(`.${BTN_WRAPPER_CLASS}`).length;
  if (existing > 0) {
    wrap.style.top = `${8 + existing * 32}px`;
  }
}

function bindButton(btn: HTMLButtonElement, targetEl: Element, mode: SaveMode) {
  if (mode === 'group') groupByButton.set(btn, targetEl);
  else if (mode === 'group-active') groupSingleByButton.set(btn, targetEl);
  else mediaByButton.set(btn, targetEl);
  btn.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  btn.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void handleSaveClick(btn, targetEl, mode);
  });
}

function findGroupRoot(mediaEl: Element, siteId: ReturnType<typeof detectSite>, locHref: string): HTMLElement | null {
  if (siteId === 'x') {
    const article = mediaEl.closest('article');
    if (!article) return null;
    const containerCount = article.querySelectorAll('[data-testid="tweetPhoto"], [data-testid="videoPlayer"]').length;
    if (containerCount >= 2) return article;
    const candidates = findMediaCandidates(article, locHref, { dedupe: false });
    const unique = new Set(candidates.map((c) => c.mediaUrl));
    if (unique.size >= 2) return article;
    if (hasXCarouselHint(article)) return article;
    return null;
  }

  let cur = mediaEl.parentElement;
  let depth = 0;
  while (cur && cur !== document.body && depth < 6) {
    const count = findMediaCandidates(cur, locHref).length;
    if (count >= 2) return cur;
    cur = cur.parentElement;
    depth += 1;
  }
  return null;
}

function pickLargestVideo(videos: HTMLVideoElement[]): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null;
  let bestScore = -1;
  for (const video of videos) {
    if (!isVisibleElement(video)) continue;
    const rect = video.getBoundingClientRect();
    const score = rect.width * rect.height || video.videoWidth * video.videoHeight;
    if (score > bestScore) {
      bestScore = score;
      best = video;
    }
  }
  return best ?? videos[0] ?? null;
}

function findNearestVideo(targetEl: Element): HTMLVideoElement | null {
  if (targetEl instanceof HTMLVideoElement) return targetEl;
  const container = targetEl.closest('[data-testid="videoPlayer"]') ?? (targetEl as HTMLElement | null);
  const video = container?.querySelector('video') ?? null;
  if (video instanceof HTMLVideoElement) return video;
  const article = targetEl.closest('article');
  if (article) {
    const videos = Array.from(article.querySelectorAll<HTMLVideoElement>('video'));
    return pickLargestVideo(videos);
  }
  return null;
}

function extractUrlsFromText(text: string): string[] {
  const out: string[] = [];
  if (!text) return out;
  const normalized = text
    .replace(/\\u002F/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003D/gi, '=')
    .replace(/\\u003F/gi, '?')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
  const re = /https?:\/\/[^\s"'<>]+/g;
  let match = re.exec(normalized);
  while (match) {
    out.push(match[0]);
    match = re.exec(normalized);
  }
  return out;
}

function collectUrlsFromAttributes(el: Element): string[] {
  const urls: string[] = [];
  if (!el.getAttributeNames) return urls;
  for (const name of el.getAttributeNames()) {
    const value = el.getAttribute(name);
    if (!value) continue;
    for (const u of extractUrlsFromText(value)) urls.push(u);
  }
  return urls;
}

function isMp4Url(url: string) {
  return /\.mp4(\?|$)/i.test(url) || /[?&](?:format=mp4|mime=video%2Fmp4|mime=video\/mp4)/i.test(url);
}

function isHlsUrl(url: string) {
  return /\.m3u8(\?|$)/i.test(url);
}

function isSegmentUrl(url: string) {
  return /\.(m4s|ts)(\?|$)/i.test(url);
}

function isXAudioUrl(url: string): boolean {
  if (!/video\.twimg\.com/i.test(url)) return false;
  return /\/aud\//i.test(url) || /\/audio\//i.test(url) || /\/mp4a\//i.test(url);
}

function deriveXVideoUrlsFromAudio(raw: string): string[] {
  const out: string[] = [];
  try {
    const u = new URL(raw);
    if (!/video\.twimg\.com$/i.test(u.hostname)) return out;
    const path = u.pathname;
    let match = path.match(/^(.*)\/aud\/.*\/([^/]+\.mp4)$/i);
    if (!match) match = path.match(/^(.*)\/audio\/.*\/([^/]+\.mp4)$/i);
    if (!match) match = path.match(/^(.*)\/mp4a\/.*\/([^/]+\.mp4)$/i);
    if (!match) return out;
    const prefix = match[1];
    const file = match[2];
    const token = file.replace(/\.mp4$/i, '');
    const base = `${u.protocol}//${u.host}${prefix}`;
    const hls = `${base}/pl/${token}.m3u8`;
    const hlsUrl = new URL(hls);
    if (!hlsUrl.searchParams.has('container')) hlsUrl.searchParams.set('container', 'fmp4');
    out.push(hlsUrl.toString());
    const sizes = ['1280x720', '1024x576', '960x540', '640x360', '480x270', '360x360'];
    for (const size of sizes) {
      out.push(`${base}/vid/${size}/${file}`);
    }
  } catch {
    return out;
  }
  return out;
}

function scoreXMp4Url(url: string): number {
  const resMatch = url.match(/\/(\d{2,5})x(\d{2,5})\//);
  if (resMatch?.[1] && resMatch?.[2]) {
    const w = Number(resMatch[1]);
    const h = Number(resMatch[2]);
    if (Number.isFinite(w) && Number.isFinite(h)) return w * h;
  }
  return 0;
}

function rankXVideoUrls(urls: string[], opts?: { allowHls?: boolean }): string[] {
  const allowHls = opts?.allowHls ?? true;
  const out: string[] = [];
  const seen = new Set<string>();
  const hls: string[] = [];
  const mp4: string[] = [];
  const other: string[] = [];
  const audio: string[] = [];
  for (const raw of urls) {
    const u = raw.trim().replace(/&amp;/g, '&');
    if (!u || u.startsWith('blob:') || !u.includes('video.twimg.com')) continue;
    if (isSegmentUrl(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    if (allowHls && isHlsUrl(u)) {
      hls.push(u);
      continue;
    }
    if (isMp4Url(u)) {
      if (isXAudioUrl(u)) {
        audio.push(u);
        continue;
      }
      mp4.push(u);
      continue;
    }
    other.push(u);
  }
  mp4.sort((a, b) => scoreXMp4Url(b) - scoreXMp4Url(a));
  out.push(...hls, ...mp4, ...other, ...audio);
  return out;
}

function pickBestXVideoUrl(urls: string[], opts?: { allowHls?: boolean }): string | null {
  return rankXVideoUrls(urls, opts)[0] ?? null;
}

function collectXVideoUrlsFromContext(targetEl: Element, videoEl: HTMLVideoElement | null): string[] {
  const urls = new Set<string>();
  const push = (value?: string | null) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    for (const u of extractUrlsFromText(trimmed)) urls.add(u);
  };

  const collectFromEl = (el: Element | null) => {
    if (!el) return;
    if (el instanceof HTMLVideoElement) {
      push(el.currentSrc);
      push(el.src);
      push(el.getAttribute('src'));
      push(el.getAttribute('data-src'));
      push(el.getAttribute('data-url'));
      push(el.getAttribute('data-hls'));
      push(el.getAttribute('data-hls-url'));
      push(el.getAttribute('data-stream'));
      push(el.getAttribute('data-playback-url'));
      push(el.poster);
      el.querySelectorAll<HTMLSourceElement>('source').forEach((s) => push(s.src));
    } else if (el instanceof HTMLSourceElement) {
      push(el.src);
    } else if (el instanceof HTMLAnchorElement) {
      push(el.href);
    }
    collectUrlsFromAttributes(el).forEach((u) => urls.add(u));
  };

  collectFromEl(videoEl);
  let cur: Element | null = videoEl ?? targetEl;
  for (let i = 0; i < 4 && cur; i += 1) {
    collectFromEl(cur);
    cur = cur.parentElement;
  }

  const article = targetEl.closest('article');
  if (article) {
    article.querySelectorAll<HTMLVideoElement>('video').forEach((v) => {
      push(v.currentSrc);
      push(v.src);
      v.querySelectorAll<HTMLSourceElement>('source').forEach((s) => push(s.src));
    });
    article.querySelectorAll<HTMLAnchorElement>('a[href*="video.twimg.com"]').forEach((a) => push(a.href));
    article.querySelectorAll<HTMLElement>('[data-video-url], [data-hls], [data-src], [data-url]').forEach((el) => {
      collectUrlsFromAttributes(el).forEach((u) => urls.add(u));
    });
  }

  return Array.from(urls);
}

function collectXVideoUrlsFromScripts(targetEl: Element): string[] {
  const urls = new Set<string>();
  const collectFromRoot = (root: ParentNode | null) => {
    if (!root) return;
    const scripts = Array.from(root.querySelectorAll?.('script') ?? []);
    for (const script of scripts) {
      const text = script.textContent ?? '';
      if (!text || !text.includes('video.twimg.com')) continue;
      extractUrlsFromText(text).forEach((u) => urls.add(u));
    }
  };
  const article = targetEl.closest('article');
  if (article) collectFromRoot(article);
  if (!urls.size) collectFromRoot(document);
  return Array.from(urls);
}

function findXVideoUrlFromPerformance(since?: number): string | null {
  if (!('performance' in window)) return null;
  const now = performance.now();
  const entries = performance.getEntriesByType('resource');
  const urls: string[] = [];
  for (const entry of entries) {
    if (typeof entry?.name !== 'string') continue;
    if (!entry.name.includes('video.twimg.com')) continue;
    if (since !== undefined && entry.startTime < since - 120) continue;
    if (now - entry.startTime > 20000) continue;
    urls.push(entry.name);
  }
  return pickBestXVideoUrl(urls);
}

function findXVideoUrlFromMeta(): string | null {
  const selectors = [
    'meta[property="og:video:url"]',
    'meta[property="og:video:secure_url"]',
    'meta[property="og:video"]',
    'meta[name="twitter:player:stream"]',
    'meta[property="twitter:player:stream"]',
  ];
  const urls: string[] = [];
  for (const sel of selectors) {
    const metas = Array.from(document.querySelectorAll<HTMLMetaElement>(sel));
    for (const meta of metas) {
      const content = meta.content?.trim();
      if (content) urls.push(content);
    }
  }
  return pickBestXVideoUrl(urls);
}

function extractTweetIdFromUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    const match = u.pathname.match(/\/status\/(\d+)/i) ?? u.pathname.match(/\/i\/status\/(\d+)/i);
    return match?.[1] ?? null;
  } catch {
    const match = String(value).match(/\/status\/(\d+)/i) ?? String(value).match(/\/i\/status\/(\d+)/i);
    return match?.[1] ?? null;
  }
}

function urlMatchesAnyHint(url: string, hintIds: string[]): boolean {
  const u = String(url ?? '');
  if (!u) return false;
  for (const id of hintIds) {
    const t = String(id ?? '').trim();
    if (!t) continue;
    if (u.includes(t)) return true;
  }
  return false;
}

function findXArticleByTweetId(tweetId: string): HTMLElement | null {
  if (!tweetId) return null;
  const selector = `a[href*="/status/${tweetId}"], a[href*="/i/status/${tweetId}"]`;
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>(selector));
  const scored = anchors
    .map((a) => {
      const href = a.getAttribute('href') ?? '';
      const hasTime = a.querySelector('time') ? 1 : 0;
      const isExact = href.includes(`/status/${tweetId}`) || href.includes(`/i/status/${tweetId}`) ? 1 : 0;
      const score = hasTime * 10 + isExact * 4;
      return { a, score };
    })
    .sort((x, y) => y.score - x.score);
  for (const { a } of scored) {
    const article = a.closest('article');
    if (article instanceof HTMLElement) return article;
  }
  return null;
}

async function waitForXArticleByTweetId(tweetId: string, timeoutMs: number): Promise<HTMLElement | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const article = findXArticleByTweetId(tweetId);
    if (article) return article;
    await sleep(250);
  }
  return null;
}

type XVideoExtractOpts = {
  hintIds?: string[];
};

async function tryExtractXVideoItems(targetEl: Element, opts?: XVideoExtractOpts) {
  const videoEl = findNearestVideo(targetEl);
  if (videoEl) {
    await ensureVideoReady(videoEl);
  }

  const explicitHintIds = Array.isArray(opts?.hintIds)
    ? opts!.hintIds!.map((v) => String(v ?? '').trim()).filter(Boolean)
    : [];
  const thumbOwnerId = findXVideoThumbOwnerId(targetEl, videoEl);

  const isTweetDetail = () => {
    try {
      const u = new URL(location.href);
      return u.pathname.includes('/status/') || u.pathname.includes('/i/status/');
    } catch {
      return location.href.includes('/status/') || location.href.includes('/i/status/');
    }
  };

  const toPreferredXVideoDetailUrl = (rawTweetUrl?: string): string | undefined => {
    if (!rawTweetUrl) return undefined;
    try {
      const url = new URL(rawTweetUrl);
      const base = url.pathname.match(/^(\/[^/]+\/status\/\d+|\/i\/status\/\d+)/i)?.[1];
      if (!base) return url.toString();
      url.hash = '';
      if (/\/video\/\d+$/i.test(url.pathname)) return url.toString();
      if (isXVideoContext(targetEl)) {
        url.pathname = `${base}/video/1`;
      } else {
        url.pathname = base;
      }
      return url.toString();
    } catch {
      return rawTweetUrl;
    }
  };

  const tryExtractViaTweetDetail = async (): Promise<IngestItem[]> => {
    const origin = (() => {
      try {
        return new URL(location.href).origin;
      } catch {
        return 'https://x.com';
      }
    })();

    const domTweetUrl = findClosestTweetUrlFromLib(targetEl, location.href);
    const domTweetId = extractTweetIdFromUrl(domTweetUrl) ?? extractTweetIdFromUrl(location.href);

    const tweetIdCandidates = Array.from(
      new Set([thumbOwnerId, domTweetId, ...explicitHintIds.map((h) => (h && /^\d{8,25}$/.test(h) ? h : ''))].filter(Boolean)),
    ).slice(0, 3);

    const urlCandidates: string[] = [];
    for (const tid of tweetIdCandidates) urlCandidates.push(`${origin}/i/status/${tid}`);
    if (domTweetUrl) urlCandidates.push(domTweetUrl);

    for (const baseUrl of urlCandidates) {
      const tweetUrl = toPreferredXVideoDetailUrl(baseUrl);
      if (!tweetUrl) continue;
      const hintIds = Array.from(
        new Set(
          [
            extractTweetIdFromUrl(tweetUrl),
            extractTweetIdFromUrl(location.href),
            thumbOwnerId,
            domTweetId,
            ...explicitHintIds,
          ]
            .map((v) => String(v ?? '').trim())
            .filter(Boolean),
        ),
      ).slice(0, 8);
      try {
        const r = await chrome.runtime.sendMessage({ type: 'XIC_EXTRACT_X_VIDEO_FROM_TWEET', tweetUrl, hintIds });
        if (r?.ok && Array.isArray(r.items)) {
          const items = (r.items as any[]).filter((it) => it && typeof it === 'object') as IngestItem[];
          const videoItems = items.filter((it) => it.mediaType === 'video' && isHttpUrl(String(it.mediaUrl ?? '')));
          if (!videoItems.length) continue;
          if (thumbOwnerId) {
            const matched = videoItems.filter((it) => String(it.mediaUrl ?? '').includes(thumbOwnerId));
            if (matched.length) return matched;
          }
          return videoItems;
        }
      } catch {
        // ignore
      }
    }
    try {
      // ignore
    } catch {
      // ignore
    }
    return [];
  };

  const collectOnce = async () => {
    const perfStart = performance.now();
    const urls: string[] = [];
    const fromVideoEl: string[] = [];
    if (videoEl) {
      if (videoEl.currentSrc) {
        urls.push(videoEl.currentSrc);
        fromVideoEl.push(videoEl.currentSrc);
      }
      if (videoEl.src) {
        urls.push(videoEl.src);
        fromVideoEl.push(videoEl.src);
      }
      const sources = Array.from(videoEl.querySelectorAll<HTMLSourceElement>('source'))
        .map((s) => s.src)
        .filter(Boolean);
      urls.push(...sources);
      fromVideoEl.push(...sources);
    }

    const contextUrls = collectXVideoUrlsFromContext(targetEl, videoEl);
    urls.push(...contextUrls);

    const scriptUrls = collectXVideoUrlsFromScripts(targetEl);
    if (scriptUrls.length) urls.push(...scriptUrls);

    const metaUrl = findXVideoUrlFromMeta();
    if (metaUrl) urls.push(metaUrl);

    const perfUrl = findXVideoUrlFromPerformance(perfStart);
    if (perfUrl) urls.push(perfUrl);

    // Using tab-level "recent video urls" is noisy on timelines (it can include other tweets' videos).
    // Only use it on detail pages, or when we already have some reliable local hints (thumbOwnerId counts).
    let bgUrls: string[] = [];
    const hasLocalHint = fromVideoEl.length > 0 || contextUrls.length > 0 || scriptUrls.length > 0 || !!metaUrl || !!perfUrl;
    if (isTweetDetail() || hasLocalHint || !!thumbOwnerId || explicitHintIds.length > 0) {
      try {
        const r = await chrome.runtime.sendMessage({ type: 'XIC_GET_RECENT_VIDEO_URLS' });
        if (r?.ok && Array.isArray(r.urls)) {
          bgUrls = r.urls.filter((u: any) => typeof u === 'string');
          if (bgUrls.length) urls.push(...bgUrls);
        }
      } catch {
        // ignore
      }
    }

    const audioUrls = urls.filter((u) => isXAudioUrl(u));
    if (audioUrls.length) {
      for (const au of audioUrls) {
        const derived = deriveXVideoUrlsFromAudio(au);
        if (derived.length) urls.push(...derived);
      }
    }

    const ranked = rankXVideoUrls(urls, { allowHls: true });
    logDebug('x video urls', {
      fromVideoEl,
      context: contextUrls,
      scripts: scriptUrls,
      meta: metaUrl,
      perf: perfUrl,
      bg: bgUrls,
      ranked,
    });
    return ranked;
  };

  let ranked = await collectOnce();
  if (!ranked.length) {
    await sleep(600);
    ranked = await collectOnce();
  }

  // Prefer filtering by the clicked video's thumb owner id when available (stronger than "tweet url" heuristics).
  if (thumbOwnerId) {
    const hinted = ranked.filter((u) => u.includes(thumbOwnerId));
    if (hinted.length) ranked = hinted;
  } else if (explicitHintIds.length) {
    const hinted = ranked.filter((u) => urlMatchesAnyHint(u, explicitHintIds));
    if (hinted.length) ranked = hinted;
  }

  const urlOwnerId = ranked.map(extractXVideoOwnerIdFromVideoUrl).find(Boolean) ?? null;

  // On non-detail pages: first try a safe local pick (only when we can strongly associate URLs),
  // otherwise fall back to tweet-detail extraction; avoid "noisy" best-guess picks to prevent mismatches.
  if (!isTweetDetail()) {
    if (thumbOwnerId) {
      const safe = ranked.filter((u) => u.includes(thumbOwnerId));
      if (safe.length) {
        const best = safe.find((u) => !isXAudioUrl(u)) ?? safe[0]!;
        const rest = safe.filter((u) => u !== best);
        const manual = buildManualXVideoItem(best, videoEl ?? targetEl, rest);
        return manual ? [manual] : [];
      }
    }
    if (urlOwnerId) {
      const safe = ranked.filter((u) => u.includes(urlOwnerId));
      if (safe.length) {
        const best = safe.find((u) => !isXAudioUrl(u)) ?? safe[0]!;
        const rest = safe.filter((u) => u !== best);
        const manual = buildManualXVideoItem(best, videoEl ?? targetEl, rest);
        return manual ? [manual] : [];
      }
    }
    const viaDetail = await tryExtractViaTweetDetail();
    if (viaDetail.length) return viaDetail;
    return [];
  }

  if (ranked.length) {
    const best = ranked.find((u) => !isXAudioUrl(u)) ?? ranked[0]!;
    const manual = buildManualXVideoItem(best, videoEl ?? targetEl, ranked.filter((u) => u !== best));
    return manual ? [manual] : [];
  }
  return [];
}

function pickXVideoUrl(videoEl: HTMLVideoElement): string | null {
  const urls: string[] = [];
  if (videoEl.currentSrc) urls.push(videoEl.currentSrc);
  if (videoEl.src) urls.push(videoEl.src);
  const sources = Array.from(videoEl.querySelectorAll<HTMLSourceElement>('source'))
    .map((s) => s.src)
    .filter(Boolean);
  urls.push(...sources);
  return pickBestXVideoUrl(urls, { allowHls: true });
}

async function ensureVideoReady(videoEl: HTMLVideoElement) {
  if (pickXVideoUrl(videoEl)) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      videoEl.removeEventListener('loadedmetadata', onLoaded);
      videoEl.removeEventListener('loadeddata', onLoaded);
      resolve();
    };
    const onLoaded = () => cleanup();
    videoEl.addEventListener('loadedmetadata', onLoaded, { once: true });
    videoEl.addEventListener('loadeddata', onLoaded, { once: true });
    window.setTimeout(cleanup, 1000);
    try {
      videoEl.muted = true;
      const p = videoEl.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          try {
            videoEl.pause();
          } catch {
            // ignore
          }
        }).catch(() => {
          // ignore
        });
      }
    } catch {
      // ignore
    }
    try {
      videoEl.load();
    } catch {
      // ignore
    }
  });
}

function buildManualXVideoItem(mediaUrl: string, el: Element, alternates?: string[]) {
  const tweetUrl = findClosestTweetUrlFromLib(el, location.href);
  const authorHandle = extractHandleFromTweetUrl(tweetUrl);
  const collectedAt = new Date().toISOString();
  const pageTitle = document.title || undefined;
  return {
    sourcePageUrl: location.href,
    tweetUrl,
    authorHandle,
    mediaUrl,
    mediaType: 'video' as const,
    collectedAt,
    context: {
      site: 'x' as const,
      referer: location.href,
      pageTitle,
      alternateMediaUrls: alternates?.filter((u) => u && u !== mediaUrl).slice(0, 6) ?? [],
    },
  };
}

function extractHandleFromTweetUrl(tweetUrl?: string): string | undefined {
  if (!tweetUrl) return undefined;
  try {
    const u = new URL(tweetUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 3 && parts[1] === 'status') return parts[0];
  } catch {
    // ignore
  }
  return undefined;
}

function hasXCarouselHint(root: Element): boolean {
  if (root.querySelector('[data-testid="carousel"], [aria-roledescription="carousel"]')) return true;
  if (root.querySelector('button[aria-label*="Next"], button[aria-label*="Previous"]')) return true;
  const photoLinks = root.querySelectorAll<HTMLAnchorElement>('a[href*="/photo/"]');
  if (photoLinks.length >= 2) return true;
  if (photoLinks.length > 0) {
    const indices = new Set<string>();
    for (const link of photoLinks) {
      const href = link.getAttribute('href') ?? '';
      const m = href.match(/\/photo\/(\d+)/);
      if (m?.[1]) indices.add(m[1]);
    }
    if (indices.size >= 2) return true;
  }
  const labels = root.querySelectorAll<HTMLElement>('[aria-label]');
  for (const el of labels) {
    const label = el.getAttribute('aria-label') ?? '';
    if (/\b\d+\s*[\/]\s*\d+\b/.test(label)) return true;
    if (/\b\d+\s+of\s+\d+\b/i.test(label)) return true;
    if (/共\s*\d+/.test(label)) return true;
  }
  const textEls = root.querySelectorAll<HTMLElement>('div, span');
  for (const el of textEls) {
    const text = (el.textContent ?? '').trim();
    if (!text) continue;
    if (text.length > 8) continue;
    if (/\d+\s*\/\s*\d+/.test(text)) return true;
  }
  return false;
}

function addPixivGroupControls(groupRoot: HTMLElement) {
  if (groupRoot.getAttribute(GROUP_BOUND_ATTR) === '1') return;
  groupRoot.setAttribute(GROUP_BOUND_ATTR, '1');

  groupRoot.classList.add(HOST_CLASS);
  ensureRelative(groupRoot);
  ensureClickableChain(groupRoot);

  const wrap = createWrap('group');
  wrap.dataset.site = 'pixiv';
  wrap.dataset.role = 'group';
  const groupBtn = createButton('保存全部', '保存这个作品中的全部图片');
  groupBtn.dataset.site = 'pixiv';
  bindButton(groupBtn, groupRoot, 'group');
  wrap.appendChild(groupBtn);
  placeWrap(groupRoot, wrap);
  groupRoot.appendChild(wrap);
}

function addGroupButton(groupRoot: HTMLElement, hostOverride?: HTMLElement | null) {
  if (groupRoot.getAttribute(GROUP_BOUND_ATTR) === '1') return;
  groupRoot.setAttribute(GROUP_BOUND_ATTR, '1');

  const host = hostOverride ?? groupRoot;
  const siteId = detectSite(location.href);
  const isBlockedXPreviewVideo = siteId === 'x' && !isXDetailUrl() && hasDirectXVideoMedia(groupRoot);
  host.classList.add(HOST_CLASS);
  ensureRelative(host);
  ensureClickableChain(host);

  const wrap = createWrap('group');
  wrap.dataset.site = siteId;
  wrap.dataset.role = 'group';
  const btn = createButton('保存全部', '保存这组中的全部媒体');
  btn.dataset.site = siteId;
  if (isBlockedXPreviewVideo) {
    btn.textContent = '详情后保存';
    btn.title = '外部预览视频请打开详情页后保存';
    btn.dataset.xicPreviewVideoBlocked = '1';
  } else {
    btn.textContent = '保存全部';
    btn.title = '保存这组中的全部媒体';
  }
  bindButton(btn, groupRoot, 'group');
  wrap.appendChild(btn);
  placeWrap(host, wrap);
  host.appendChild(wrap);
}

function scanAndInject() {
  injectStyles();
  const siteId = detectSite(location.href);
  if (siteId === 'other') return;
  if (siteId === 'xiaohongshu' && !isXiaohongshuDetailUrl(location.href)) return;
  if (siteId === 'youtube' && !isYouTubeDetailUrl(location.href)) return;
  const isX = siteId === 'x';
  const isYouTube = siteId === 'youtube';

  if (isYouTube) {
    const host = findYouTubePlayerHost();
    if (!host) return;
    if (host.getAttribute(BOUND_ATTR) === '1' && host.querySelector(`.${BTN_WRAPPER_CLASS}[data-site="youtube"]`)) return;

    host.setAttribute(BOUND_ATTR, '1');
    host.classList.add(HOST_CLASS);
    ensureRelative(host);
    ensureClickableChain(host);

    if (host.querySelector(`.${BTN_WRAPPER_CLASS}[data-role="single"][data-site="youtube"]`)) return;

    const targetEl = (host.querySelector('video.html5-main-video, video') as Element | null) ?? host;
    const btn = createButton('保存视频', '保存当前 YouTube 视频（默认优先最高画质）');
    btn.dataset.site = 'youtube';
    bindButton(btn, targetEl, 'single');

    const wrap = createWrap('single');
    wrap.dataset.role = 'single';
    wrap.dataset.site = 'youtube';
    placeWrap(host, wrap);
    wrap.appendChild(btn);
    host.appendChild(wrap);
    return;
  }

  const roots = siteId === 'x' ? Array.from(document.querySelectorAll<HTMLElement>('article')) : [document.body];
  for (const root of roots) {
    const mediaSet = new Set<Element>(findMediaElementsForUi(root, location.href));
    if (isX) {
      root.querySelectorAll<HTMLElement>('[data-testid="videoPlayer"]').forEach((el) => mediaSet.add(el));
    }
    const mediaEls = Array.from(mediaSet);
    for (const mediaEl of mediaEls) {
      if (!(mediaEl instanceof HTMLElement)) continue;
      if (siteId === 'pixiv' && isPixivNovelElement(mediaEl, location.href)) continue;
      if (siteId === 'pixiv' && isPixivAdElement(mediaEl, location.href)) continue;
      if (mediaEl.getAttribute(BOUND_ATTR) === '1') continue;
      if (siteId === 'xiaohongshu' && isXiaohongshuUiNoise(mediaEl)) {
        mediaEl.setAttribute(BOUND_ATTR, '1');
        continue;
      }
      mediaEl.setAttribute(BOUND_ATTR, '1');

      let anchor = findAnchorForMedia(mediaEl, siteId, location.href);
      if (siteId === 'pixiv') {
        const pixivAnchor = mediaEl.closest<HTMLElement>('figure') ?? mediaEl.parentElement ?? null;
        if (pixivAnchor) anchor = pixivAnchor;
      }
      if (!anchor) continue;
      if (siteId === 'pixiv' && isPixivAdElement(anchor, location.href)) continue;

      const anchorCandidates = isX ? findMediaCandidates(anchor, location.href, { dedupe: false }) : [];
      const anchorUnique = isX ? new Set(anchorCandidates.map((c) => c.mediaUrl)) : null;
      const anchorHasMultiple = isX ? (anchorUnique?.size ?? 0) >= 2 : false;

      const artworkUrl = siteId === 'pixiv' ? resolvePixivArtworkUrl(mediaEl, location.href) : undefined;
      let groupRoot = findGroupRoot(mediaEl, siteId, location.href);
      if (!groupRoot && siteId === 'pixiv' && artworkUrl) {
        groupRoot = anchor;
      }
      if (!groupRoot && isX && anchorHasMultiple) {
        groupRoot = anchor;
      }
      if (groupRoot) {
        if (siteId === 'pixiv') {
          addPixivGroupControls(groupRoot);
        } else if (siteId !== 'xiaohongshu') {
          const host = isX && groupRoot !== anchor ? anchor : groupRoot;
          addGroupButton(groupRoot, host);
        }
      }

      if (anchor.querySelector(`.${BTN_WRAPPER_CLASS}[data-role="single"]`)) continue;

      anchor.classList.add(HOST_CLASS);
      ensureRelative(anchor);
      ensureClickableChain(anchor);
      const isBlockedXPreviewVideo = isX && !isXDetailUrl() && isDirectXVideoMedia(mediaEl);

      const label = isX ? '保存本张' : groupRoot ? '保存本张' : '保存';
      const title = isX ? '只保存当前这张媒体' : groupRoot ? '只保存当前这一张' : '保存这个媒体';
      const btn = createButton(label, title);
      btn.dataset.site = siteId;
      if (isBlockedXPreviewVideo) {
        btn.textContent = '详情保存';
        btn.title = '外部预览视频请打开详情页后保存';
        btn.dataset.xicPreviewVideoBlocked = '1';
      } else if (isX) {
        btn.textContent = anchorHasMultiple ? '保存本张' : '保存';
        btn.title = anchorHasMultiple ? '只保存当前这张媒体' : '保存这个媒体';
      } else if (groupRoot) {
        btn.textContent = '保存本张';
        btn.title = '只保存当前这张';
      } else {
        btn.textContent = '保存';
        btn.title = '保存这个媒体';
      }
      const singleMode: SaveMode = isX && anchorHasMultiple ? 'group-active' : 'single';
      const singleTarget = isX && anchorHasMultiple ? (groupRoot ?? anchor) : mediaEl;
      bindButton(btn, singleTarget, singleMode);

      const wrap = createWrap(isX ? 'single' : groupRoot ? 'single' : 'group');
      wrap.dataset.role = 'single';
      wrap.dataset.site = siteId;
      if (siteId === 'x') positionXSingleWrap(wrap, anchor);
      wrap.appendChild(btn);
      placeWrap(anchor, wrap);
      anchor.appendChild(wrap);
    }
  }
}

let clickBound = false;
function bindGlobalClick() {
  if (clickBound) return;
  clickBound = true;
  document.addEventListener(
    'click',
    (ev) => {
      const target = ev.target as Element | null;
      const btn = target?.closest?.(`.${BTN_CLASS}`) as HTMLButtonElement | null;
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      const groupRoot = groupByButton.get(btn);
      if (groupRoot) {
        void handleSaveClick(btn, groupRoot, 'group');
        return;
      }
      const groupSingle = groupSingleByButton.get(btn);
      if (groupSingle) {
        void handleSaveClick(btn, groupSingle, 'group-active');
        return;
      }
      const mediaEl = mediaByButton.get(btn);
      if (!mediaEl) return;
      void handleSaveClick(btn, mediaEl, 'single');
    },
    true,
  );
}

let scanTimer: number | null = null;
function scheduleScan() {
  if (scanTimer !== null) return;
  scanTimer = window.setTimeout(() => {
    scanTimer = null;
    scanAndInject();
  }, 500);
}

const observer = new MutationObserver(() => scheduleScan());
observer.observe(document.documentElement, { childList: true, subtree: true });
bindGlobalClick();
scheduleScan();

