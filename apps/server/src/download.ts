import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import mime from 'mime-types';
import { ProxyAgent } from 'undici';

export type DownloadResult = {
  tmpPath: string;
  contentType?: string;
  ext?: string;
  bytes: number;
  contentLength?: number;
  status?: number;
};

export type DownloadProgress = {
  bytes: number;
  total?: number;
};

export type ProgressCallback = (info: DownloadProgress) => void;

const proxyAgents = new Map<string, ProxyAgent>();

function getProxyAgent(proxyUrl: string) {
  const cached = proxyAgents.get(proxyUrl);
  if (cached) return cached;
  const agent = new ProxyAgent(proxyUrl);
  proxyAgents.set(proxyUrl, agent);
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

function isTwitterVideoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.endsWith('video.twimg.com');
  } catch {
    return false;
  }
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

async function downloadHlsToTempFile(opts: {
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
        '-loglevel',
        'error',
        '-user_agent',
        opts.userAgent,
        ...(headerValue ? ['-headers', headerValue] : []),
        '-i',
        opts.url,
        '-c',
        'copy',
        '-bsf:a',
        'aac_adtstoasc',
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
        const p = childProcess.spawn('ffmpeg', args, { stdio: 'ignore', env });
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
        lastErr = new Error('ffmpeg not found (required for HLS video)');
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

export async function downloadToTempFile(opts: {
  url: string;
  tmpDir: string;
  timeoutMs: number;
  userAgent: string;
  proxyUrl?: string;
  referer?: string;
  retries?: number;
  onProgress?: ProgressCallback;
}): Promise<DownloadResult> {
  if (isHlsUrl(opts.url)) {
    return downloadHlsToTempFile(opts);
  }
  fs.mkdirSync(opts.tmpDir, { recursive: true });
  const retries = opts.retries ?? 2;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const tmpName = crypto.randomBytes(16).toString('hex');
    const tmpPath = path.join(opts.tmpDir, `${tmpName}.tmp`);

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
      const dispatcher = opts.proxyUrl ? getProxyAgent(opts.proxyUrl) : undefined;
      const headers: Record<string, string> = {
        'user-agent': opts.userAgent,
        // Some CDNs behave better with a conservative accept.
        accept: '*/*',
      };
      if (opts.referer) headers.referer = opts.referer;

      const res = await fetch(opts.url, {
        signal: ctrl.signal,
        headers,
        dispatcher,
      }).finally(() => clearTimeout(timer));

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const contentType = res.headers.get('content-type') ?? undefined;
      const contentLengthHeader = res.headers.get('content-length');
      const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
      if (isHlsContentType(contentType)) {
        try {
          await res.body.cancel();
        } catch {
          // ignore
        }
        return downloadHlsToTempFile(opts);
      }
      const inferredExt =
        (contentType ? mime.extension(contentType) || undefined : undefined) ?? extFromUrl(opts.url);

      const out = fs.createWriteStream(tmpPath);
      let downloaded = 0;
      const progress = new Transform({
        transform(chunk, _enc, cb) {
          downloaded += chunk.length;
          opts.onProgress?.({ bytes: downloaded, total: contentLength });
          cb(null, chunk);
        },
      });
      opts.onProgress?.({ bytes: 0, total: contentLength });
      await pipeline(res.body as any, progress, out);

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
            const hls = await downloadHlsToTempFile({
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

      return {
        tmpPath,
        contentType,
        ext: inferredExt,
        bytes,
        contentLength: Number.isFinite(contentLength) ? (contentLength as number) : undefined,
        status: res.status,
      };
    } catch (err) {
      lastErr = err;
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
