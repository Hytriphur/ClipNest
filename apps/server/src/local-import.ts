import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

import type { Db } from './db.js';
import type { FsLayout } from './fs-layout.js';
import type { ServerConfig } from './config.js';
import { createImageThumb, createVideoThumbIfPossible } from './thumbs.js';
import { computePHash } from './phash.js';

type LocalImportSummary = {
  total: number;
  created: number;
  exists: number;
  failed: number;
};

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv']);

function isoNow() {
  return new Date().toISOString();
}

function safeExt(ext?: string) {
  if (!ext) return undefined;
  const e = ext.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!e) return undefined;
  return e.slice(0, 8);
}

function detectType(filePath: string): 'image' | 'video' | null {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return null;
}

export function scanLocalFiles(rootPath: string, recursive: boolean): string[] {
  const out: string[] = [];
  const stat = fs.statSync(rootPath);
  if (stat.isFile()) {
    out.push(rootPath);
    return out;
  }

  const stack = [rootPath];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (recursive) stack.push(full);
        continue;
      }
      if (ent.isFile()) out.push(full);
    }
  }
  return out;
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

export async function ingestLocalFiles(opts: {
  db: Db;
  layout: FsLayout;
  cfg: ServerConfig;
  files: string[];
  sourceRoot: string;
  libraryRoot?: string | null;
}): Promise<{ summary: LocalImportSummary }> {
  const summary: LocalImportSummary = { total: 0, created: 0, exists: 0, failed: 0 };
  const sourcePageUrl = `local://${opts.sourceRoot.replace(/\\/g, '/')}`;
  const libraryRoot = opts.libraryRoot ? path.resolve(opts.libraryRoot) : null;

  for (const filePath of opts.files) {
    const mediaType = detectType(filePath);
    if (!mediaType) continue;
    summary.total += 1;
    try {
      const sha256 = await sha256OfFile(filePath);
      const existing = opts.db
        .prepare('SELECT id FROM media WHERE sha256 = ?')
        .get([sha256]) as { id: number } | undefined;

      if (existing) {
        insertLocalSource(opts.db, existing.id, sourcePageUrl);
        summary.exists += 1;
        continue;
      }

      const ext = safeExt(path.extname(filePath)) ?? (mediaType === 'video' ? 'mp4' : 'jpg');
      const fileName = `${sha256}.${ext}`;
      let finalPath = filePath;

      if (libraryRoot) {
        const resolvedFile = path.resolve(filePath);
        const inRoot = isSubPath(libraryRoot, resolvedFile);
        if (!inRoot) {
          const inboxDir = path.join(libraryRoot, '_inbox');
          fs.mkdirSync(inboxDir, { recursive: true });
          finalPath = path.join(inboxDir, fileName);
          if (!fs.existsSync(finalPath)) {
            fs.copyFileSync(filePath, finalPath);
          }
        }
      } else {
        finalPath = path.join(opts.layout.mediaDir, fileName);
        if (!fs.existsSync(finalPath)) {
          fs.copyFileSync(filePath, finalPath);
        }
      }

      let width: number | null = null;
      let height: number | null = null;
      let thumbPath: string | null = null;
      let phash: string | null = null;

      if (mediaType === 'image') {
        try {
          const meta = await sharp(finalPath).metadata();
          width = meta.width ?? null;
          height = meta.height ?? null;
        } catch {
          // ignore
        }
        phash = await computePHash(finalPath);
        const thumbName = `${sha256}.webp`;
        thumbPath = path.join(opts.layout.thumbsDir, thumbName);
        await createImageThumb({ inputPath: finalPath, outputPath: thumbPath, maxWidth: 520 });
      } else {
        const thumbName = `${sha256}.jpg`;
        const out = path.join(opts.layout.thumbsDir, thumbName);
        const r = await createVideoThumbIfPossible({ inputPath: finalPath, outputPath: out, maxWidth: 520 }).catch(
          () => ({ ok: false, reason: 'ffmpeg failed' as const }),
        );
        if (r.ok) thumbPath = out;
      }

      const savedAt = isoNow();
      let createdAt: string | null = null;
      try {
        const stat = fs.statSync(filePath);
        createdAt = stat.mtime ? stat.mtime.toISOString() : null;
      } catch {
        createdAt = null;
      }

      const originalUrl = pathToFileURL(finalPath).toString();
      const insert = opts.db.prepare(
        `INSERT INTO media
          (sha256, phash, type, original_url, local_path, thumb_path, width, height, duration_ms, created_at, saved_at, origin, archived_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      const info = insert.run([
        sha256,
        phash,
        mediaType,
        originalUrl,
        finalPath,
        thumbPath,
        width,
        height,
        null,
        createdAt,
        savedAt,
        'local',
        null,
      ]);

      const mediaId = Number(info.lastInsertRowid);
      insertLocalSource(opts.db, mediaId, sourcePageUrl);
      summary.created += 1;
    } catch {
      summary.failed += 1;
    }
  }

  return { summary };
}

function insertLocalSource(db: Db, mediaId: number, sourcePageUrl: string) {
  const insert = db.prepare(
    `INSERT INTO source (tweet_url, source_page_url, author_handle, tweet_id, collected_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const s = insert.run([null, sourcePageUrl, null, null, isoNow()]);
  const sourceId = Number(s.lastInsertRowid);
  db.prepare(`INSERT OR IGNORE INTO media_source (media_id, source_id) VALUES (?, ?)`).run([mediaId, sourceId]);
}

function isSubPath(root: string, target: string) {
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(target);
  const rootNorm = process.platform === 'win32' ? rootResolved.toLowerCase() : rootResolved;
  const targetNorm = process.platform === 'win32' ? targetResolved.toLowerCase() : targetResolved;
  if (rootNorm === targetNorm) return true;
  return targetNorm.startsWith(rootNorm + path.sep);
}
