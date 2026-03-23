import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import pLimit from 'p-limit';
import sharp from 'sharp';

import type { Db } from './db.js';
import type { FsLayout } from './fs-layout.js';
import type { ServerConfig } from './config.js';
import { normalizeMediaUrl } from './url-normalize.js';
import { downloadToTempFile } from './download.js';
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

function detectOrigin(input: IngestItem): 'x' | 'pixiv' | 'duitang' | 'other' {
  const site = String(input.context?.site ?? '').toLowerCase();
  if (site === 'x' || site === 'pixiv' || site === 'duitang') return site;
  try {
    const host = new URL(input.sourcePageUrl).hostname.toLowerCase();
    if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) return 'x';
    if (host === 'pixiv.net' || host.endsWith('.pixiv.net') || host.endsWith('.pximg.net')) return 'pixiv';
    if (host === 'duitang.com' || host.endsWith('.duitang.com')) return 'duitang';
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
  origin: 'x' | 'pixiv' | 'duitang' | 'other';
  tmpDir: string;
  timeoutMs: number;
  userAgent: string;
  proxyUrl?: string;
  referer?: string;
  retries?: number;
  fallbackUrls?: string[];
  expectType?: 'image' | 'video';
  onProgress?: ProgressCallback;
}): Promise<{ dl: DownloadResult; usedUrl: string }> {
  const baseUrls = [opts.url, ...(opts.fallbackUrls ?? [])].filter(Boolean);
  const expanded: string[] = [];
  for (const u of baseUrls) {
    if (opts.origin === 'pixiv') {
      expanded.push(...buildPixivFallbackUrls(u));
    } else {
      expanded.push(u);
    }
  }
  const urls = Array.from(new Set(expanded));
  let lastErr: unknown;
  let best: { dl: DownloadResult; usedUrl: string } | null = null;
  const minVideoBytes = 1_200_000;
  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i];
    try {
      const dl = await downloadToTempFile({
        url,
        tmpDir: opts.tmpDir,
        timeoutMs: opts.timeoutMs,
        userAgent: opts.userAgent,
        proxyUrl: opts.proxyUrl,
        referer: opts.referer,
        retries: opts.retries,
        onProgress: opts.onProgress,
      });
      if (opts.expectType === 'video') {
        const ct = (dl.contentType ?? '').toLowerCase();
        const ext = (dl.ext ?? '').toLowerCase();
        const isImage =
          ct.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'].includes(ext);
        if (isImage) {
          throw new Error('expected video but got image content');
        }
      }

      if (opts.expectType === 'video' && dl.bytes < minVideoBytes && i < urls.length - 1) {
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
      lastErr = err;
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
          const normalizedUrl = normalizeMediaUrl(input.mediaUrl);
          const tags = extractTags(input);
          const tagSource: 'manual' | 'pixiv' | 'auto' = origin === 'pixiv' ? 'pixiv' : 'auto';
          report({ stage: 'queued', url: normalizedUrl });

          const altUrlsRaw = Array.isArray(input.context?.alternateMediaUrls) ? input.context.alternateMediaUrls : [];
          const altUrls = altUrlsRaw
            .map((u) => (typeof u === 'string' ? u.trim() : ''))
            .filter(Boolean)
            .map((u) => normalizeMediaUrl(u))
            .filter((u) => u !== normalizedUrl);

          const { dl, usedUrl } = await downloadWithFallback({
            url: normalizedUrl,
            origin,
            tmpDir,
            timeoutMs: opts.cfg.requestTimeoutMs,
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

          report({
            stage: 'downloaded',
            bytes: dl.bytes,
            total: dl.contentLength ?? dl.bytes,
            url: normalizedUrl,
            usedUrl,
          });

          const shouldLogDownload = process.env.XIC_DEBUG_DOWNLOAD === '1' || isDebugEnabled();
          if (shouldLogDownload) {
            logger.debug('download', {
              mediaType: input.mediaType,
              url: normalizedUrl,
              usedUrl,
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
              throw new Error(`expected video but got content-type ${ct}`);
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
            try {
              fs.unlinkSync(dl.tmpPath);
            } catch {
              // ignore
            }
            report({ stage: 'exists', url: normalizedUrl, usedUrl });
            return { input, ok: true, status: 'exists', mediaId: existing.id, sha256 };
          }

          const ext = safeExt(dl.ext) ?? (input.mediaType === 'video' ? 'mp4' : 'jpg');
          const fileName = `${sha256}.${ext}`;
          const finalPath = path.join(opts.layout.mediaDir, fileName);
          moveFileSync(dl.tmpPath, finalPath);

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

          report({ stage: 'created', url: normalizedUrl, usedUrl });
          return { input, ok: true, status: 'created', mediaId, sha256 };
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
