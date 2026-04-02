import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import pLimit from 'p-limit';
import sharp from 'sharp';
import { ProxyAgent } from 'undici';

import type { Db } from './db.js';
import type { FsLayout } from './fs-layout.js';
import type { ServerConfig } from './config.js';
import { normalizeMediaUrl } from './url-normalize.js';
import { downloadToTempFile, mergeAudioVideoToTempFile } from './download.js';
import type { DownloadResult, ProgressCallback } from './download.js';
import { createImageThumb, createVideoThumbIfPossible } from './thumbs.js';
import type { IngestItem } from './types.js';
import { computePHash } from './phash.js';
import { isDebugEnabled, logger } from './logger.js';

type IngestResultItem = {
  input: IngestItem;
  ok: boolean;
  status: 'created' | 'exists' | 'failed';
  mediaId?: number;
  sha256?: string;
  error?: string;
};

export type IngestProgressEvent = {
  clientId: string;
  index: number;
  stage: 'queued' | 'downloading' | 'downloaded' | 'exists' | 'created' | 'failed';
  bytes?: number;
  total?: number;
  url?: string;
  usedUrl?: string;
  displayName?: string;
  mediaType?: 'image' | 'video';
  error?: string;
};

type OriginSite = 'x' | 'pixiv' | 'duitang' | 'xiaohongshu' | 'youtube' | 'other';
const VIDEO_EXTS = new Set(['mp4', 'm3u8', 'webm', 'mov', 'm4v']);
const AUDIO_EXTS = new Set(['m4a', 'aac', 'mp3', 'opus', 'ogg', 'wav', 'weba', 'webm']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif']);
const BLOCKED_DOC_EXT_RE = /\.(?:pdf|doc|docx|ppt|pptx|xls|xlsx|txt|zip|rar|7z)(?:$|[?#])/i;
const YOUTUBE_AUDIO_ITAGS = new Set([
  139, 140, 141, 171, 172, 249, 250, 251, 256, 258, 325, 328, 599, 600,
]);
const pageProxyAgents = new Map<string, ProxyAgent>();

function isoNow() {
  return new Date().toISOString();
}

function safeExt(ext?: string) {
  if (!ext) return undefined;
  const e = ext.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!e) return undefined;
  return e.slice(0, 8);
}

function moveFileSync(srcPath: string, destPath: string) {
  try {
    fs.renameSync(srcPath, destPath);
    return;
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as any).code) : '';
    if (code !== 'EXDEV') throw err;
    fs.copyFileSync(srcPath, destPath);
    fs.unlinkSync(srcPath);
  }
}

function safeUnlink(filePath?: string | null) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const s = fs.createReadStream(filePath);
    s.on('data', (chunk) => hash.update(chunk));
    s.on('end', () => resolve());
    s.on('error', (err) => reject(err));
  });
  return hash.digest('hex');
}

function detectOrigin(input: IngestItem): OriginSite {
  const site = String(input.context?.site ?? '').toLowerCase();
  if (site === 'x' || site === 'pixiv' || site === 'duitang' || site === 'xiaohongshu' || site === 'youtube') return site;
  try {
    const host = new URL(input.sourcePageUrl).hostname.toLowerCase();
    if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) return 'x';
    if (host === 'pixiv.net' || host.endsWith('.pixiv.net') || host.endsWith('.pximg.net')) return 'pixiv';
    if (host === 'duitang.com' || host.endsWith('.duitang.com')) return 'duitang';
    if (
      host === 'xiaohongshu.com' ||
      host.endsWith('.xiaohongshu.com') ||
      host === 'rednote.com' ||
      host.endsWith('.rednote.com') ||
      host.endsWith('.xhscdn.com')
    ) {
      return 'xiaohongshu';
    }
    if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be' || host.endsWith('.youtu.be')) {
      return 'youtube';
    }
  } catch {
    // ignore
  }
  return 'other';
}

function inferReferer(input: IngestItem): string | undefined {
  const ctxRef = typeof input.context?.referer === 'string' ? input.context.referer : undefined;
  if (ctxRef && ctxRef.trim()) return ctxRef.trim();
  if (input.sourcePageUrl && input.sourcePageUrl.trim()) return input.sourcePageUrl.trim();
  return undefined;
}

function getClientId(input: IngestItem, index: number): string {
  const raw = input.context?.clientId;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return `item-${index + 1}`;
}

function getDisplayName(input: IngestItem, url: string): string | undefined {
  const raw = input.context?.displayName;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  try {
    const u = new URL(url);
    const base = path.basename(u.pathname);
    if (base) return decodeURIComponent(base);
  } catch {
    // ignore
  }
  const fallback = String(url ?? '').split('/').pop();
  return fallback || undefined;
}

function extractTags(input: IngestItem): string[] {
  const raw = input.context?.tags;
  let tags: string[] = [];
  if (Array.isArray(raw)) {
    tags = raw.map((t) => String(t ?? '').trim()).filter(Boolean);
  } else if (typeof raw === 'string') {
    tags = raw
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return Array.from(new Set(tags)).slice(0, 40);
}

function getPageProxyAgent(proxyUrl?: string) {
  if (!proxyUrl) return undefined;
  const cached = pageProxyAgents.get(proxyUrl);
  if (cached) return cached;
  const agent = new ProxyAgent(proxyUrl);
  pageProxyAgents.set(proxyUrl, agent);
  return agent;
}

function normalizeCandidateUrls(urls: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    if (!raw) continue;
    const value = raw.trim();
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function isYouTubeLikeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return (
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtu.be' ||
      host.endsWith('.youtu.be') ||
      host === 'googlevideo.com' ||
      host.endsWith('.googlevideo.com')
    );
  } catch {
    return false;
  }
}

function isBlockedYouTubeCandidateUrl(url: string): boolean {
  const raw = String(url ?? '').trim();
  if (!raw || !/^https?:\/\//i.test(raw)) return false;
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

function buildProxyCandidatesForDownload(opts: { origin: OriginSite; url: string; proxyUrl?: string }): Array<string | undefined> {
  const proxy = typeof opts.proxyUrl === 'string' ? opts.proxyUrl.trim() : '';
  if (!proxy) return [undefined];
  const isYouTube = opts.origin === 'youtube' || isYouTubeLikeUrl(opts.url);
  if (!isYouTube) return [proxy];
  // Proxy 403s are a common failure mode for googlevideo URLs, so keep a direct fallback enabled
  // by default. Users who need strict proxy-only behavior can still opt back in with env.
  const proxyOnly = process.env.XIC_YOUTUBE_PROXY_ONLY === '1';
  return proxyOnly ? [proxy] : [proxy, undefined];
}

function getDownloadRetriesForCandidate(opts: {
  origin: OriginSite;
  url: string;
  proxyUrl?: string;
  retries?: number;
}): number | undefined {
  if (!opts.proxyUrl) return opts.retries;
  if (!(opts.origin === 'youtube' || isYouTubeLikeUrl(opts.url))) return opts.retries;
  // Repeating the same proxied YouTube request rarely helps and only delays fallback.
  return 0;
}

function buildGoogleVideoFallbackUrls(rawUrl: string): string[] {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return [];
  }
  if (isBlockedYouTubeCandidateUrl(rawUrl)) return [];
  const host = u.hostname.toLowerCase();
  if (!(host === 'googlevideo.com' || host.endsWith('.googlevideo.com'))) return [];
  if (!/videoplayback|manifest|\.m3u8/i.test(`${u.pathname}${u.search}`)) return [];

  const out: string[] = [];
  const seen = new Set<string>([rawUrl]);
  const pushWithHost = (nextHost: string) => {
    const normalizedHost = String(nextHost ?? '').trim().toLowerCase();
    if (!normalizedHost || normalizedHost === host) return;
    if (!normalizedHost.endsWith('.googlevideo.com')) return;
    try {
      const next = new URL(rawUrl);
      next.hostname = normalizedHost;
      const value = next.toString();
      if (seen.has(value)) return;
      seen.add(value);
      out.push(value);
    } catch {
      // ignore malformed host candidate
    }
  };

  const mnRaw = u.searchParams.get('mn') ?? '';
  const mnValues = mnRaw
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 4);

  // Examples: rr1---sn-i3b7kn6k.googlevideo.com / r1---sn-i3b7kn6k.googlevideo.com
  const rrMatch = host.match(/^([a-z]+)(\d+)---([a-z0-9-]+)\.googlevideo\.com$/i);
  const rrPrefix = rrMatch?.[1] ?? 'rr';
  const rrSuffix = rrMatch?.[3];
  const suffixes = Array.from(new Set([rrSuffix, ...mnValues].filter(Boolean) as string[]));
  const prefixCandidates = Array.from(
    new Set(
      [rrPrefix, rrPrefix === 'rr' ? 'r' : rrPrefix === 'r' ? 'rr' : undefined].filter(Boolean) as string[],
    ),
  );

  for (const suffix of suffixes) {
    for (const prefix of prefixCandidates) {
      for (let i = 1; i <= 4; i += 1) {
        pushWithHost(`${prefix}${i}---${suffix}.googlevideo.com`);
      }
    }
  }

  return out.slice(0, 16);
}

function getYouTubeTransferTimeoutMs(timeoutMs: number): number {
  return Math.max(timeoutMs, 180_000);
}

function decodeEscapedUrlText(text: string): string {
  return text
    .replace(/\\u002f/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u003f/gi, '?')
    .replace(/\\u003a/gi, ':')
    .replace(/\\u0025/gi, '%')
    .replace(/\\x2f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/\\u([0-9a-f]{4})/gi, (_all, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/\\x([0-9a-f]{2})/gi, (_all, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x2F;|&#47;/gi, '/');
}

function cleanExtractedUrl(raw: string): string {
  return raw.replace(/["'`<>]+$/g, '').replace(/[),.;]+$/g, '');
}

function extractUrlsFromText(text: string): string[] {
  const urls = new Set<string>();
  const normalized = decodeEscapedUrlText(text);
  const re = /https?:\/\/[^\s"'<>`\\]+/g;
  let match: RegExpExecArray | null = re.exec(normalized);
  while (match) {
    const raw = cleanExtractedUrl(match[0] ?? '');
    if (raw) urls.add(raw);
    match = re.exec(normalized);
  }
  return Array.from(urls);
}

function isBlockedDocUrl(url: string): boolean {
  return BLOCKED_DOC_EXT_RE.test(url.toLowerCase());
}

function isLikelyVideoUrl(url: string): boolean {
  const raw = String(url ?? '').trim().toLowerCase();
  if (!raw) return false;
  if (!/^https?:/i.test(raw)) return false;
  if (isBlockedDocUrl(raw)) return false;
  if (isBlockedYouTubeCandidateUrl(raw)) return false;
  if (/\.(?:mp4|m3u8|mpd|webm|mov|m4v)(?:$|[?#])/i.test(raw)) return true;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const query = u.search.toLowerCase();
    if (/googlevideo\.com$/.test(host) || host.includes('.googlevideo.com')) {
      const mimeRaw = decodeURIComponent(u.searchParams.get('mime') ?? u.searchParams.get('type') ?? '').toLowerCase();
      if (mimeRaw.startsWith('audio/')) return false;
      if (mimeRaw.startsWith('video/')) return true;
      const itag = Number(u.searchParams.get('itag') ?? NaN);
      if (Number.isFinite(itag)) {
        if (YOUTUBE_AUDIO_ITAGS.has(itag)) return false;
        return true;
      }
      if (path.includes('videoplayback') || /(\.m3u8|\.mpd|\/manifest\/|\/api\/manifest\/)/i.test(path)) return true;
    }
    if (/(?:^|[-.])video(?:[-.]|$)|fe-video|sns-video/.test(host)) return true;
    if (
      /\/video\/|\/stream\/|\/playurl\/|\/playlist\/|\/master(?:\.m3u8)?(?:$|[/?#])|\/videoplayback(?:$|[/?#])|\/manifest\/(?:dash|hls)?(?:\/|$)|\/api\/manifest\/(?:dash|hls)(?:\/|$)/i.test(
        path,
      )
    ) {
      return true;
    }
    if (/(?:^|[?&])(format|mime|type)=.*(?:video|mp4|m3u8|mpd|dash)/i.test(query)) return true;
    if (/(?:^|[?&])(manifest|playlist|hls|dash)=/i.test(query)) return true;
  } catch {
    return false;
  }
  return false;
}

function isManifestLikeVideoUrl(url: string): boolean {
  const raw = String(url ?? '').trim().toLowerCase();
  if (!raw) return false;
  return (
    /\.(?:m3u8|mpd)(?:$|[?#])/i.test(raw) ||
    /\/manifest\/|\/api\/manifest\//i.test(raw) ||
    /[?&](?:manifest|playlist|hls|dash)=/i.test(raw)
  );
}

function isLikelyAudioUrl(url: string): boolean {
  const raw = String(url ?? '').trim().toLowerCase();
  if (!raw) return false;
  if (!/^https?:/i.test(raw)) return false;
  if (isBlockedDocUrl(raw)) return false;
  if (isBlockedYouTubeCandidateUrl(raw)) return false;
  if (/\.(?:m4a|aac|mp3|opus|ogg|wav|weba)(?:$|[?#])/i.test(raw)) return true;
  if (/\.(?:mp4|webm)(?:$|[?#])/.test(raw) && /(audio|mime=audio|type=audio|itag=13[0-9]|itag=14[0-9])/.test(raw)) {
    return true;
  }
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const query = u.search.toLowerCase();
    if (/googlevideo\.com$/.test(host) || host.includes('.googlevideo.com')) {
      if (/(mime|type)=audio/.test(query)) return true;
      if (/\/audio\//.test(path)) return true;
    }
    if (/(?:^|[?&])(mime|type|format)=.*audio/i.test(query)) return true;
  } catch {
    return false;
  }
  return false;
}

function scoreXiaohongshuVideoUrl(url: string): number {
  const raw = String(url ?? '').trim().toLowerCase();
  if (!raw || !/^https?:/i.test(raw)) return -100000;
  if (isBlockedDocUrl(raw)) return -90000;
  let score = 0;
  if (/\.mp4(?:$|[?#])/i.test(raw)) score += 4500;
  if (/\.m3u8(?:$|[?#])/i.test(raw)) score += 4200;
  if (/(?:^|[-.])video(?:[-.]|$)|fe-video|sns-video/.test(raw)) score += 1800;
  if (/\/stream\/|\/playurl\/|\/playlist\/|\/master(?:\.m3u8)?(?:$|[/?#])/.test(raw)) score += 1600;
  if (/(?:^|[/_-])(fhd|uhd|hd|origin|playback|videoplay)(?:[/_-]|$)/.test(raw)) score += 900;
  if (/image|img|photo|cover|poster/.test(raw)) score -= 1200;
  return score;
}

function isLikelyVideoPayload(contentType?: string, ext?: string): boolean {
  const ct = String(contentType ?? '').toLowerCase();
  const fileExt = String(ext ?? '').toLowerCase();
  const hasVideoExt = VIDEO_EXTS.has(fileExt);
  if (ct.startsWith('video/')) return true;
  if (ct.includes('octet-stream')) return hasVideoExt;
  if (!ct) return hasVideoExt;
  return false;
}

function isLikelyAudioPayload(contentType?: string, ext?: string): boolean {
  const ct = String(contentType ?? '').toLowerCase();
  const fileExt = String(ext ?? '').toLowerCase();
  const hasAudioExt = AUDIO_EXTS.has(fileExt);
  if (ct.startsWith('audio/')) return true;
  if (ct.includes('octet-stream')) return hasAudioExt;
  if (!ct) return hasAudioExt;
  if (ct.startsWith('video/')) {
    // Some CDNs serve audio-only mp4/webm with generic video/* content-type.
    return hasAudioExt && !VIDEO_EXTS.has(fileExt);
  }
  return false;
}

function shouldAcceptVideoPayloadByUrlHint(url: string, dl: DownloadResult): boolean {
  const raw = String(url ?? '').toLowerCase();
  if (!raw) return false;
  if (!/googlevideo\.com|videoplayback|\.m3u8|\.mpd|\/manifest\/|\/api\/manifest\/|[?&](?:manifest|hls|dash)=/i.test(raw)) {
    return false;
  }
  const ct = String(dl.contentType ?? '').toLowerCase();
  const ext = String(dl.ext ?? '').toLowerCase();
  if (ct.startsWith('image/') || IMAGE_EXTS.has(ext)) return false;
  if (ct.startsWith('text/') || ct.includes('json') || ct.includes('xml') || ct.includes('pdf')) return false;
  if (isLikelyAudioUrl(url)) return false;
  // Avoid accepting tiny stubs.
  if ((dl.bytes ?? 0) < 300_000) return false;
  return true;
}

function formatDownloadPayloadMismatchDetail(dl: DownloadResult): string {
  const ct = String(dl.contentType ?? '').toLowerCase();
  const ext = String(dl.ext ?? '').toLowerCase();
  const detail = ct || ext || 'unknown';
  const statusPart = Number.isFinite(dl.status) ? ` status=${dl.status}` : '';
  const previewPart = dl.textPreview ? ` body="${dl.textPreview}"` : '';
  return `${detail}${statusPart}${previewPart}`.trim();
}

function normalizeYouTubeWatchLikeUrl(rawUrl: string): string {
  const raw = String(rawUrl ?? '').trim();
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
      const id = u.pathname.split('/').filter(Boolean)[0] ?? '';
      if (!id) return raw;
      const next = new URL('https://www.youtube.com/watch');
      next.searchParams.set('v', id);
      return next.toString();
    }
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      if (u.pathname.startsWith('/watch') && u.searchParams.get('v')) return u.toString();
      const shorts = u.pathname.match(/^\/shorts\/([^/?#]+)/i);
      if (shorts?.[1]) {
        const next = new URL('https://www.youtube.com/watch');
        next.searchParams.set('v', shorts[1]);
        return next.toString();
      }
    }
  } catch {
    // ignore
  }
  return raw;
}

function scoreYouTubeVideoCandidateUrl(url: string): number {
  const raw = String(url ?? '').trim().toLowerCase();
  if (!raw) return -100000;
  if (!/^https?:/i.test(raw)) return -90000;
  if (isBlockedDocUrl(raw)) return -80000;
  if (isBlockedYouTubeCandidateUrl(raw)) return -95000;
  let score = 0;
  if (/\.mpd(?:$|[?#])|\/manifest\/dash(?:\/|$)|\/api\/manifest\/dash(?:\/|$)|[?&](?:manifest|dash)=/i.test(raw)) {
    score += 12000;
  } else if (/\.m3u8(?:$|[?#])|\/manifest\/hls(?:\/|$)|\/manifest\/|\/api\/manifest\/hls(?:\/|$)|[?&](?:playlist|hls)=/i.test(raw)) {
    score += 10800;
  }
  if (/dash/i.test(raw)) score += 1800;
  if (/hls/i.test(raw)) score += 1200;
  if (/videoplayback/i.test(raw)) score += 1600;
  if (/googlevideo\.com/i.test(raw)) score += 900;
  if (/(?:^|[?&])(mime|type)=video/i.test(raw)) score += 1500;
  if (/(?:^|[?&])clen=\d+/i.test(raw)) score += 1000;
  if (/(?:^|[?&])source=youtube/i.test(raw)) score += 240;
  if (/(?:^|[?&])(mime|type)=audio/i.test(raw)) score -= 5000;
  if (/(?:^|[?&])quality_label=2160p/i.test(raw)) score += 900;
  if (/(?:^|[?&])quality_label=1440p/i.test(raw)) score += 820;
  if (/(?:^|[?&])quality_label=1080p/i.test(raw)) score += 760;
  if (/(?:^|[?&])quality_label=720p/i.test(raw)) score += 640;
  if (/(?:^|[?&])itag=37\b/.test(raw)) score += 860;
  if (/(?:^|[?&])itag=22\b/.test(raw)) score += 720;
  if (/(?:^|[?&])itag=18\b/.test(raw)) score += 520;
  if (/(?:^|[?&])expire=\d+/.test(raw)) score += 120;
  return score;
}

function scoreYouTubeAudioCandidateUrl(url: string): number {
  const raw = String(url ?? '').trim().toLowerCase();
  if (!raw) return -100000;
  if (!/^https?:/i.test(raw)) return -90000;
  if (isBlockedDocUrl(raw)) return -80000;
  if (isBlockedYouTubeCandidateUrl(raw)) return -95000;
  let score = 0;
  if (/googlevideo\.com/i.test(raw)) score += 1500;
  if (/(?:^|[?&])(mime|type)=audio/i.test(raw)) score += 2200;
  if (/(?:^|[?&])clen=\d+/i.test(raw)) score += 900;
  if (/\.m3u8(?:$|[?#])|\/manifest\//i.test(raw)) score -= 1600;
  if (/(?:^|[?&])itag=251\b/.test(raw)) score += 700;
  if (/(?:^|[?&])itag=250\b/.test(raw)) score += 620;
  if (/(?:^|[?&])itag=249\b/.test(raw)) score += 560;
  if (/(?:^|[?&])itag=141\b/.test(raw)) score += 660;
  if (/(?:^|[?&])itag=140\b/.test(raw)) score += 600;
  if (/(?:^|[?&])itag=139\b/.test(raw)) score += 520;
  return score;
}

function extractSignedUrlFromYouTubeCipher(rawCipher: string): string | null {
  try {
    const params = new URLSearchParams(rawCipher);
    const embedded = decodeEscapedUrlText(params.get('url') ?? '').trim();
    if (!embedded || !/^https?:\/\//i.test(embedded)) return null;
    const sig = params.get('sig') || params.get('signature');
    const encrypted = params.get('s');
    if (!sig && encrypted) return null;
    const u = new URL(embedded);
    if (sig) {
      const sp = params.get('sp') || 'signature';
      u.searchParams.set(sp, sig);
    }
    return u.toString();
  } catch {
    return null;
  }
}

async function fetchYouTubeStreamUrls(opts: {
  sourcePageUrl: string;
  userAgent: string;
  proxyUrl?: string;
  referer?: string;
}): Promise<{ videoUrls: string[]; audioUrls: string[] }> {
  const rawSource = String(opts.sourcePageUrl ?? '').trim();
  if (!rawSource) return { videoUrls: [], audioUrls: [] };
  const source = normalizeYouTubeWatchLikeUrl(rawSource);

  let sourceUrl: URL;
  try {
    sourceUrl = new URL(source);
  } catch {
    return { videoUrls: [], audioUrls: [] };
  }
  const host = sourceUrl.hostname.toLowerCase();
  if (!(host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be' || host.endsWith('.youtu.be'))) {
    return { videoUrls: [], audioUrls: [] };
  }

  try {
    const dispatcher = getPageProxyAgent(opts.proxyUrl);
    const referer = opts.referer?.trim() || source;
    const res = await fetch(source, {
      redirect: 'follow',
      dispatcher,
      headers: {
        'user-agent': opts.userAgent,
        accept: 'text/html,application/xhtml+xml',
        referer,
      },
    });
    if (!res.ok) return { videoUrls: [], audioUrls: [] };
    const html = await res.text();
    if (!html) return { videoUrls: [], audioUrls: [] };

    const candidates = new Set<string>();
    for (const url of extractUrlsFromText(html)) {
      candidates.add(url);
    }

    const escapedFieldRegexes = [
      /"hlsManifestUrl"\s*:\s*"([^"]+)"/gi,
      /"dashManifestUrl"\s*:\s*"([^"]+)"/gi,
      /"url"\s*:\s*"([^"]+)"/gi,
      /"signatureCipher"\s*:\s*"([^"]+)"/gi,
      /"cipher"\s*:\s*"([^"]+)"/gi,
    ];
    for (const re of escapedFieldRegexes) {
      let match: RegExpExecArray | null = re.exec(html);
      while (match) {
        const raw = match[1] ? decodeEscapedUrlText(match[1]).trim() : '';
        if (raw) {
          if (/^https?:\/\//i.test(raw)) {
            candidates.add(raw);
          } else if (re.source.includes('signatureCipher') || re.source.includes('"cipher"')) {
            const signed = extractSignedUrlFromYouTubeCipher(raw);
            if (signed) candidates.add(signed);
          }
        }
        match = re.exec(html);
      }
    }

    const normalized = normalizeCandidateUrls(Array.from(candidates)).filter(
      (url) => !isBlockedDocUrl(url) && !isBlockedYouTubeCandidateUrl(url),
    );
    const videoUrls = normalized
      .filter((url) => isLikelyVideoUrl(url))
      .sort((a, b) => scoreYouTubeVideoCandidateUrl(b) - scoreYouTubeVideoCandidateUrl(a))
      .slice(0, 20);
    const audioUrls = normalized
      .filter((url) => isLikelyAudioUrl(url))
      .sort((a, b) => scoreYouTubeAudioCandidateUrl(b) - scoreYouTubeAudioCandidateUrl(a))
      .slice(0, 16);

    return { videoUrls, audioUrls };
  } catch {
    return { videoUrls: [], audioUrls: [] };
  }
}

async function fetchXiaohongshuVideoUrls(opts: {
  sourcePageUrl: string;
  userAgent: string;
  proxyUrl?: string;
}): Promise<string[]> {
  const source = String(opts.sourcePageUrl ?? '').trim();
  if (!source) return [];

  let pageUrl: URL;
  try {
    pageUrl = new URL(source);
  } catch {
    return [];
  }
  const host = pageUrl.hostname.toLowerCase();
  if (
    !(
      host === 'xiaohongshu.com' ||
      host.endsWith('.xiaohongshu.com') ||
      host === 'rednote.com' ||
      host.endsWith('.rednote.com')
    )
  ) {
    return [];
  }

  try {
    const dispatcher = getPageProxyAgent(opts.proxyUrl);
    const res = await fetch(source, {
      redirect: 'follow',
      dispatcher,
      headers: {
        'user-agent': opts.userAgent,
        accept: 'text/html,application/xhtml+xml',
        referer: source,
      },
    });
    if (!res.ok) return [];
    const html = await res.text();
    if (!html) return [];

    const candidates = new Set<string>();
    const metaRe =
      /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:video(?:\:url|\:secure_url)?|twitter:player:stream)["'][^>]*>/gi;
    let metaMatch: RegExpExecArray | null = metaRe.exec(html);
    while (metaMatch) {
      const tag = metaMatch[0] ?? '';
      const contentMatch = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i);
      const raw = contentMatch?.[1] ? decodeEscapedUrlText(contentMatch[1]).trim() : '';
      if (raw) candidates.add(raw);
      metaMatch = metaRe.exec(html);
    }

    for (const url of extractUrlsFromText(html)) {
      candidates.add(url);
    }

    return normalizeCandidateUrls(Array.from(candidates))
      .filter((url) => !isBlockedDocUrl(url))
      .filter((url) => isLikelyVideoUrl(url))
      .sort((a, b) => scoreXiaohongshuVideoUrl(b) - scoreXiaohongshuVideoUrl(a))
      .slice(0, 8);
  } catch {
    return [];
  }
}

function applyTags(db: Db, mediaId: number, tags: string[], source: 'manual' | 'pixiv' | 'auto') {
  if (!tags.length) return;
  const insertTag = db.prepare('INSERT OR IGNORE INTO tag (name, source) VALUES (?, ?)');
  const getTag = db.prepare('SELECT id, source FROM tag WHERE name = ?');
  const updateSource = db.prepare('UPDATE tag SET source = ? WHERE id = ?');
  const insertLink = db.prepare('INSERT OR IGNORE INTO media_tag (media_id, tag_id) VALUES (?, ?)');

  for (const name of tags) {
    insertTag.run([name, source]);
    const row = getTag.get([name]) as { id: number; source?: string } | undefined;
    if (row?.id) {
      if (source === 'manual' && row.source !== 'manual') {
        updateSource.run(['manual', row.id]);
      }
      insertLink.run([mediaId, row.id]);
    }
  }
}

function buildPixivFallbackUrls(url: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  push(url);

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return out;
  }
  if (!u.hostname.endsWith('pximg.net')) return out;

  const extMatch = u.pathname.match(/\.([a-z0-9]+)$/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : undefined;

  const replaceExt = (pathname: string, nextExt: string) => pathname.replace(/\.[a-z0-9]+$/i, `.${nextExt}`);

  if (u.pathname.includes('/img-original/')) {
    if (ext) {
      for (const alt of ['jpg', 'png', 'gif']) {
        if (alt === ext) continue;
        const altUrl = new URL(u.toString());
        altUrl.pathname = replaceExt(altUrl.pathname, alt);
        push(altUrl.toString());
      }
    }
    const master = new URL(u.toString());
    master.pathname = master.pathname
      .replace('/img-original/', '/img-master/')
      .replace(/\.[a-z0-9]+$/i, '_master1200.jpg');
    push(master.toString());
  } else if (u.pathname.includes('/img-master/')) {
    const original = new URL(u.toString());
    original.pathname = original.pathname
      .replace('/img-master/', '/img-original/')
      .replace(/_master1200(?=\.[a-z0-9]+$)/i, '');
    push(original.toString());
  }

  return out;
}

async function downloadWithFallback(opts: {
  url: string;
  origin: OriginSite;
  tmpDir: string;
  timeoutMs: number;
  userAgent: string;
  proxyUrl?: string;
  referer?: string;
  retries?: number;
  fallbackUrls?: string[];
  expectType?: 'image' | 'video' | 'audio';
  onProgress?: ProgressCallback;
}): Promise<{ dl: DownloadResult; usedUrl: string }> {
  const baseUrls = [opts.url, ...(opts.fallbackUrls ?? [])].filter(Boolean);
  const expanded: string[] = [];
  const enableYouTubeHostFallbacks = process.env.XIC_YOUTUBE_HOST_FALLBACK === '1';
  for (const u of baseUrls) {
    if (opts.origin === 'pixiv') {
      expanded.push(...buildPixivFallbackUrls(u));
    } else {
      expanded.push(u);
    }
    if ((opts.origin === 'youtube' || isYouTubeLikeUrl(u)) && enableYouTubeHostFallbacks) {
      expanded.push(...buildGoogleVideoFallbackUrls(u));
    }
  }
  const urls = Array.from(new Set(expanded));
  let lastErr: unknown;
  let best: { dl: DownloadResult; usedUrl: string } | null = null;
  const minVideoBytes = 1_200_000;
  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i];
    if ((opts.origin === 'youtube' || isYouTubeLikeUrl(url)) && isBlockedYouTubeCandidateUrl(url)) {
      lastErr = new Error(`skip blocked youtube candidate: ${url}`);
      continue;
    }
    if (opts.expectType === 'video' && !isLikelyVideoUrl(url)) {
      lastErr = new Error(`skip non-video candidate: ${url}`);
      continue;
    }
    if (opts.expectType === 'audio' && !isLikelyAudioUrl(url)) {
      lastErr = new Error(`skip non-audio candidate: ${url}`);
      continue;
    }
    const proxyCandidates = buildProxyCandidatesForDownload({ origin: opts.origin, url, proxyUrl: opts.proxyUrl });
    for (let p = 0; p < proxyCandidates.length; p += 1) {
      const proxyUrl = proxyCandidates[p];
      try {
        const retries = getDownloadRetriesForCandidate({
          origin: opts.origin,
          url,
          proxyUrl,
          retries: opts.retries,
        });
        const dl = await downloadToTempFile({
          url,
          tmpDir: opts.tmpDir,
          timeoutMs: opts.timeoutMs,
          userAgent: opts.userAgent,
          proxyUrl,
          referer: opts.referer,
          retries,
          onProgress: opts.onProgress,
        });
      if (opts.expectType === 'video') {
        const ct = (dl.contentType ?? '').toLowerCase();
        const ext = (dl.ext ?? '').toLowerCase();
        const isImage = ct.startsWith('image/') || IMAGE_EXTS.has(ext);
        if (isImage) {
          try {
            fs.unlinkSync(dl.tmpPath);
          } catch {
            // ignore
          }
          lastErr = new Error('expected video but got image content');
          continue;
        }
        if (!isLikelyVideoPayload(dl.contentType, dl.ext)) {
          if (shouldAcceptVideoPayloadByUrlHint(url, dl)) {
            // continue with this candidate even if content-type is generic.
          } else {
          const detail = formatDownloadPayloadMismatchDetail(dl);
          if (opts.origin === 'youtube' || isYouTubeLikeUrl(url)) {
            logger.info('youtube video candidate rejected', {
              url,
              detail,
              bytes: dl.bytes,
            });
          }
          try {
            fs.unlinkSync(dl.tmpPath);
          } catch {
            // ignore
          }
          lastErr = new Error(`expected video but got content-type ${detail}`);
          continue;
          }
        }
      } else if (opts.expectType === 'audio') {
        const ct = (dl.contentType ?? '').toLowerCase();
        const ext = (dl.ext ?? '').toLowerCase();
        const isImage = ct.startsWith('image/') || IMAGE_EXTS.has(ext);
        if (isImage) {
          try {
            fs.unlinkSync(dl.tmpPath);
          } catch {
            // ignore
          }
          lastErr = new Error('expected audio but got image content');
          continue;
        }
        if (!isLikelyAudioPayload(dl.contentType, dl.ext)) {
          const detail = ct || ext || 'unknown';
          try {
            fs.unlinkSync(dl.tmpPath);
          } catch {
            // ignore
          }
          lastErr = new Error(`expected audio but got content-type ${detail}`);
          continue;
        }
      }

      if (
        opts.expectType === 'video' &&
        dl.bytes < minVideoBytes &&
        i < urls.length - 1 &&
        !isManifestLikeVideoUrl(url)
      ) {
        if (!best || dl.bytes > best.dl.bytes) {
          if (best) {
            try {
              fs.unlinkSync(best.dl.tmpPath);
            } catch {
              // ignore
            }
          }
          best = { dl, usedUrl: url };
        } else {
          try {
            fs.unlinkSync(dl.tmpPath);
          } catch {
            // ignore
          }
        }
        continue;
      }

      if (best) {
        try {
          fs.unlinkSync(best.dl.tmpPath);
        } catch {
          // ignore
        }
      }
        return { dl, usedUrl: url };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isProxy403 = Boolean(proxyUrl) && /HTTP\s*403\b/i.test(message);
        if (isProxy403 && p < proxyCandidates.length - 1) {
          // retry next proxy candidate (typically direct/no-proxy)
          logger.debug('youtube proxy fallback', {
            url,
            proxyUrl,
            reason: message,
          });
          lastErr = new Error(`HTTP 403 via proxy, retrying direct: ${url}`);
          continue;
        }
        if (opts.origin === 'youtube' || isYouTubeLikeUrl(url)) {
          logger.info('youtube candidate download failed', {
            url,
            expectType: opts.expectType ?? 'unknown',
            proxy: Boolean(proxyUrl),
            candidateIndex: i,
            proxyIndex: p,
            error: message,
          });
        }
        lastErr = err;
      }
    }
  }
  if (best) return best;
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function ingestItems(opts: {
  db: Db;
  layout: FsLayout;
  cfg: ServerConfig;
  items: IngestItem[];
  onProgress?: (event: IngestProgressEvent) => void;
}): Promise<{ results: IngestResultItem[] }> {
  const limit = pLimit(opts.cfg.maxConcurrentDownloads);
  const tmpDir = path.join(os.tmpdir(), 'clipnest');
  const xiaohongshuVideoCache = new Map<string, Promise<string[]>>();
  const youtubeStreamCache = new Map<string, Promise<{ videoUrls: string[]; audioUrls: string[] }>>();

  const getXiaohongshuVideoCandidates = (sourcePageUrl: string) => {
    const key = String(sourcePageUrl ?? '').trim();
    if (!key) return Promise.resolve<string[]>([]);
    const existing = xiaohongshuVideoCache.get(key);
    if (existing) return existing;
    const pending = fetchXiaohongshuVideoUrls({
      sourcePageUrl: key,
      userAgent: opts.cfg.userAgent,
      proxyUrl: opts.cfg.proxyUrl,
    })
      .then((urls) => normalizeCandidateUrls(urls).filter((url) => isLikelyVideoUrl(url)))
      .catch(() => []);
    xiaohongshuVideoCache.set(key, pending);
    return pending;
  };

  const getYouTubeStreamCandidates = (sourcePageUrl: string, referer?: string) => {
    const key = String(sourcePageUrl ?? '').trim();
    if (!key) return Promise.resolve<{ videoUrls: string[]; audioUrls: string[] }>({ videoUrls: [], audioUrls: [] });
    const existing = youtubeStreamCache.get(key);
    if (existing) return existing;
    const pending = fetchYouTubeStreamUrls({
      sourcePageUrl: key,
      userAgent: opts.cfg.userAgent,
      proxyUrl: opts.cfg.proxyUrl,
      referer,
    }).catch(() => ({ videoUrls: [], audioUrls: [] }));
    youtubeStreamCache.set(key, pending);
    return pending;
  };

  const results = await Promise.all(
    opts.items.map((input, index) =>
      limit(async (): Promise<IngestResultItem> => {
        const clientId = getClientId(input, index);
        const displayName = getDisplayName(input, input.mediaUrl);
        const report = (patch: Partial<IngestProgressEvent>) => {
          opts.onProgress?.({
            clientId,
            index,
            stage: 'queued',
            mediaType: input.mediaType,
            displayName,
            ...patch,
          });
        };

        report({ stage: 'queued', url: input.mediaUrl });
        try {
          const origin = detectOrigin(input);
          let normalizedUrl = normalizeMediaUrl(input.mediaUrl);
          const requestedTagSource =
            typeof input.context?.tagSource === 'string' ? String(input.context.tagSource).trim().toLowerCase() : '';
          const tags = origin === 'pixiv' || requestedTagSource === 'manual' ? extractTags(input) : [];
          const tagSource: 'manual' | 'pixiv' | 'auto' =
            requestedTagSource === 'manual' ? 'manual' : origin === 'pixiv' ? 'pixiv' : 'auto';

          const altUrlsRaw = Array.isArray(input.context?.alternateMediaUrls) ? input.context.alternateMediaUrls : [];
          let altUrls = altUrlsRaw
            .map((u) => (typeof u === 'string' ? u.trim() : ''))
            .filter(Boolean)
            .map((u) => normalizeMediaUrl(u))
            .filter((u) => u !== normalizedUrl);
          altUrls = normalizeCandidateUrls(altUrls);

          if (input.mediaType === 'video') {
            if (origin === 'xiaohongshu') {
              const pageCandidates = await getXiaohongshuVideoCandidates(input.sourcePageUrl);
              if (pageCandidates.length) {
                altUrls = normalizeCandidateUrls([...pageCandidates, ...altUrls]);
              }
            }
            if (origin === 'youtube') {
              const ytCandidates = await getYouTubeStreamCandidates(input.sourcePageUrl, inferReferer(input));
              const merged = normalizeCandidateUrls([...ytCandidates.videoUrls, normalizedUrl, ...altUrls])
                .filter((url) => isLikelyVideoUrl(url) && !isBlockedDocUrl(url))
                .sort((a, b) => scoreYouTubeVideoCandidateUrl(b) - scoreYouTubeVideoCandidateUrl(a));
              if (merged.length) {
                normalizedUrl = merged[0]!;
                altUrls = merged.slice(1);
              }
              logger.info('youtube video candidate plan', {
                sourcePageUrl: input.sourcePageUrl,
                selectedUrl: normalizedUrl,
                fallbackCount: altUrls.length,
                fetchedCandidateCount: ytCandidates.videoUrls.length,
                selectedIsManifest: isManifestLikeVideoUrl(normalizedUrl),
              });
            }

            altUrls = altUrls.filter((url) => isLikelyVideoUrl(url) && !isBlockedDocUrl(url));
            if (!isLikelyVideoUrl(normalizedUrl) && altUrls.length) {
              normalizedUrl = altUrls[0]!;
              altUrls = altUrls.filter((url) => url !== normalizedUrl);
            }
          }

          report({ stage: 'queued', url: normalizedUrl });

          const tmpPaths = new Set<string>();
          let dl: DownloadResult | null = null;
          let usedUrl = normalizedUrl;
          let audioUsedUrl: string | undefined;
          let usedYoutubeMerge = false;
          const transferTimeoutMs = origin === 'youtube' ? getYouTubeTransferTimeoutMs(opts.cfg.requestTimeoutMs) : opts.cfg.requestTimeoutMs;

          try {
            const primary = await downloadWithFallback({
              url: normalizedUrl,
              origin,
              tmpDir,
              timeoutMs: transferTimeoutMs,
              userAgent: opts.cfg.userAgent,
              proxyUrl: opts.cfg.proxyUrl,
              referer: inferReferer(input),
              fallbackUrls: altUrls,
              expectType: input.mediaType,
              onProgress: (info) => {
                report({
                  stage: 'downloading',
                  bytes: info.bytes,
                  total: info.total,
                  url: normalizedUrl,
                });
              },
            });
            dl = primary.dl;
            usedUrl = primary.usedUrl;
            tmpPaths.add(primary.dl.tmpPath);

            if (origin === 'youtube' && input.mediaType === 'video') {
              logger.info('youtube primary download complete', {
                requestedUrl: normalizedUrl,
                usedUrl,
                bytes: primary.dl.bytes,
                contentLength: primary.dl.contentLength,
                contentType: primary.dl.contentType,
                isManifest: isManifestLikeVideoUrl(usedUrl) || isManifestLikeVideoUrl(normalizedUrl),
              });
            }

            report({
              stage: 'downloaded',
              bytes: dl.bytes,
              total: dl.contentLength ?? dl.bytes,
              url: normalizedUrl,
              usedUrl,
            });

            if (input.mediaType === 'video' && origin === 'youtube') {
              const skipAudioMerge = isManifestLikeVideoUrl(usedUrl) || isManifestLikeVideoUrl(normalizedUrl);
              if (!skipAudioMerge) {
              const primaryAudioRaw = typeof input.context?.youtubeAudioUrl === 'string' ? input.context.youtubeAudioUrl : '';
              const altAudioRaw = Array.isArray(input.context?.youtubeAudioAltUrls) ? input.context.youtubeAudioAltUrls : [];
              const contextAudioCandidates = [
                primaryAudioRaw,
                ...altAudioRaw.map((u) => (typeof u === 'string' ? u : '')),
              ]
                .map((u) => u.trim())
                .filter(Boolean)
                .map((u) => normalizeMediaUrl(u))
                .filter((u) => !isBlockedDocUrl(u) && isLikelyAudioUrl(u));
              const ytCandidates = await getYouTubeStreamCandidates(input.sourcePageUrl, inferReferer(input));
              let audioCandidates = normalizeCandidateUrls([...ytCandidates.audioUrls, ...contextAudioCandidates])
                .filter((u) => !isBlockedDocUrl(u) && isLikelyAudioUrl(u))
                .sort((a, b) => scoreYouTubeAudioCandidateUrl(b) - scoreYouTubeAudioCandidateUrl(a));

              logger.info('youtube audio candidate plan', {
                sourcePageUrl: input.sourcePageUrl,
                contextCandidateCount: contextAudioCandidates.length,
                fetchedCandidateCount: ytCandidates.audioUrls.length,
                selectedCandidateCount: audioCandidates.length,
              });

              if (audioCandidates.length) {
                const primaryAudioUrl = audioCandidates[0]!;
                const audioFallback = audioCandidates.slice(1);
                const videoBytes = dl.bytes;
                const videoTotal = dl.contentLength ?? dl.bytes;
                logger.info('youtube audio download start', {
                  primaryAudioUrl,
                  fallbackCount: audioFallback.length,
                  videoBytes,
                });
                const audio = await downloadWithFallback({
                  url: primaryAudioUrl,
                  origin,
                  tmpDir,
                  timeoutMs: transferTimeoutMs,
                  userAgent: opts.cfg.userAgent,
                  proxyUrl: opts.cfg.proxyUrl,
                  referer: inferReferer(input),
                  fallbackUrls: audioFallback,
                  expectType: 'audio',
                  onProgress: (info) => {
                    const baseBytes = videoBytes;
                    const mergedBytes = baseBytes + (info.bytes ?? 0);
                    const mergedTotal = Number.isFinite(info.total)
                      ? baseBytes + Number(info.total)
                      : Number.isFinite(videoTotal)
                        ? Number(videoTotal)
                        : undefined;
                    report({
                      stage: 'downloading',
                      bytes: mergedBytes,
                      total: mergedTotal,
                      url: primaryAudioUrl,
                    });
                  },
                });
                audioUsedUrl = audio.usedUrl;
                tmpPaths.add(audio.dl.tmpPath);

                logger.info('youtube audio download complete', {
                  requestedUrl: primaryAudioUrl,
                  usedUrl: audioUsedUrl,
                  bytes: audio.dl.bytes,
                  contentLength: audio.dl.contentLength,
                  contentType: audio.dl.contentType,
                });

                report({
                  stage: 'downloaded',
                  bytes: videoBytes + audio.dl.bytes,
                  total: (dl.contentLength ?? dl.bytes) + (audio.dl.contentLength ?? audio.dl.bytes),
                  url: normalizedUrl,
                  usedUrl,
                });

                const merge = await mergeAudioVideoToTempFile({
                  videoPath: dl.tmpPath,
                  audioPath: audio.dl.tmpPath,
                  tmpDir,
                  timeoutMs: transferTimeoutMs,
                  onProgress: (info) => {
                    const mergedBytes = videoBytes + audio.dl.bytes + (info.bytes ?? 0);
                    const mergedTotal = Number.isFinite(info.total)
                      ? videoBytes + audio.dl.bytes + Number(info.total)
                      : undefined;
                    report({
                      stage: 'downloading',
                      bytes: mergedBytes,
                      total: mergedTotal,
                      url: normalizedUrl,
                    });
                  },
                });

                tmpPaths.add(merge.tmpPath);
                safeUnlink(dl.tmpPath);
                safeUnlink(audio.dl.tmpPath);
                tmpPaths.delete(dl.tmpPath);
                tmpPaths.delete(audio.dl.tmpPath);
                dl = merge;
                usedYoutubeMerge = true;
                logger.info('youtube merge complete', {
                  videoBytes,
                  audioBytes: audio.dl.bytes,
                  mergedBytes: merge.bytes,
                  mergedContentLength: merge.contentLength,
                });
                report({
                  stage: 'downloaded',
                  bytes: merge.bytes,
                  total: merge.contentLength ?? merge.bytes,
                  url: normalizedUrl,
                  usedUrl,
                });
              }
              }
            }

            if (!dl) throw new Error('download failed');

            const shouldLogDownload = process.env.XIC_DEBUG_DOWNLOAD === '1' || isDebugEnabled();
            if (shouldLogDownload) {
              logger.debug('download', {
                mediaType: input.mediaType,
                url: normalizedUrl,
                usedUrl,
                audioUsedUrl,
                merged: usedYoutubeMerge,
                bytes: dl.bytes,
                contentLength: dl.contentLength,
                status: dl.status,
                contentType: dl.contentType,
                alternates: altUrls,
              });
            }

            if (input.mediaType === 'video') {
              const ct = (dl.contentType ?? '').toLowerCase();
              const ext = (dl.ext ?? '').toLowerCase();
              const isImage =
                ct.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'].includes(ext);
              if (isImage) {
                throw new Error('expected video but got image content');
              }
              if (ct && !ct.startsWith('video/') && !ct.includes('octet-stream')) {
                throw new Error(`expected video but got content-type ${formatDownloadPayloadMismatchDetail(dl)}`);
              }
            }

            const sha256 = await sha256OfFile(dl.tmpPath);

            const existing = opts.db
              .prepare('SELECT id, local_path, thumb_path, type FROM media WHERE sha256 = ?')
              .get([sha256]) as { id: number; local_path: string; thumb_path: string | null; type: string } | undefined;

            if (existing) {
              // Still record the new source linkage.
              const sourceId = insertSourceAndLink(opts.db, existing.id, input);
              void sourceId;
              applyTags(opts.db, existing.id, tags, tagSource);
              safeUnlink(dl.tmpPath);
              tmpPaths.delete(dl.tmpPath);
              report({
                stage: 'exists',
                url: normalizedUrl,
                usedUrl,
                bytes: dl.bytes,
                total: dl.contentLength ?? dl.bytes,
              });
              return { input, ok: true, status: 'exists', mediaId: existing.id, sha256 };
            }

            const ext = safeExt(dl.ext) ?? (input.mediaType === 'video' ? 'mp4' : 'jpg');
            const fileName = `${sha256}.${ext}`;
            const finalPath = path.join(opts.layout.mediaDir, fileName);
            moveFileSync(dl.tmpPath, finalPath);
            tmpPaths.delete(dl.tmpPath);

            let width: number | null = null;
            let height: number | null = null;
            let thumbPath: string | null = null;
            let phash: string | null = null;

            if (input.mediaType === 'image') {
              try {
                const meta = await sharp(finalPath).metadata();
                width = meta.width ?? null;
                height = meta.height ?? null;
              } catch {
                // ignore; not fatal
              }
              phash = await computePHash(finalPath);
              const thumbName = `${sha256}.webp`;
              thumbPath = path.join(opts.layout.thumbsDir, thumbName);
              await createImageThumb({ inputPath: finalPath, outputPath: thumbPath, maxWidth: 520 });
            } else {
              // video thumbnail is optional
              const thumbName = `${sha256}.jpg`;
              const out = path.join(opts.layout.thumbsDir, thumbName);
              const r = await createVideoThumbIfPossible({ inputPath: finalPath, outputPath: out, maxWidth: 520 }).catch(
                () => ({ ok: false, reason: 'ffmpeg failed' as const }),
              );
              if (r.ok) thumbPath = out;
            }

            const savedAt = isoNow();
            const insert = opts.db.prepare(
              `INSERT INTO media
                (sha256, phash, type, original_url, local_path, thumb_path, width, height, duration_ms, created_at, saved_at, origin, archived_at)
               VALUES
                (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            );

            const info = insert.run([
              sha256,
              phash,
              input.mediaType,
              usedUrl,
              finalPath,
              thumbPath,
              width,
              height,
              null,
              null,
              savedAt,
              origin,
              null,
            ]);

            const mediaId = Number(info.lastInsertRowid);
            insertSourceAndLink(opts.db, mediaId, input);
            applyTags(opts.db, mediaId, tags, tagSource);

            report({
              stage: 'created',
              url: normalizedUrl,
              usedUrl,
              bytes: dl.bytes,
              total: dl.contentLength ?? dl.bytes,
            });
            return { input, ok: true, status: 'created', mediaId, sha256 };
          } finally {
            for (const tmpPath of tmpPaths) {
              safeUnlink(tmpPath);
            }
          }
        } catch (err) {
          report({
            stage: 'failed',
            url: input.mediaUrl,
            error: err instanceof Error ? err.message : String(err),
          });
          return { input, ok: false, status: 'failed', error: err instanceof Error ? err.message : String(err) };
        }
      }),
    ),
  );

  return { results };
}

function insertSourceAndLink(db: Db, mediaId: number, input: IngestItem): number {
  const sourceInsert = db.prepare(
    `INSERT INTO source (tweet_url, source_page_url, author_handle, tweet_id, collected_at)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const tweetId = input.tweetUrl ? extractTweetId(input.tweetUrl) : null;
  const s = sourceInsert.run([
    input.tweetUrl ?? null,
    input.sourcePageUrl,
    input.authorHandle ?? null,
    tweetId,
    input.collectedAt,
  ]);
  const sourceId = Number(s.lastInsertRowid);

  db.prepare(`INSERT OR IGNORE INTO media_source (media_id, source_id) VALUES (?, ?)`).run([
    mediaId,
    sourceId,
  ]);

  return sourceId;
}

function extractTweetId(tweetUrl: string): string | null {
  try {
    const u = new URL(tweetUrl);
    const m = u.pathname.match(/\/status\/(\d+)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}
