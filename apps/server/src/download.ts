import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import mime from 'mime-types';
import { ProxyAgent } from 'undici';
import { isDebugEnabled, logger } from './logger.js';

export type DownloadResult = {
  tmpPath: string;
  contentType?: string;
  ext?: string;
  bytes: number;
  contentLength?: number;
  status?: number;
  textPreview?: string;
};

export type DownloadProgress = {
  bytes: number;
  total?: number;
};

export type ProgressCallback = (info: DownloadProgress) => void;

const proxyAgents = new Map<string, ProxyAgent>();
const DEFAULT_PROXY_CONNECT_TIMEOUT_MS = 35_000;
const ENV_PROXY_CONNECT_TIMEOUT_MS = Number(process.env.XIC_PROXY_CONNECT_TIMEOUT_MS ?? NaN);

function getProxyConnectTimeoutMs(requestTimeoutMs?: number): number {
  const configured = Number.isFinite(ENV_PROXY_CONNECT_TIMEOUT_MS) && ENV_PROXY_CONNECT_TIMEOUT_MS > 0
    ? Math.floor(ENV_PROXY_CONNECT_TIMEOUT_MS)
    : DEFAULT_PROXY_CONNECT_TIMEOUT_MS;
  const requestTimeout = Number.isFinite(requestTimeoutMs) && Number(requestTimeoutMs) > 0
    ? Math.floor(Number(requestTimeoutMs))
    : configured;
  return Math.max(configured, requestTimeout);
}

function getProxyAgent(proxyUrl: string, connectTimeoutMs?: number) {
  const timeoutMs = getProxyConnectTimeoutMs(connectTimeoutMs);
  const cacheKey = `${proxyUrl}::${timeoutMs}`;
  const cached = proxyAgents.get(cacheKey);
  if (cached) return cached;
  const agent = new ProxyAgent({
    uri: proxyUrl,
    connectTimeout: timeoutMs,
  });
  proxyAgents.set(cacheKey, agent);
  return agent;
}

function extFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    const base = path.basename(u.pathname);
    const dot = base.lastIndexOf('.');
    if (dot >= 0 && dot < base.length - 1) return base.slice(dot + 1).toLowerCase();
  } catch {
    // ignore
  }
  return undefined;
}

function isHlsUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.includes('.m3u8')) return true;
  if (/[?&](?:format|type|mime)=.*m3u8/.test(lower)) return true;
  if (/[?&]mime=application%2f(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl)/.test(lower)) return true;
  return false;
}

function isDashUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.includes('.mpd')) return true;
  if (/\/manifest\/dash(?:\/|$)|\/api\/manifest\/dash(?:\/|$)/.test(lower)) return true;
  if (/[?&](?:format|type|mime)=.*(?:mpd|dash)/.test(lower)) return true;
  if (/[?&]mime=application%2fdash%2bxml/.test(lower)) return true;
  if (/[?&](?:manifest|dash)=/i.test(lower)) return true;
  return false;
}

function isStreamingManifestUrl(url: string): boolean {
  return isHlsUrl(url) || isDashUrl(url);
}

function isHlsContentType(contentType?: string | null): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return (
    ct.includes('application/vnd.apple.mpegurl') ||
    ct.includes('application/x-mpegurl') ||
    ct.includes('application/mpegurl') ||
    ct.includes('audio/mpegurl')
  );
}

function isDashContentType(contentType?: string | null): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ct.includes('application/dash+xml') || ct.includes('application/vnd.mpeg.dash.mpd');
}

function isStreamingManifestContentType(contentType?: string | null): boolean {
  return isHlsContentType(contentType) || isDashContentType(contentType);
}

function isTwitterVideoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.endsWith('video.twimg.com');
  } catch {
    return false;
  }
}

function shouldDisableResumeForUrl(url: string): boolean {
  if (!isYouTubeLikeDownloadUrl(url) || isStreamingManifestUrl(url)) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if (!(host === 'googlevideo.com' || host.endsWith('.googlevideo.com'))) {
      return false;
    }
    return path.includes('videoplayback');
  } catch {
    return false;
  }
}

function shouldCaptureTextPreview(contentType?: string, bytes?: number): boolean {
  const ct = String(contentType ?? '').toLowerCase();
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n) || n <= 0 || n > 4096) return false;
  return (
    ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('xml') ||
    ct.includes('javascript') ||
    ct.includes('application/vnd.yt-ump')
  );
}

function readTextPreview(filePath: string, maxChars = 140): string | undefined {
  try {
    const raw = fs.readFileSync(filePath);
    if (!raw.length) return undefined;
    const text = raw.toString('utf8').replace(/\s+/g, ' ').trim();
    if (!text) return undefined;
    return text.slice(0, maxChars);
  } catch {
    return undefined;
  }
}

function isGoogleVideoLikeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return host === 'googlevideo.com' || host.endsWith('.googlevideo.com') || host.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

function isYouTubeLikeDownloadUrl(url: string): boolean {
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

function summarizeUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    const importantKeys = [
      'itag',
      'mime',
      'quality',
      'quality_label',
      'clen',
      'id',
      'expire',
      'source',
      'c',
      'sabr',
      'rn',
      'rbuf',
      'redirect_counter',
    ];
    const summary = new URL(`${u.protocol}//${u.host}${u.pathname}`);
    for (const key of importantKeys) {
      const value = u.searchParams.get(key);
      if (value) summary.searchParams.set(key, value);
    }
    return summary.toString();
  } catch {
    return url;
  }
}

function parseContentRangeTotal(contentRange?: string | null): number | undefined {
  const raw = String(contentRange ?? '').trim();
  if (!raw) return undefined;
  const match = raw.match(/bytes\s+\d+-\d+\/(\d+|\*)/i);
  if (!match?.[1] || match[1] === '*') return undefined;
  const total = Number(match[1]);
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

function shouldFollowInlineUrlPointer(contentType: string | undefined, bytes: number, sourceUrl: string): boolean {
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > 12_000) return false;
  if (!isGoogleVideoLikeUrl(sourceUrl)) return false;
  const ct = String(contentType ?? '').toLowerCase();
  if (!ct) return true;
  if (ct.startsWith('text/')) return true;
  if (ct.includes('application/vnd.yt-ump')) return true;
  if (ct.includes('application/octet-stream')) return true;
  return false;
}

function readSmallUtf8Text(filePath: string, maxBytes = 16_384): string | undefined {
  try {
    const raw = fs.readFileSync(filePath);
    if (!raw.length) return undefined;
    const clipped = raw.length > maxBytes ? raw.subarray(0, maxBytes) : raw;
    const text = clipped.toString('utf8').trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

function decodeEscapedText(text: string): string {
  return text
    .replace(/\\u002f/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u003f/gi, '?')
    .replace(/\\u003a/gi, ':')
    .replace(/\\x2f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x2F;|&#47;/gi, '/');
}

function cleanExtractedUrl(raw: string): string {
  return raw.replace(/["'`<>]+$/g, '').replace(/[),.;]+$/g, '');
}

function extractInlineHttpUrls(text: string): string[] {
  const out = new Set<string>();
  const normalized = decodeEscapedText(text);
  const re = /https?:\/\/[^\s"'<>`\\]+/g;
  let match = re.exec(normalized);
  while (match) {
    const candidate = cleanExtractedUrl(match[0] ?? '');
    if (candidate) out.add(candidate);
    match = re.exec(normalized);
  }
  return Array.from(out);
}

function pickFollowTargetFromInlineText(text: string, currentUrl: string): string | undefined {
  const urls = extractInlineHttpUrls(text);
  for (const nextUrl of urls) {
    if (!nextUrl) continue;
    if (nextUrl === currentUrl) continue;
    if (!/^https?:\/\//i.test(nextUrl)) continue;
    return nextUrl;
  }
  return undefined;
}

function buildTwitterHlsUrlFromMp4(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('video.twimg.com')) return null;
    const nextPath = u.pathname.replace(/\/vid\/.*\/([^/]+)\.mp4$/i, '/pl/$1.m3u8');
    if (nextPath === u.pathname) return null;
    u.pathname = nextPath;
    if (!u.searchParams.has('container')) {
      u.searchParams.set('container', 'fmp4');
    }
    return u.toString();
  } catch {
    return null;
  }
}

async function downloadStreamingManifestToTempFile(opts: {
  url: string;
  tmpDir: string;
  timeoutMs: number;
  userAgent: string;
  proxyUrl?: string;
  referer?: string;
  retries?: number;
  onProgress?: ProgressCallback;
}): Promise<DownloadResult> {
  fs.mkdirSync(opts.tmpDir, { recursive: true });
  const retries = opts.retries ?? 1;
  const useHlsAudioBitstreamFilter = isHlsUrl(opts.url) && !isDashUrl(opts.url);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const tmpName = crypto.randomBytes(16).toString('hex');
    const tmpPath = path.join(opts.tmpDir, `${tmpName}.mp4`);

    try {
      const headers: string[] = [];
      if (opts.userAgent) headers.push(`User-Agent: ${opts.userAgent}`);
      if (opts.referer) headers.push(`Referer: ${opts.referer}`);
      const headerValue = headers.length ? `${headers.join('\r\n')}\r\n` : undefined;

      const args = [
        '-y',
        '-progress',
        'pipe:1',
        '-nostats',
        '-loglevel',
        'error',
        '-user_agent',
        opts.userAgent,
        ...(headerValue ? ['-headers', headerValue] : []),
        '-i',
        opts.url,
        '-c',
        'copy',
        ...(useHlsAudioBitstreamFilter ? ['-bsf:a', 'aac_adtstoasc'] : []),
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        tmpPath,
      ];

      opts.onProgress?.({ bytes: 0 });
      await new Promise<void>((resolve, reject) => {
        const env = { ...process.env };
        if (opts.proxyUrl) {
          env.HTTP_PROXY = opts.proxyUrl;
          env.HTTPS_PROXY = opts.proxyUrl;
          env.ALL_PROXY = opts.proxyUrl;
        }
        const p = childProcess.spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
        let lastBytes = 0;
        let lastEmit = 0;
        const emit = (bytes: number) => {
          if (!Number.isFinite(bytes) || bytes <= 0) return;
          const now = Date.now();
          // Throttle progress events a bit.
          if (bytes <= lastBytes && now - lastEmit < 600) return;
          lastBytes = Math.max(lastBytes, bytes);
          lastEmit = now;
          opts.onProgress?.({ bytes: lastBytes });
        };

        const bindProgressReader = (stream: NodeJS.ReadableStream | null | undefined) => {
          if (!stream) return;
          let buffer = '';
          stream.setEncoding('utf8');
          stream.on('data', (chunk: string) => {
            buffer += chunk;
            let idx = buffer.indexOf('\n');
            while (idx >= 0) {
              const line = buffer.slice(0, idx).trim();
              buffer = buffer.slice(idx + 1);
              if (line.startsWith('total_size=')) {
                const n = Number(line.slice('total_size='.length).trim());
                if (Number.isFinite(n) && n > 0) emit(n);
              } else {
                const sizeMatch = line.match(/size=\s*([0-9]+)kB/i);
                if (sizeMatch?.[1]) {
                  const n = Number(sizeMatch[1]) * 1024;
                  if (Number.isFinite(n) && n > 0) emit(n);
                }
              }
              idx = buffer.indexOf('\n');
            }
          });
        };
        bindProgressReader(p.stdout);
        bindProgressReader(p.stderr);

        // Fallback for builds where total_size is not present: poll the tmp file size.
        const poll = setInterval(() => {
          try {
            const st = fs.statSync(tmpPath);
            if (st.size > 0) emit(st.size);
          } catch {
            // ignore
          }
        }, 700);
        let timeout: NodeJS.Timeout | null = null;
        if (opts.timeoutMs > 0) {
          timeout = setTimeout(() => {
            try {
              p.kill();
            } catch {
              // ignore
            }
          }, opts.timeoutMs);
        }
        p.on('error', (err) => reject(err));
        p.on('exit', (code) => {
          clearInterval(poll);
          if (timeout) clearTimeout(timeout);
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg exit code ${code ?? 'unknown'}`));
        });
      });

      const stat = fs.statSync(tmpPath);
      opts.onProgress?.({ bytes: stat.size, total: stat.size });
      return {
        tmpPath,
        contentType: 'video/mp4',
        ext: 'mp4',
        bytes: stat.size,
      };
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String((err as any).code) : '';
      if (code === 'ENOENT') {
        lastErr = new Error('ffmpeg not found (required for manifest video)');
      } else {
        lastErr = err;
      }
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      if (attempt < retries) {
        await delay(350 * (attempt + 1));
        continue;
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function mergeAudioVideoToTempFile(opts: {
  videoPath: string;
  audioPath: string;
  tmpDir: string;
  timeoutMs: number;
  onProgress?: ProgressCallback;
}): Promise<DownloadResult> {
  fs.mkdirSync(opts.tmpDir, { recursive: true });
  const tmpName = crypto.randomBytes(16).toString('hex');
  const tmpPath = path.join(opts.tmpDir, `${tmpName}.mp4`);

  const videoBytes = fs.existsSync(opts.videoPath) ? fs.statSync(opts.videoPath).size : 0;
  const audioBytes = fs.existsSync(opts.audioPath) ? fs.statSync(opts.audioPath).size : 0;
  const totalHint = Math.max(0, videoBytes) + Math.max(0, audioBytes);

  try {
    opts.onProgress?.({ bytes: 0, total: totalHint > 0 ? totalHint : undefined });
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-y',
        '-progress',
        'pipe:1',
        '-nostats',
        '-loglevel',
        'error',
        '-i',
        opts.videoPath,
        '-i',
        opts.audioPath,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        tmpPath,
      ];
      const p = childProcess.spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let lastBytes = 0;
      let lastEmit = 0;
      const emit = (bytes: number) => {
        if (!Number.isFinite(bytes) || bytes <= 0) return;
        const now = Date.now();
        if (bytes <= lastBytes && now - lastEmit < 500) return;
        lastBytes = Math.max(lastBytes, bytes);
        lastEmit = now;
        const normalizedTotal = totalHint > 0 ? Math.max(totalHint, lastBytes) : undefined;
        opts.onProgress?.({ bytes: lastBytes, total: normalizedTotal });
      };

      const bindProgressReader = (stream: NodeJS.ReadableStream | null | undefined) => {
        if (!stream) return;
        let buffer = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
          buffer += chunk;
          let idx = buffer.indexOf('\n');
          while (idx >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (line.startsWith('total_size=')) {
              const n = Number(line.slice('total_size='.length).trim());
              if (Number.isFinite(n) && n > 0) emit(n);
            } else {
              const sizeMatch = line.match(/size=\s*([0-9]+)kB/i);
              if (sizeMatch?.[1]) {
                const n = Number(sizeMatch[1]) * 1024;
                if (Number.isFinite(n) && n > 0) emit(n);
              }
            }
            idx = buffer.indexOf('\n');
          }
        });
      };

      bindProgressReader(p.stdout);
      bindProgressReader(p.stderr);

      const poll = setInterval(() => {
        try {
          if (!fs.existsSync(tmpPath)) return;
          const st = fs.statSync(tmpPath);
          if (st.size > 0) emit(st.size);
        } catch {
          // ignore
        }
      }, 500);

      let timeout: NodeJS.Timeout | null = null;
      if (opts.timeoutMs > 0) {
        timeout = setTimeout(() => {
          try {
            p.kill();
          } catch {
            // ignore
          }
        }, opts.timeoutMs);
      }

      p.on('error', (err) => reject(err));
      p.on('exit', (code) => {
        clearInterval(poll);
        if (timeout) clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg merge exit code ${code ?? 'unknown'}`));
      });
    });

    const stat = fs.statSync(tmpPath);
    opts.onProgress?.({ bytes: stat.size, total: Math.max(stat.size, totalHint) || undefined });
    return {
      tmpPath,
      contentType: 'video/mp4',
      ext: 'mp4',
      bytes: stat.size,
      contentLength: stat.size,
    };
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as any).code) : '';
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    if (code === 'ENOENT') {
      throw new Error('ffmpeg not found (required for YouTube audio/video merge)');
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function downloadToTempFile(opts: {
  url: string;
  tmpDir: string;
  timeoutMs: number;
  userAgent: string;
  proxyUrl?: string;
  referer?: string;
  retries?: number;
  onProgress?: ProgressCallback;
  inlineUrlHops?: number;
}): Promise<DownloadResult> {
  if (isStreamingManifestUrl(opts.url)) {
    return downloadStreamingManifestToTempFile(opts);
  }
  fs.mkdirSync(opts.tmpDir, { recursive: true });
  const retries = opts.retries ?? 2;
  const inlineUrlHops = Number.isFinite(opts.inlineUrlHops) ? Math.max(0, Number(opts.inlineUrlHops)) : 4;
  const tmpName = crypto.randomBytes(16).toString('hex');
  const tmpPath = path.join(opts.tmpDir, `${tmpName}.tmp`);

  let lastErr: unknown;
  const normalizeDownloadError = (err: unknown): Error => {
    if (err instanceof Error) {
      const cause = (err as any)?.cause;
      const causeMsg = cause && typeof cause === 'object' && 'message' in cause ? String((cause as any).message ?? '') : '';
      if (err.message === 'fetch failed' && causeMsg) {
        return new Error(`fetch failed: ${causeMsg}`);
      }
      return err;
    }
    return new Error(String(err));
  };
  const youtubeLike = isYouTubeLikeDownloadUrl(opts.url);
  const disableResume = shouldDisableResumeForUrl(opts.url);
  for (let attempt = 0; attempt <= retries; attempt++) {
    let timer: NodeJS.Timeout | null = null;
    try {
      const ctrl = new AbortController();
      const resetTimer = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => ctrl.abort(new Error(`download idle timeout after ${opts.timeoutMs}ms`)), opts.timeoutMs);
      };
      resetTimer();
      const dispatcher = opts.proxyUrl ? getProxyAgent(opts.proxyUrl, opts.timeoutMs) : undefined;
      let host = '';
      try {
        host = new URL(opts.url).hostname.toLowerCase();
      } catch {
        host = '';
      }
      const isYouTubeLikeHost =
        host === 'youtube.com' ||
        host.endsWith('.youtube.com') ||
        host === 'googlevideo.com' ||
        host.endsWith('.googlevideo.com') ||
        host === 'youtu.be' ||
        host.endsWith('.youtu.be');
      const headers: Record<string, string> = {
        'user-agent': opts.userAgent,
        // Some CDNs behave better with a conservative accept.
        accept: '*/*',
      };
      let existingBytes = 0;
      try {
        if (disableResume && fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
        existingBytes = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
      } catch {
        existingBytes = 0;
      }
      if (existingBytes > 0) {
        headers.range = `bytes=${existingBytes}-`;
      }
      if (opts.referer) {
        headers.referer = opts.referer;
      } else if (isYouTubeLikeHost) {
        headers.referer = 'https://www.youtube.com/';
      }
      if (isYouTubeLikeHost) {
        headers.origin = 'https://www.youtube.com';
      }

      const res = await fetch(opts.url, {
        signal: ctrl.signal,
        headers,
        dispatcher,
      }).finally(() => {
        if (timer) clearTimeout(timer);
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const contentType = res.headers.get('content-type') ?? undefined;
      const contentLengthHeader = res.headers.get('content-length');
      const responseContentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
      const contentRange = res.headers.get('content-range');
      const resumed = existingBytes > 0 && res.status === 206;
      if (existingBytes > 0 && !resumed) {
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
          // ignore
        }
        existingBytes = 0;
      }
      const contentLength = resumed
        ? parseContentRangeTotal(contentRange) ??
          (Number.isFinite(responseContentLength) ? existingBytes + Number(responseContentLength) : undefined)
        : responseContentLength;
      if (isStreamingManifestContentType(contentType)) {
        try {
          await res.body.cancel();
        } catch {
          // ignore
        }
        return downloadStreamingManifestToTempFile(opts);
      }
      const inferredExt =
        (contentType ? mime.extension(contentType) || undefined : undefined) ?? extFromUrl(opts.url);

      const out = fs.createWriteStream(tmpPath, resumed ? { flags: 'a' } : undefined);
      let downloaded = existingBytes;
      const progress = new Transform({
        transform(chunk, _enc, cb) {
          downloaded += chunk.length;
          resetTimer();
          opts.onProgress?.({ bytes: downloaded, total: contentLength });
          cb(null, chunk);
        },
      });
      resetTimer();
      opts.onProgress?.({ bytes: downloaded, total: contentLength });
      await pipeline(res.body as any, progress, out);
      if (timer) clearTimeout(timer);

      const stat = fs.statSync(tmpPath);
      const bytes = stat.size;
      if (Number.isFinite(contentLength) && (contentLength as number) > 0 && bytes < (contentLength as number)) {
        throw new Error(`incomplete download (${bytes}/${contentLength})`);
      }

      if (
        bytes > 0 &&
        bytes < 1_200_000 &&
        isTwitterVideoUrl(opts.url) &&
        (inferredExt === 'mp4' || (contentType ?? '').toLowerCase().includes('video'))
      ) {
        const hlsUrl = buildTwitterHlsUrlFromMp4(opts.url);
        if (hlsUrl) {
          try {
            const hls = await downloadStreamingManifestToTempFile({
              url: hlsUrl,
              tmpDir: opts.tmpDir,
              timeoutMs: opts.timeoutMs,
              userAgent: opts.userAgent,
              proxyUrl: opts.proxyUrl,
              referer: opts.referer,
              retries: opts.retries,
              onProgress: opts.onProgress,
            });
            if (hls.bytes > bytes) {
              try {
                fs.unlinkSync(tmpPath);
              } catch {
                // ignore
              }
              return hls;
            }
            try {
              if (fs.existsSync(hls.tmpPath)) fs.unlinkSync(hls.tmpPath);
            } catch {
              // ignore
            }
          } catch {
            // ignore and keep original mp4
          }
        }
      }

      const textPreview = shouldCaptureTextPreview(contentType, bytes) ? readTextPreview(tmpPath) : undefined;

      if (inlineUrlHops > 0 && shouldFollowInlineUrlPointer(contentType, bytes, opts.url)) {
        const textBody = readSmallUtf8Text(tmpPath);
        const followUrl = textBody ? pickFollowTargetFromInlineText(textBody, opts.url) : undefined;
        if (followUrl) {
          try {
            fs.unlinkSync(tmpPath);
          } catch {
            // ignore
          }
          return downloadToTempFile({
            ...opts,
            url: followUrl,
            inlineUrlHops: inlineUrlHops - 1,
          });
        }
      }

      return {
        tmpPath,
        contentType,
        ext: inferredExt,
        bytes,
        contentLength: Number.isFinite(contentLength) ? (contentLength as number) : undefined,
        status: res.status,
        textPreview,
      };
    } catch (err) {
      if (timer) clearTimeout(timer);
      lastErr = normalizeDownloadError(err);
      let partialBytes = 0;
      try {
        partialBytes = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
      } catch {
        partialBytes = 0;
      }
      if (youtubeLike) {
        logger.info('youtube download attempt failed', {
          url: summarizeUrlForLog(opts.url),
          attempt: attempt + 1,
          retries: retries + 1,
          bytes: partialBytes,
          resumeDisabled: disableResume,
          proxy: Boolean(opts.proxyUrl),
          error: lastErr instanceof Error ? lastErr.message : String(lastErr),
        });
      } else if (isDebugEnabled()) {
        logger.debug('download attempt failed', {
          url: summarizeUrlForLog(opts.url),
          attempt: attempt + 1,
          retries: retries + 1,
          bytes: partialBytes,
          error: lastErr instanceof Error ? lastErr.message : String(lastErr),
        });
      }
      if (attempt < retries) {
        if (disableResume) {
          try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
          } catch {
            // ignore
          }
        }
        await delay(350 * (attempt + 1));
        continue;
      }
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
