import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { z } from 'zod';
import mime from 'mime-types';

import type { Db } from './db.js';
import type { FsLayout } from './fs-layout.js';
import { writePersistedDataLocation, type ServerConfig } from './config.js';
import { ingestItems } from './ingest.js';
import type { IngestProgressEvent } from './ingest.js';
import { ingestLocalFiles, scanLocalFiles } from './local-import.js';
import { hammingDistanceHex } from './phash.js';

type PendingUnlink = {
  path: string;
  attempts: number;
  nextTryAt: number;
  lastCode?: string;
  lastError?: string;
};

const pendingUnlinks = new Map<string, PendingUnlink>();
let pendingUnlinkTimer: NodeJS.Timeout | null = null;

function ensurePendingUnlinkPump() {
  if (pendingUnlinkTimer) return;
  pendingUnlinkTimer = setInterval(() => {
    if (!pendingUnlinks.size) return;
    const now = Date.now();
    for (const entry of pendingUnlinks.values()) {
      if (now < entry.nextTryAt) continue;
      try {
        if (fs.existsSync(entry.path)) fs.unlinkSync(entry.path);
        pendingUnlinks.delete(entry.path);
      } catch (err) {
        const code = getFsErrorCode(err);
        if (!isRetriableMoveErrorCode(code)) {
          pendingUnlinks.delete(entry.path);
          console.warn('[clipnest] pending unlink dropped', { path: entry.path, code });
          continue;
        }
        entry.attempts += 1;
        entry.lastCode = code;
        entry.lastError = err instanceof Error ? err.message : String(err);
        const delay = Math.min(60_000, 500 * entry.attempts * entry.attempts);
        entry.nextTryAt = now + delay;
      }
    }
  }, 1500);
  pendingUnlinkTimer.unref?.();
}

function enqueuePendingUnlink(filePath: string, err?: unknown) {
  if (!filePath) return;
  ensurePendingUnlinkPump();
  const existing = pendingUnlinks.get(filePath);
  if (existing) {
    existing.nextTryAt = Math.min(existing.nextTryAt, Date.now() + 1500);
    return;
  }
  const code = getFsErrorCode(err);
  pendingUnlinks.set(filePath, {
    path: filePath,
    attempts: 0,
    nextTryAt: Date.now() + 1500,
    lastCode: code || undefined,
    lastError: err instanceof Error ? err.message : err ? String(err) : undefined,
  });
}

const ingestSchema = z.object({
  items: z.array(
    z.object({
      sourcePageUrl: z.string().min(1),
      tweetUrl: z.string().optional(),
      authorHandle: z.string().optional(),
      mediaUrl: z.string().min(1),
      mediaType: z.enum(['image', 'video']),
      collectedAt: z.string().min(1),
      context: z.any().optional(),
    }),
  ),
});

const localImportSchema = z.object({
  path: z.string().min(1),
  recursive: z.boolean().optional(),
});

const settingsSchema = z.object({
  libraryRoot: z.string().optional().nullable(),
  archiveTemplate: z.string().optional().nullable(),
  trashRetentionDays: z.number().int().min(0).max(3650).optional().nullable(),
  trashAutoCleanupEnabled: z.boolean().optional().nullable(),
});

export function createRouter(opts: { db: Db; layout: FsLayout; cfg: ServerConfig }) {
  type ProgressEntry = { data: IngestProgressEvent & { ts: number }; ts: number };
  const progressCache = new Map<string, ProgressEntry>();
  const PROGRESS_CACHE_TTL_MS = 10 * 60 * 1000;
  const pruneProgressCache = () => {
    if (!progressCache.size) return;
    const now = Date.now();
    for (const [id, entry] of progressCache.entries()) {
      if (now - entry.ts > PROGRESS_CACHE_TTL_MS) {
        progressCache.delete(id);
      }
    }
  };
  const cacheProgress = (event: IngestProgressEvent) => {
    if (!event || typeof event.clientId !== 'string' || !event.clientId) return;
    const ts = Date.now();
    const data = { ...event, ts };
    progressCache.set(event.clientId, { data, ts });
    pruneProgressCache();
  };
  const readProgress = (ids?: string[]) => {
    pruneProgressCache();
    const items: Array<IngestProgressEvent & { ts: number }> = [];
    if (Array.isArray(ids) && ids.length) {
      for (const id of ids) {
        const entry = progressCache.get(id);
        if (entry) items.push(entry.data);
      }
      return items;
    }
    for (const entry of progressCache.values()) {
      items.push(entry.data);
    }
    return items;
  };

  const r = express.Router();

  scheduleStartupMaintenance(opts.db, opts.layout);

  r.get('/health', (_req, res) =>
    res.json({
      ok: true,
      dataDir: opts.layout.rootDir,
      unarchivedDir: opts.layout.mediaDir,
      trashDir: opts.layout.trashDir,
      libraryRoot: getSetting(opts.db, 'library_root'),
    }),
  );

  r.get('/settings', (_req, res) => {
    const libraryRoot = getSetting(opts.db, 'library_root');
    const archiveTemplate = getSetting(opts.db, 'archive_template');
    const trashRetentionDays = getNumberSetting(opts.db, 'trash_retention_days', 30);
    const trashAutoCleanupEnabled = getBooleanSetting(opts.db, 'trash_auto_cleanup_enabled', true);
    res.json({
      ok: true,
      libraryRoot: libraryRoot ?? null,
      archiveTemplate: archiveTemplate ?? null,
      trashRetentionDays,
      trashAutoCleanupEnabled,
    });
  });

  r.post('/settings', (req, res) => {
    const parsed = settingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }
    const payload = parsed.data;
    const hasLibraryRoot = Object.prototype.hasOwnProperty.call(payload, 'libraryRoot');
    const hasArchiveTemplate = Object.prototype.hasOwnProperty.call(payload, 'archiveTemplate');
    const hasTrashRetentionDays = Object.prototype.hasOwnProperty.call(payload, 'trashRetentionDays');
    const hasTrashAutoCleanupEnabled = Object.prototype.hasOwnProperty.call(payload, 'trashAutoCleanupEnabled');

    if (hasLibraryRoot) {
      const next = payload.libraryRoot ?? null;
      if (!next || !next.trim()) {
        clearSetting(opts.db, 'library_root');
      } else {
        try {
          const normalized = normalizeLibraryRoot(next);
          setSetting(opts.db, 'library_root', normalized);
          // Persist bootstrap immediately so future restarts can locate the chosen library root.
          writePersistedDataLocation({ libraryRoot: normalized });
        } catch (err) {
          return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    if (hasArchiveTemplate) {
      const next = payload.archiveTemplate ?? null;
      if (!next || !next.trim()) {
        clearSetting(opts.db, 'archive_template');
      } else {
        setSetting(opts.db, 'archive_template', next.trim());
      }
    }

    if (hasTrashRetentionDays) {
      const next = payload.trashRetentionDays;
      if (next == null) {
        clearSetting(opts.db, 'trash_retention_days');
      } else {
        setSetting(opts.db, 'trash_retention_days', String(Math.max(0, Math.min(3650, Number(next)))));
      }
    }

    if (hasTrashAutoCleanupEnabled) {
      const next = payload.trashAutoCleanupEnabled;
      if (next == null) {
        clearSetting(opts.db, 'trash_auto_cleanup_enabled');
      } else {
        setSetting(opts.db, 'trash_auto_cleanup_enabled', next ? '1' : '0');
      }
    }

    const libraryRoot = getSetting(opts.db, 'library_root');
    const archiveTemplate = getSetting(opts.db, 'archive_template');
    const trashRetentionDays = getNumberSetting(opts.db, 'trash_retention_days', 30);
    const trashAutoCleanupEnabled = getBooleanSetting(opts.db, 'trash_auto_cleanup_enabled', true);
    return res.json({
      ok: true,
      libraryRoot: libraryRoot ?? null,
      archiveTemplate: archiveTemplate ?? null,
      trashRetentionDays,
      trashAutoCleanupEnabled,
    });
  });

  r.get('/stats', (_req, res) => {
    const mediaCount = opts.db
      .prepare('SELECT COUNT(1) AS n FROM media WHERE deleted_at IS NULL')
      .get() as { n: number };
    const sourceCount = opts.db
      .prepare(
        `SELECT COUNT(1) AS n
         FROM source s
         WHERE EXISTS (
           SELECT 1 FROM media_source ms
           JOIN media m ON m.id = ms.media_id
           WHERE ms.source_id = s.id AND m.deleted_at IS NULL
         )`,
      )
      .get() as { n: number };
    res.json({ mediaCount: mediaCount.n, sourceCount: sourceCount.n });
  });

  r.post('/maintenance/trash/compact', (_req, res) => {
    const media = compactTrashDir(opts.db, opts.layout, 'media');
    const thumbs = compactTrashDir(opts.db, opts.layout, 'thumbs');
    res.json({ ok: true, media, thumbs });
  });

  r.post('/maintenance/trash/prune', (req, res) => {
    const rawDays = req.body?.days;
    const days =
      typeof rawDays === 'number' && Number.isFinite(rawDays)
        ? Math.max(0, Math.min(3650, Math.floor(rawDays)))
        : getNumberSetting(opts.db, 'trash_retention_days', 30);
    const result = pruneDeletedMedia(opts.db, opts.layout, { retentionDays: days });
    res.json({ ok: true, retentionDays: days, result });
  });

  r.post('/ingest', async (req, res) => {
    const parsed = ingestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }
    const out = await ingestItems({
      db: opts.db,
      layout: opts.layout,
      cfg: opts.cfg,
      items: parsed.data.items,
      onProgress: cacheProgress,
    });
    res.json({ ok: true, ...out });
  });

  r.post('/ingest/stream', async (req, res) => {
    const parsed = ingestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }

    res.status(200);
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    if (typeof (res as any).flushHeaders === 'function') {
      (res as any).flushHeaders();
    }

    let closed = false;
    req.on('close', () => {
      closed = true;
    });

    const send = (event: string, data: any) => {
      if (closed) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send('ready', { ok: true });

    try {
      const out = await ingestItems({
        db: opts.db,
        layout: opts.layout,
        cfg: opts.cfg,
        items: parsed.data.items,
        onProgress: (event) => {
          cacheProgress(event);
          send('progress', event);
        },
      });
      send('done', { ok: true, results: out.results });
    } catch (err) {
      send('error', { ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      res.end();
    }
  });

  r.post('/local/import', async (req, res) => {
    const parsed = localImportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }
    const rootPath = parsed.data.path;
    const recursive = parsed.data.recursive ?? true;
    if (!fs.existsSync(rootPath)) {
      return res.status(400).json({ ok: false, error: 'path not found' });
    }
    const files = scanLocalFiles(rootPath, recursive);
    const libraryRoot = getSetting(opts.db, 'library_root');
    const out = await ingestLocalFiles({
      db: opts.db,
      layout: opts.layout,
      cfg: opts.cfg,
      files,
      sourceRoot: rootPath,
      libraryRoot,
    });
    res.json({ ok: true, summary: out.summary });
  });

  r.get('/ingest/progress', (req, res) => {
    const raw =
      typeof req.query.clientIds === 'string'
        ? req.query.clientIds
        : typeof req.query.ids === 'string'
          ? req.query.ids
          : undefined;
    const ids = raw
      ? raw
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
      : Array.isArray(req.query.clientIds)
        ? req.query.clientIds.map((v) => String(v ?? '').trim()).filter(Boolean)
        : Array.isArray(req.query.ids)
          ? req.query.ids.map((v) => String(v ?? '').trim()).filter(Boolean)
          : [];
    const items = readProgress(ids.length ? ids : undefined);
    res.json({ ok: true, items });
  });

  r.post('/ingest/progress/clear', (req, res) => {
    const ids = Array.isArray(req.body?.clientIds)
      ? req.body.clientIds.map((v: any) => String(v ?? '').trim()).filter(Boolean)
      : [];
    for (const id of ids) {
      progressCache.delete(id);
    }
    res.json({ ok: true });
  });

  r.get('/media', (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 60)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    const type = (req.query.type as string | undefined) ?? undefined;
    const q = (req.query.q as string | undefined) ?? undefined;
    const authorHandle = (req.query.authorHandle as string | undefined) ?? undefined;
    const tag = (req.query.tag as string | undefined) ?? undefined;
    const tagPresence = (req.query.tagPresence as string | undefined) ?? undefined;
    const collection = (req.query.collection as string | undefined) ?? undefined;
    const from = (req.query.from as string | undefined) ?? undefined;
    const to = (req.query.to as string | undefined) ?? undefined;
    const archived = (req.query.archived as string | undefined) ?? undefined;
    const deleted = (req.query.deleted as string | undefined) ?? undefined;
    const favorite = (req.query.favorite as string | undefined) ?? undefined;

    const where: string[] = [];
    const params: any[] = [];

    if (type === 'image' || type === 'video') {
      where.push('m.type = ?');
      params.push(type);
    }

    if (authorHandle && authorHandle.trim()) {
      where.push(
        `EXISTS (
          SELECT 1 FROM source s
          JOIN media_source ms ON ms.source_id = s.id
          WHERE ms.media_id = m.id AND s.author_handle = ?
        )`,
      );
      params.push(authorHandle.trim());
    }

    if (tag && tag.trim()) {
      where.push(
        `EXISTS (
          SELECT 1 FROM tag t
          JOIN media_tag mt ON mt.tag_id = t.id
          WHERE mt.media_id = m.id AND t.name = ?
        )`,
      );
      params.push(tag.trim());
    }

    if (tagPresence === 'tagged') {
      where.push(
        `EXISTS (
          SELECT 1 FROM media_tag mt
          WHERE mt.media_id = m.id
        )`,
      );
    }
    if (tagPresence === 'untagged') {
      where.push(
        `NOT EXISTS (
          SELECT 1 FROM media_tag mt
          WHERE mt.media_id = m.id
        )`,
      );
    }

    if (collection && collection.trim()) {
      where.push(
        `EXISTS (
          SELECT 1 FROM collection c
          JOIN media_collection mc ON mc.collection_id = c.id
          WHERE mc.media_id = m.id AND c.name = ?
        )`,
      );
      params.push(collection.trim());
    }

    if (from && from.trim()) {
      where.push('date(m.saved_at) >= date(?)');
      params.push(from.trim());
    }
    if (to && to.trim()) {
      where.push('date(m.saved_at) <= date(?)');
      params.push(to.trim());
    }

    if (archived === 'yes') {
      where.push(`m.archived_at IS NOT NULL`);
    } else if (archived === 'no') {
      where.push(`m.archived_at IS NULL`);
    }

    if (deleted === 'yes') {
      where.push(`m.deleted_at IS NOT NULL`);
    } else if (deleted === 'no' || !deleted) {
      where.push(`m.deleted_at IS NULL`);
    }

    if (favorite === '1' || favorite === 'true' || favorite === 'yes') {
      where.push(`m.is_favorite = 1`);
    }

    if (q && q.trim()) {
      where.push(
        `(m.original_url LIKE ?
          OR EXISTS (
            SELECT 1 FROM source s
            JOIN media_source ms ON ms.source_id = s.id
            WHERE ms.media_id = m.id AND (s.tweet_url LIKE ? OR s.source_page_url LIKE ? OR s.author_handle LIKE ?)
          )
          OR EXISTS (
            SELECT 1 FROM tag t
            JOIN media_tag mt ON mt.tag_id = t.id
            WHERE mt.media_id = m.id AND t.name LIKE ?
          )
          OR EXISTS (
            SELECT 1 FROM collection c
            JOIN media_collection mc ON mc.collection_id = c.id
            WHERE mc.media_id = m.id AND c.name LIKE ?
          )
        )`,
      );
      const like = `%${q.trim()}%`;
      params.push(like, like, like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    let totalCount = (
      opts.db
      .prepare(`SELECT COUNT(1) AS n FROM media m ${whereSql}`)
      .get(params) as { n: number }
    ).n;

    const rows = opts.db
      .prepare(
        `SELECT m.*
         FROM media m
         ${whereSql}
         ORDER BY m.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all([...params, limit, offset]) as any[];

    const visibleRows = rows.filter((row) => !markMediaDeletedIfMissing(opts.db, row));
    if (visibleRows.length !== rows.length) {
      totalCount = (
        opts.db
          .prepare(`SELECT COUNT(1) AS n FROM media m ${whereSql}`)
          .get(params) as { n: number }
      ).n;
    }
    const items = visibleRows.map((m) => mapMediaRow(opts.db, m));

    const nextOffset = rows.length < limit ? 0 : offset + rows.length;
    res.json({ ok: true, items, nextOffset, totalCount });
  });

  r.get('/media/days', (req, res) => {
    const limit = Math.min(120, Math.max(1, Number(req.query.limit ?? 30)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    const type = (req.query.type as string | undefined) ?? undefined;
    const q = (req.query.q as string | undefined) ?? undefined;
    const authorHandle = (req.query.authorHandle as string | undefined) ?? undefined;
    const tag = (req.query.tag as string | undefined) ?? undefined;
    const tagPresence = (req.query.tagPresence as string | undefined) ?? undefined;
    const collection = (req.query.collection as string | undefined) ?? undefined;
    const from = (req.query.from as string | undefined) ?? undefined;
    const to = (req.query.to as string | undefined) ?? undefined;
    const archived = (req.query.archived as string | undefined) ?? undefined;
    const deleted = (req.query.deleted as string | undefined) ?? undefined;
    const favorite = (req.query.favorite as string | undefined) ?? undefined;

    const where: string[] = [];
    const params: any[] = [];

    if (type === 'image' || type === 'video') {
      where.push('m.type = ?');
      params.push(type);
    }

    if (authorHandle && authorHandle.trim()) {
      where.push(
        `EXISTS (
          SELECT 1 FROM source s
          JOIN media_source ms ON ms.source_id = s.id
          WHERE ms.media_id = m.id AND s.author_handle = ?
        )`,
      );
      params.push(authorHandle.trim());
    }

    if (tag && tag.trim()) {
      where.push(
        `EXISTS (
          SELECT 1 FROM tag t
          JOIN media_tag mt ON mt.tag_id = t.id
          WHERE mt.media_id = m.id AND t.name = ?
        )`,
      );
      params.push(tag.trim());
    }

    if (tagPresence === 'tagged') {
      where.push(
        `EXISTS (
          SELECT 1 FROM media_tag mt
          WHERE mt.media_id = m.id
        )`,
      );
    }
    if (tagPresence === 'untagged') {
      where.push(
        `NOT EXISTS (
          SELECT 1 FROM media_tag mt
          WHERE mt.media_id = m.id
        )`,
      );
    }

    if (collection && collection.trim()) {
      where.push(
        `EXISTS (
          SELECT 1 FROM collection c
          JOIN media_collection mc ON mc.collection_id = c.id
          WHERE mc.media_id = m.id AND c.name = ?
        )`,
      );
      params.push(collection.trim());
    }

    if (from && from.trim()) {
      where.push('date(m.saved_at) >= date(?)');
      params.push(from.trim());
    }
    if (to && to.trim()) {
      where.push('date(m.saved_at) <= date(?)');
      params.push(to.trim());
    }

    if (archived === 'yes') {
      where.push(`m.archived_at IS NOT NULL`);
    } else if (archived === 'no') {
      where.push(`m.archived_at IS NULL`);
    }

    if (deleted === 'yes') {
      where.push(`m.deleted_at IS NOT NULL`);
    } else if (deleted === 'no' || !deleted) {
      where.push(`m.deleted_at IS NULL`);
    }

    if (favorite === '1' || favorite === 'true' || favorite === 'yes') {
      where.push(`m.is_favorite = 1`);
    }

    if (q && q.trim()) {
      where.push(
        `(m.original_url LIKE ?
          OR EXISTS (
            SELECT 1 FROM source s
            JOIN media_source ms ON ms.source_id = s.id
            WHERE ms.media_id = m.id AND (s.tweet_url LIKE ? OR s.source_page_url LIKE ? OR s.author_handle LIKE ?)
          )
          OR EXISTS (
            SELECT 1 FROM tag t
            JOIN media_tag mt ON mt.tag_id = t.id
            WHERE mt.media_id = m.id AND t.name LIKE ?
          )
          OR EXISTS (
            SELECT 1 FROM collection c
            JOIN media_collection mc ON mc.collection_id = c.id
            WHERE mc.media_id = m.id AND c.name LIKE ?
          )
        )`,
      );
      const like = `%${q.trim()}%`;
      params.push(like, like, like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = opts.db
      .prepare(
        `SELECT COUNT(1) AS n
         FROM (
           SELECT date(m.saved_at) as day
           FROM media m
           ${whereSql}
           GROUP BY date(m.saved_at)
         )`,
      )
      .get(params) as { n: number };

    const rows = opts.db
      .prepare(
        `SELECT date(m.saved_at) as day, COUNT(1) as count
         FROM media m
         ${whereSql}
         GROUP BY date(m.saved_at)
         ORDER BY date(m.saved_at) DESC
         LIMIT ? OFFSET ?`,
      )
      .all([...params, limit, offset]) as any[];

    res.json({ ok: true, items: rows.map((row) => ({ day: row.day, count: row.count })), totalCount: totalRow.n });
  });

  r.get('/media/:id/similar', (req, res) => {
    const mediaId = Number(req.params.id);
    const limitRaw = Number(req.query.limit ?? 18);
    const distanceRaw = Number(req.query.distance ?? 12);
    const candidatesRaw = Number(req.query.candidates ?? 1200);
    const limit = Math.min(48, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 18));
    const maxDistance = Math.min(40, Math.max(1, Number.isFinite(distanceRaw) ? distanceRaw : 12));
    const candidateLimit = Math.min(
      5000,
      Math.max(limit * 20, Number.isFinite(candidatesRaw) ? candidatesRaw : 1200),
    );

    const base = opts.db.prepare('SELECT id, phash FROM media WHERE id = ? AND deleted_at IS NULL').get([mediaId]) as
      | { id: number; phash: string | null }
      | undefined;
    if (!base?.phash) return res.json({ ok: true, items: [] });

    const candidates = opts.db
      .prepare(
        'SELECT id, phash FROM media WHERE phash IS NOT NULL AND deleted_at IS NULL AND id != ? ORDER BY id DESC LIMIT ?',
      )
      .all([mediaId, candidateLimit]) as Array<{ id: number; phash: string }>;

    const matches = candidates
      .map((row) => ({
        id: row.id,
        distance: hammingDistanceHex(base.phash as string, row.phash),
      }))
      .filter((row) => row.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance || b.id - a.id)
      .slice(0, limit);

    const ids = matches.map((m) => m.id);
    const items = getMediaItemsByIds(opts.db, ids);
    res.json({ ok: true, items });
  });

  r.get('/media/:id/file', (req, res) => {
    const id = Number(req.params.id);
    const row = opts.db.prepare('SELECT local_path, deleted_at FROM media WHERE id = ?').get([id]) as
      | { local_path: string; deleted_at: string | null }
      | undefined;
    if (!row) return res.status(404).end();
    if (!fs.existsSync(row.local_path)) {
      if (!row.deleted_at) {
        markMediaDeletedIfMissing(opts.db, {
          id,
          local_path: row.local_path,
          deleted_at: row.deleted_at,
        });
      }
      return res.status(404).end();
    }

    const ct = mime.lookup(row.local_path) || 'application/octet-stream';
    const stat = fs.statSync(row.local_path);
    const size = stat.size;
    const range = req.headers.range;
    res.setHeader('content-type', ct);
    res.setHeader('accept-ranges', 'bytes');

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        res.setHeader('content-range', `bytes */${size}`);
        return res.status(416).end();
      }
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : size - 1;
      const safeStart = Number.isFinite(start) ? start : 0;
      const safeEnd = Number.isFinite(end) ? end : size - 1;

      if (safeStart >= size || safeStart > safeEnd) {
        res.setHeader('content-range', `bytes */${size}`);
        return res.status(416).end();
      }

      res.status(206);
      res.setHeader('content-range', `bytes ${safeStart}-${safeEnd}/${size}`);
      res.setHeader('content-length', String(safeEnd - safeStart + 1));
      return fs.createReadStream(row.local_path, { start: safeStart, end: safeEnd }).pipe(res);
    }

    res.setHeader('content-length', String(size));
    fs.createReadStream(row.local_path).pipe(res);
  });

  r.get('/media/:id/thumb', (req, res) => {
    const id = Number(req.params.id);
    const row = opts.db.prepare('SELECT thumb_path, local_path, type FROM media WHERE id = ?').get([id]) as
      | { thumb_path: string | null; local_path: string; type: string }
      | undefined;
    if (!row) return res.status(404).end();

    const thumbPath = row.thumb_path && fs.existsSync(row.thumb_path) ? row.thumb_path : null;
    const fallbackImagePath =
      row.type === 'image' && row.local_path && fs.existsSync(row.local_path) ? row.local_path : null;
    const targetPath = thumbPath ?? fallbackImagePath;
    if (!targetPath) return res.status(404).end();

    const ct = mime.lookup(targetPath) || 'image/webp';
    res.setHeader('content-type', ct);
    fs.createReadStream(targetPath).pipe(res);
  });

  r.get('/tags', (_req, res) => {
    const limit = Math.min(100, Math.max(1, Number(_req.query.limit ?? 50)));
    const popular = String(_req.query.popular ?? '') === '1' || String(_req.query.popular ?? '') === 'true';
    const includeAuto =
      String(_req.query.includeAuto ?? '') === '1' || String(_req.query.includeAuto ?? '') === 'true';
    const order = popular ? 'usage DESC, t.name ASC' : 't.name ASC';
    const whereSql = includeAuto ? '' : `WHERE (t.source = 'manual' OR t.source IS NULL OR t.source = '')`;
    const rows = opts.db
      .prepare(
        `SELECT t.id as id, t.name as name, COUNT(mt.media_id) as usage
         FROM tag t
         LEFT JOIN media_tag mt ON mt.tag_id = t.id
         ${whereSql}
         GROUP BY t.id
         ORDER BY ${order}
         LIMIT ?`,
      )
      .all([limit]) as any[];
    res.json({ ok: true, items: rows });
  });

  r.post('/tags', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });
    opts.db.prepare("INSERT OR IGNORE INTO tag (name, source) VALUES (?, 'manual')").run([name]);
    opts.db.prepare("UPDATE tag SET source = 'manual' WHERE name = ? AND source != 'manual'").run([name]);
    const row = opts.db.prepare('SELECT id, name FROM tag WHERE name = ?').get([name]) as any;
    res.json({ ok: true, item: row });
  });

  r.post('/media/:id/tag', (req, res) => {
    const mediaId = Number(req.params.id);
    const tagName = String(req.body?.name ?? '').trim();
    if (!tagName) return res.status(400).json({ ok: false, error: 'name required' });
    opts.db.prepare("INSERT OR IGNORE INTO tag (name, source) VALUES (?, 'manual')").run([tagName]);
    opts.db.prepare("UPDATE tag SET source = 'manual' WHERE name = ? AND source != 'manual'").run([tagName]);
    const tag = opts.db.prepare('SELECT id FROM tag WHERE name = ?').get([tagName]) as { id: number };
    opts.db.prepare('INSERT OR IGNORE INTO media_tag (media_id, tag_id) VALUES (?, ?)').run([mediaId, tag.id]);
    res.json({ ok: true });
  });

  r.post('/media/:id/untag', (req, res) => {
    const mediaId = Number(req.params.id);
    const tagName = String(req.body?.name ?? '').trim();
    if (!tagName) return res.status(400).json({ ok: false, error: 'name required' });
    const tag = opts.db.prepare('SELECT id FROM tag WHERE name = ?').get([tagName]) as { id: number } | undefined;
    if (!tag) return res.json({ ok: true });
    opts.db.prepare('DELETE FROM media_tag WHERE media_id = ? AND tag_id = ?').run([mediaId, tag.id]);
    res.json({ ok: true });
  });

  r.get('/collections', (_req, res) => {
    const rows = opts.db.prepare('SELECT id, name FROM collection ORDER BY name ASC').all() as any[];
    res.json({ ok: true, items: rows });
  });

  r.post('/collections', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });
    opts.db.prepare('INSERT OR IGNORE INTO collection (name) VALUES (?)').run([name]);
    const row = opts.db.prepare('SELECT id, name FROM collection WHERE name = ?').get([name]) as any;
    res.json({ ok: true, item: row });
  });

  r.post('/media/:id/collect', (req, res) => {
    const mediaId = Number(req.params.id);
    const collectionName = String(req.body?.name ?? '').trim();
    if (!collectionName) return res.status(400).json({ ok: false, error: 'name required' });
    const libraryRoot = getSetting(opts.db, 'library_root');
    if (!libraryRoot) {
      return res.status(400).json({ ok: false, error: 'libraryRoot not set' });
    }
    opts.db.prepare('INSERT OR IGNORE INTO collection (name) VALUES (?)').run([collectionName]);
    const col = opts.db.prepare('SELECT id FROM collection WHERE name = ?').get([collectionName]) as { id: number };
    opts.db
      .prepare('INSERT OR IGNORE INTO media_collection (media_id, collection_id) VALUES (?, ?)')
      .run([mediaId, col.id]);
    try {
      archiveMediaToCollection(opts.db, mediaId, collectionName, libraryRoot);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    res.json({ ok: true });
  });

  r.post('/media/:id/unarchive', (req, res) => {
    const mediaId = Number(req.params.id);
    try {
      unarchiveMedia(opts.db, mediaId);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    res.json({ ok: true });
  });

  r.post('/media/:id/delete', (req, res) => {
    const mediaId = Number(req.params.id);
    try {
      deleteMedia(opts.db, opts.layout, mediaId);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    res.json({ ok: true });
  });

  r.post('/media/:id/undelete', (req, res) => {
    const mediaId = Number(req.params.id);
    try {
      undeleteMedia(opts.db, mediaId);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    res.json({ ok: true });
  });

  r.post('/media/:id/purge', (req, res) => {
    const mediaId = Number(req.params.id);
    try {
      const result = purgeMedia(opts.db, mediaId);
      res.json({ ok: true, result });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  r.post('/media/:id/uncollect', (req, res) => {
    const mediaId = Number(req.params.id);
    const collectionName = String(req.body?.name ?? '').trim();
    if (!collectionName) return res.status(400).json({ ok: false, error: 'name required' });
    const col = opts.db.prepare('SELECT id FROM collection WHERE name = ?').get([collectionName]) as
      | { id: number }
      | undefined;
    if (!col) return res.json({ ok: true });
    opts.db.prepare('DELETE FROM media_collection WHERE media_id = ? AND collection_id = ?').run([mediaId, col.id]);
    res.json({ ok: true });
  });

  r.post('/media/:id/favorite', (req, res) => {
    const mediaId = Number(req.params.id);
    opts.db.prepare('UPDATE media SET is_favorite = 1 WHERE id = ?').run([mediaId]);
    res.json({ ok: true });
  });

  r.post('/media/:id/unfavorite', (req, res) => {
    const mediaId = Number(req.params.id);
    opts.db.prepare('UPDATE media SET is_favorite = 0 WHERE id = ?').run([mediaId]);
    res.json({ ok: true });
  });

  r.post('/media/:id/rate', (req, res) => {
    const mediaId = Number(req.params.id);
    const rating = Number(req.body?.rating ?? 0);
    if (!Number.isFinite(rating) || rating < 0 || rating > 3) {
      return res.status(400).json({ ok: false, error: 'rating must be 0-3' });
    }
    opts.db.prepare('UPDATE media SET rating = ? WHERE id = ?').run([Math.floor(rating), mediaId]);
    res.json({ ok: true });
  });

  return r;
}

function getSourcesForMedia(db: Db, mediaId: number) {
  const rows = db
    .prepare(
      `SELECT s.tweet_url as tweetUrl, s.source_page_url as sourcePageUrl, s.author_handle as authorHandle, s.collected_at as collectedAt
       FROM source s
       JOIN media_source ms ON ms.source_id = s.id
       WHERE ms.media_id = ?
       ORDER BY s.id DESC
       LIMIT 10`,
    )
    .all([mediaId]) as any[];
  return rows;
}

function getTagsForMedia(db: Db, mediaId: number): string[] {
  const rows = db
    .prepare(
      `SELECT t.name as name
       FROM tag t
       JOIN media_tag mt ON mt.tag_id = t.id
       WHERE mt.media_id = ?
       ORDER BY t.name ASC`,
    )
    .all([mediaId]) as any[];
  return rows.map((r) => String(r.name));
}

function getCollectionsForMedia(db: Db, mediaId: number): string[] {
  const rows = db
    .prepare(
      `SELECT c.name as name
       FROM collection c
       JOIN media_collection mc ON mc.collection_id = c.id
       WHERE mc.media_id = ?
       ORDER BY c.name ASC`,
    )
    .all([mediaId]) as any[];
  return rows.map((r) => String(r.name));
}

function mapMediaRow(db: Db, m: any) {
  return {
    id: m.id,
    sha256: m.sha256,
    type: m.type,
    originalUrl: m.original_url,
    width: m.width,
    height: m.height,
    savedAt: m.saved_at,
    origin: m.origin ?? 'x',
    archivedAt: m.archived_at ?? null,
    deletedAt: m.deleted_at ?? null,
    favorite: Boolean(m.is_favorite),
    rating: Number.isFinite(m.rating) ? Number(m.rating) : 0,
    fileUrl: `/api/media/${m.id}/file`,
    thumbUrl: m.thumb_path ? `/api/media/${m.id}/thumb` : null,
    sources: getSourcesForMedia(db, m.id),
    tags: getTagsForMedia(db, m.id),
    collections: getCollectionsForMedia(db, m.id),
  };
}

function getMediaItemsByIds(db: Db, ids: number[]) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT * FROM media WHERE id IN (${placeholders}) AND deleted_at IS NULL`)
    .all(ids) as any[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids
    .map((id) => {
      const row = byId.get(id);
      return row ? mapMediaRow(db, row) : null;
    })
    .filter((item): item is ReturnType<typeof mapMediaRow> => Boolean(item));
}

function isoNow() {
  return new Date().toISOString();
}

function getSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get([key]) as { value: string } | undefined;
  return row?.value ?? null;
}

function getBooleanSetting(db: Db, key: string, fallback: boolean) {
  const value = getSetting(db, key);
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

function getNumberSetting(db: Db, key: string, fallback: number) {
  const value = getSetting(db, key);
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function setSetting(db: Db, key: string, value: string) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run([
    key,
    value,
  ]);
}

function clearSetting(db: Db, key: string) {
  db.prepare('DELETE FROM settings WHERE key = ?').run([key]);
}

function normalizeLibraryRoot(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('libraryRoot required');
  const resolved = path.resolve(trimmed);
  if (fs.existsSync(resolved)) {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) throw new Error('libraryRoot is not a directory');
  } else {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

function archiveMediaToCollection(db: Db, mediaId: number, collectionName: string, libraryRoot: string | null) {
  const row = db
    .prepare('SELECT local_path, origin, original_url, saved_at, type FROM media WHERE id = ?')
    .get([mediaId]) as
    | { local_path: string; origin: string; original_url: string; saved_at: string; type: string }
    | undefined;
  if (!row) return;
  if (!libraryRoot) throw new Error('libraryRoot not set');

  const { dirPath } = resolveCollectionPath(libraryRoot, collectionName);
  fs.mkdirSync(dirPath, { recursive: true });

  const tags = getTagsForMedia(db, mediaId);
  const authorHandle = getPrimaryAuthorHandle(db, mediaId);
  const ext = path.extname(row.local_path) || '.jpg';
  const archiveTemplate = getSetting(db, 'archive_template');
  const baseName = buildArchiveBaseName({
    mediaId,
    savedAt: row.saved_at,
    authorHandle,
    tags,
    collectionName,
    type: row.type,
    template: archiveTemplate,
  });
  const nextPath = ensureUniquePath(dirPath, baseName, ext);
  const currentResolved = path.resolve(row.local_path);
  const nextResolved = path.resolve(nextPath);

  if (currentResolved !== nextResolved) {
    moveFileSync(row.local_path, nextPath);
  }

  const archivedAt = isoNow();
  const archivedFromPath = row.local_path;
  const archivedFromUrl = row.origin === 'local' ? row.original_url : null;
  if (row.origin === 'local') {
    const originalUrl = pathToFileURL(nextPath).toString();
    db.prepare(
      'UPDATE media SET local_path = ?, original_url = ?, archived_at = ?, archived_from_path = ?, archived_from_url = ? WHERE id = ?',
    ).run([nextPath, originalUrl, archivedAt, archivedFromPath, archivedFromUrl, mediaId]);
  } else {
    db.prepare('UPDATE media SET local_path = ?, archived_at = ?, archived_from_path = ? WHERE id = ?').run([
      nextPath,
      archivedAt,
      archivedFromPath,
      mediaId,
    ]);
  }
}

function unarchiveMedia(db: Db, mediaId: number) {
  const row = db
    .prepare('SELECT local_path, origin, original_url, archived_from_path, archived_from_url FROM media WHERE id = ?')
    .get([mediaId]) as
    | { local_path: string; origin: string; original_url: string; archived_from_path: string | null; archived_from_url: string | null }
    | undefined;
  if (!row) return;
  if (!row.archived_from_path) throw new Error('no archive history');

  let targetPath = row.archived_from_path;
  if (fs.existsSync(targetPath)) {
    const ext = path.extname(targetPath) || path.extname(row.local_path) || '.jpg';
    const baseName = path.basename(targetPath, ext) || `media-${mediaId}`;
    targetPath = ensureUniquePath(path.dirname(targetPath), baseName, ext);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  moveFileSync(row.local_path, targetPath);

  if (row.origin === 'local') {
    const nextOriginalUrl = pathToFileURL(targetPath).toString();
    db.prepare(
      'UPDATE media SET local_path = ?, original_url = ?, archived_at = NULL, archived_from_path = NULL, archived_from_url = NULL WHERE id = ?',
    ).run([targetPath, nextOriginalUrl, mediaId]);
  } else {
    db.prepare(
      'UPDATE media SET local_path = ?, archived_at = NULL, archived_from_path = NULL, archived_from_url = NULL WHERE id = ?',
    ).run([targetPath, mediaId]);
  }
}

function markMediaDeletedIfMissing(
  db: Db,
  row: { id: number; local_path: string; deleted_at?: string | null; thumb_path?: string | null },
): boolean {
  if (row.deleted_at) return false;
  if (fs.existsSync(row.local_path)) return false;
  const deletedAt = isoNow();
  db.prepare(
    `UPDATE media
     SET deleted_at = ?,
         deleted_from_path = COALESCE(deleted_from_path, local_path),
         deleted_from_url = CASE
           WHEN origin = 'local' THEN COALESCE(deleted_from_url, original_url)
           ELSE deleted_from_url
         END,
         deleted_thumb_from_path = COALESCE(deleted_thumb_from_path, thumb_path)
     WHERE id = ? AND deleted_at IS NULL`,
  ).run([deletedAt, row.id]);
  return true;
}

function pathsEqual(a: string, b: string) {
  const ar = path.resolve(a);
  const br = path.resolve(b);
  if (process.platform === 'win32') return ar.toLowerCase() === br.toLowerCase();
  return ar === br;
}

function normalizePathKey(p: string) {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function buildStableTrashPath(dirPath: string, sha256: string, originalPath: string, fallbackExt?: string) {
  const ext = path.extname(originalPath) || fallbackExt || '.bin';
  return path.join(dirPath, `${sha256}${ext}`);
}

type TryMoveToTrashOutcome =
  | { ok: true; outcome: 'moved' | 'already_present' | 'copied'; destPath: string }
  | { ok: true; outcome: 'locked' | 'missing'; destPath: string; code?: string }
  | { ok: false; outcome: 'failed'; destPath: string; code?: string; error: unknown };

function tryMoveToTrashSync(srcPath: string, destPathInput: string): TryMoveToTrashOutcome {
  if (!srcPath) return { ok: true, outcome: 'missing', destPath: destPathInput };
  if (!fs.existsSync(srcPath)) return { ok: true, outcome: 'missing', destPath: destPathInput };

  let destPath = destPathInput;
  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
  } catch {
    // ignore
  }

  if (fs.existsSync(destPath)) {
    // If the target already exists (e.g. from a previous attempt), avoid creating duplicates.
    if (canReuseExistingRestoreTarget(srcPath, destPath)) {
      deleteFileBestEffortSync(srcPath);
      return { ok: true, outcome: 'already_present', destPath };
    }

    // Extremely rare: same sha256 but different content. Do not overwrite; fall back to a unique name.
    const ext = path.extname(destPath) || '.bin';
    const base = path.basename(destPath, ext) || 'media';
    destPath = ensureUniquePath(path.dirname(destPath), base, ext);
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.renameSync(srcPath, destPath);
      return { ok: true, outcome: 'moved', destPath };
    } catch (err) {
      const code = getFsErrorCode(err);
      if (code === 'EXDEV') break;
      if (!isRetriableMoveErrorCode(code)) {
        return { ok: false, outcome: 'failed', destPath, code, error: err };
      }
      if (attempt === 5) {
        return { ok: true, outcome: 'locked', destPath, code };
      }
      sleepSync(120 + attempt * 60);
    }
  }

  // Cross-device move: best-effort copy into trash, then best-effort delete original (may be delayed).
  try {
    if (!fs.existsSync(destPath)) fs.copyFileSync(srcPath, destPath);
  } catch (err) {
    const code = getFsErrorCode(err);
    if (isRetriableMoveErrorCode(code)) return { ok: true, outcome: 'locked', destPath, code };
    return { ok: false, outcome: 'failed', destPath, code, error: err };
  }
  deleteFileBestEffortSync(srcPath);
  return { ok: true, outcome: 'copied', destPath };
}

type TrashFile = {
  fullPath: string;
  name: string;
  sha: string;
  ext: string;
  size: number;
  mtimeMs: number;
};

type TrashCompactResult = {
  dir: string;
  kind: 'media' | 'thumbs';
  scannedFiles: number;
  shaGroups: number;
  movedIntoTrash: number;
  dbPathUpdates: number;
  deletedDuplicates: number;
  keptOrphans: number;
  lockedOrBusy: number;
  errors: number;
};

function isUnderDir(filePath: string, dirPath: string) {
  const fileNorm = normalizePathKey(filePath);
  const dirNorm = normalizePathKey(dirPath);
  if (fileNorm === dirNorm) return true;
  return fileNorm.startsWith(dirNorm + path.sep);
}

function extractShaFromName(fileName: string): string | null {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  const m = /^([a-f0-9]{64})/i.exec(base);
  if (!m) return null;
  return m[1].toLowerCase();
}

function scanTrashDir(dirPath: string) {
  const files: TrashFile[] = [];
  let scannedFiles = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return { files, scannedFiles, shaGroups: new Map<string, TrashFile[]>() };
  }

  for (const ent of entries) {
    if (!ent.isFile()) continue;
    scannedFiles += 1;
    const name = ent.name;
    const sha = extractShaFromName(name);
    if (!sha) continue;
    const fullPath = path.join(dirPath, name);
    let size = 0;
    let mtimeMs = 0;
    try {
      const stat = fs.statSync(fullPath);
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      size = 0;
      mtimeMs = 0;
    }
    files.push({
      fullPath,
      name,
      sha,
      ext: path.extname(name) || '',
      size,
      mtimeMs,
    });
  }

  const bySha = new Map<string, TrashFile[]>();
  for (const f of files) {
    const arr = bySha.get(f.sha) ?? [];
    arr.push(f);
    bySha.set(f.sha, arr);
  }
  return { files, scannedFiles, shaGroups: bySha };
}

function pickBestTrashFile(files: TrashFile[]): TrashFile {
  const sorted = [...files].sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.name.localeCompare(b.name);
  });
  return sorted[0] ?? files[0]!;
}

function scheduleStartupMaintenance(db: Db, layout: FsLayout) {
  const runMaintenance = () => {
    try {
      const media = compactTrashDir(db, layout, 'media');
      const thumbs = compactTrashDir(db, layout, 'thumbs');
      const changed =
        media.movedIntoTrash +
          media.dbPathUpdates +
          media.deletedDuplicates +
          thumbs.movedIntoTrash +
          thumbs.dbPathUpdates +
          thumbs.deletedDuplicates >
        0;
      if (changed) {
        console.info('[clipnest] startup trash compact', {
          media,
          thumbs,
        });
      }
      if (getBooleanSetting(db, 'trash_auto_cleanup_enabled', true)) {
        const retentionDays = Math.max(0, getNumberSetting(db, 'trash_retention_days', 30));
        const pruned = pruneDeletedMedia(db, layout, { retentionDays });
        if (pruned.deletedRows || pruned.deletedFiles || pruned.queuedDeletes) {
          console.info('[clipnest] trash prune', {
            retentionDays,
            ...pruned,
          });
        }
      }
    } catch (err) {
      console.warn('[clipnest] startup trash compact failed', err instanceof Error ? err.message : String(err));
    }
  };

  const timer = setTimeout(runMaintenance, 1200);
  timer.unref?.();

  const interval = setInterval(runMaintenance, 6 * 60 * 60 * 1000);
  interval.unref?.();
}

function compactTrashDir(db: Db, layout: FsLayout, kind: 'media' | 'thumbs'): TrashCompactResult {
  const dirPath = kind === 'media' ? layout.trashMediaDir : layout.trashThumbsDir;
  const resolvedDir = path.resolve(dirPath);
  const out: TrashCompactResult = {
    dir: resolvedDir,
    kind,
    scannedFiles: 0,
    shaGroups: 0,
    movedIntoTrash: 0,
    dbPathUpdates: 0,
    deletedDuplicates: 0,
    keptOrphans: 0,
    lockedOrBusy: 0,
    errors: 0,
  };

  // Step 1: For deleted items whose file is still outside trash (common on Windows when previewing),
  // best-effort move/copy them into trash and update DB paths. This prevents "ghost files" and reduces duplicates.
  const deletedRows = db
    .prepare('SELECT id, sha256, origin, original_url, local_path, thumb_path FROM media WHERE deleted_at IS NOT NULL')
    .all() as Array<{
    id: number;
    sha256: string;
    origin: string;
    original_url: string;
    local_path: string;
    thumb_path: string | null;
  }>;

  for (const row of deletedRows) {
    const current = kind === 'media' ? row.local_path : row.thumb_path;
    if (!current) continue;
    if (isUnderDir(current, resolvedDir)) continue;
    if (!fs.existsSync(current)) continue;

    const stableDest =
      kind === 'media'
        ? buildStableTrashPath(resolvedDir, row.sha256, current)
        : buildStableTrashPath(resolvedDir, row.sha256, current, '.webp');
    const mv = tryMoveToTrashSync(current, stableDest);
    if (mv.ok && (mv.outcome === 'moved' || mv.outcome === 'already_present' || mv.outcome === 'copied')) {
      out.movedIntoTrash += 1;
      if (kind === 'media') {
        if (row.origin === 'local') {
          const nextUrl = pathToFileURL(mv.destPath).toString();
          db.prepare('UPDATE media SET local_path = ?, original_url = ? WHERE id = ?').run([mv.destPath, nextUrl, row.id]);
        } else {
          db.prepare('UPDATE media SET local_path = ? WHERE id = ?').run([mv.destPath, row.id]);
        }
      } else {
        db.prepare('UPDATE media SET thumb_path = ? WHERE id = ?').run([mv.destPath, row.id]);
      }
      out.dbPathUpdates += 1;
    } else if (mv.ok && mv.outcome === 'locked') {
      out.lockedOrBusy += 1;
    } else if (!mv.ok) {
      out.errors += 1;
    }
  }

  // Step 2: scan trash directory (after potential moves) and fix DB pointers if they reference missing/truncated files.
  const scan = scanTrashDir(resolvedDir);
  out.scannedFiles = scan.scannedFiles;
  out.shaGroups = scan.shaGroups.size;

  for (const row of deletedRows) {
    const current = kind === 'media' ? row.local_path : row.thumb_path;
    if (!current) continue;
    const group = scan.shaGroups.get(row.sha256);
    if (!group || !group.length) continue;

    const best = pickBestTrashFile(group);
    const currentUnder = isUnderDir(current, resolvedDir);
    const currentExists = currentUnder ? fs.existsSync(current) : false;

    // If DB references a missing trash file (or a smaller one than the best available), repoint it to the best file.
    let shouldRepoint = false;
    if (currentUnder && !currentExists) shouldRepoint = true;
    if (currentUnder && currentExists) {
      try {
        const stat = fs.statSync(current);
        if (best.size > stat.size) shouldRepoint = true;
      } catch {
        shouldRepoint = true;
      }
    }

    if (shouldRepoint) {
      if (kind === 'media') {
        if (row.origin === 'local') {
          const nextUrl = pathToFileURL(best.fullPath).toString();
          db.prepare('UPDATE media SET local_path = ?, original_url = ? WHERE id = ?').run([best.fullPath, nextUrl, row.id]);
        } else {
          db.prepare('UPDATE media SET local_path = ? WHERE id = ?').run([best.fullPath, row.id]);
        }
      } else {
        db.prepare('UPDATE media SET thumb_path = ? WHERE id = ?').run([best.fullPath, row.id]);
      }
      out.dbPathUpdates += 1;
    }
  }

  // Step 3: delete duplicate files in trash, but NEVER delete any file referenced by the DB.
  const referenced = new Set<string>();
  const allRows = db.prepare('SELECT local_path, thumb_path FROM media').all() as Array<{
    local_path: string;
    thumb_path: string | null;
  }>;
  for (const r of allRows) {
    const p = kind === 'media' ? r.local_path : r.thumb_path;
    if (!p) continue;
    if (!isUnderDir(p, resolvedDir)) continue;
    referenced.add(normalizePathKey(p));
  }

  for (const group of scan.shaGroups.values()) {
    const keep: TrashFile[] = [];
    for (const f of group) {
      if (referenced.has(normalizePathKey(f.fullPath))) keep.push(f);
    }
    if (!keep.length) {
      keep.push(pickBestTrashFile(group));
      out.keptOrphans += 1;
    }

    const keepKeys = new Set(keep.map((f) => normalizePathKey(f.fullPath)));
    for (const f of group) {
      if (keepKeys.has(normalizePathKey(f.fullPath))) continue;
      // Best-effort delete (may be retried later if locked).
      try {
        const deleted = deleteFileBestEffortSync(f.fullPath);
        if (deleted || !fs.existsSync(f.fullPath)) {
          out.deletedDuplicates += 1;
        } else {
          out.lockedOrBusy += 1;
        }
      } catch (err) {
        const code = getFsErrorCode(err);
        if (isRetriableMoveErrorCode(code)) {
          out.lockedOrBusy += 1;
          enqueuePendingUnlink(f.fullPath, err);
          continue;
        }
        out.errors += 1;
      }
    }
  }

  return out;
}

function deleteMedia(db: Db, layout: FsLayout, mediaId: number) {
  const row = db
    .prepare(
      'SELECT sha256, type, local_path, thumb_path, origin, original_url, deleted_at FROM media WHERE id = ?',
    )
    .get([mediaId]) as
    | {
        sha256: string;
        type: string;
        local_path: string;
        thumb_path: string | null;
        origin: string;
        original_url: string;
        deleted_at: string | null;
      }
    | undefined;
  if (!row) return;
  if (row.deleted_at) return;

  const deletedAt = isoNow();
  const deletedFromUrl = row.origin === 'local' ? row.original_url : null;
  const deletedThumbFromPath = row.thumb_path ?? null;
  const deletedFromPath = row.local_path;

  let nextLocalPath = row.local_path;
  let nextThumbPath = row.thumb_path;
  let nextOriginalUrl = row.original_url;

  // Best-effort physical move into our own trash. If the file is locked (common on Windows when previewing),
  // we still mark it deleted in DB and avoid creating duplicate trash copies.
  if (row.local_path && fs.existsSync(row.local_path)) {
    const stableTrashPath = buildStableTrashPath(layout.trashMediaDir, row.sha256, row.local_path);
    const mv = tryMoveToTrashSync(row.local_path, stableTrashPath);
    if (!mv.ok && mv.outcome === 'failed') {
      // Deleting should be resilient: even if we can't move to trash (permission, transient locks, etc),
      // we still mark the item as deleted in DB so the UI doesn't get stuck on Windows-only filesystem errors.
      console.warn('[clipnest] delete move to trash failed', {
        id: mediaId,
        sha256: row.sha256,
        src: row.local_path,
        dest: stableTrashPath,
        code: mv.code,
      });
    }
    if (mv.ok && (mv.outcome === 'moved' || mv.outcome === 'already_present' || mv.outcome === 'copied')) {
      nextLocalPath = mv.destPath;
      if (row.origin === 'local') nextOriginalUrl = pathToFileURL(nextLocalPath).toString();
    }
  }

  if (row.thumb_path && fs.existsSync(row.thumb_path)) {
    const stableThumbTrashPath = buildStableTrashPath(layout.trashThumbsDir, row.sha256, row.thumb_path, '.webp');
    const mv = tryMoveToTrashSync(row.thumb_path, stableThumbTrashPath);
    if (!mv.ok && mv.outcome === 'failed') {
      console.warn('[clipnest] delete thumb move to trash failed', {
        id: mediaId,
        sha256: row.sha256,
        src: row.thumb_path,
        dest: stableThumbTrashPath,
        code: mv.code,
      });
    }
    if (mv.ok && (mv.outcome === 'moved' || mv.outcome === 'already_present' || mv.outcome === 'copied')) {
      nextThumbPath = mv.destPath;
    }
  }

  // If the file is already missing, treat this as a successful logical delete.

  db.prepare(
    `UPDATE media
     SET local_path = ?, thumb_path = ?, deleted_at = ?, deleted_from_path = ?, deleted_from_url = ?, deleted_thumb_from_path = ?, original_url = ?
     WHERE id = ?`,
  ).run([
    nextLocalPath,
    nextThumbPath,
    deletedAt,
    deletedFromPath,
    deletedFromUrl,
    deletedThumbFromPath,
    nextOriginalUrl,
    mediaId,
  ]);
}

function undeleteMedia(db: Db, mediaId: number) {
  const row = db
    .prepare(
      'SELECT local_path, thumb_path, origin, original_url, deleted_at, deleted_from_path, deleted_from_url, deleted_thumb_from_path FROM media WHERE id = ?',
    )
    .get([mediaId]) as
    | {
        local_path: string;
        thumb_path: string | null;
        origin: string;
        original_url: string;
        deleted_at: string | null;
        deleted_from_path: string | null;
        deleted_from_url: string | null;
        deleted_thumb_from_path: string | null;
      }
    | undefined;
  if (!row) return;
  if (!row.deleted_at) return;
  if (!row.deleted_from_path) throw new Error('no delete history');

  const restorePath = row.deleted_from_path;
  const currentPath = row.local_path;

  // If we never moved the file to trash (e.g. it was locked), then local_path may still be the original path.
  // In that case, restoring is purely a DB operation.
  if (pathsEqual(currentPath, restorePath)) {
    const nextOriginalUrl = row.origin === 'local' ? pathToFileURL(restorePath).toString() : row.original_url;
    db.prepare(
      `UPDATE media
       SET local_path = ?, thumb_path = ?, deleted_at = NULL, deleted_from_path = NULL, deleted_from_url = NULL, deleted_thumb_from_path = NULL, original_url = ?
       WHERE id = ?`,
    ).run([restorePath, row.thumb_path, nextOriginalUrl, mediaId]);
    return;
  }

  if (!fs.existsSync(currentPath)) throw new Error('trash file missing');
  if (fs.existsSync(row.deleted_from_path)) {
    if (!canReuseExistingRestoreTarget(row.local_path, row.deleted_from_path)) {
      throw new Error('target path already exists');
    }
    deleteFileBestEffortSync(row.local_path);
  } else {
    fs.mkdirSync(path.dirname(row.deleted_from_path), { recursive: true });
    moveFileSync(row.local_path, row.deleted_from_path);
  }

  let nextThumbPath: string | null = null;
  if (row.deleted_thumb_from_path && row.thumb_path) {
    const restoreThumb = row.deleted_thumb_from_path;
    const currentThumb = row.thumb_path;
    if (pathsEqual(currentThumb, restoreThumb)) {
      nextThumbPath = restoreThumb;
    } else if (fs.existsSync(currentThumb)) {
      if (fs.existsSync(row.deleted_thumb_from_path)) {
        if (!canReuseExistingRestoreTarget(row.thumb_path, row.deleted_thumb_from_path)) {
          throw new Error('thumb target already exists');
        }
        deleteFileBestEffortSync(row.thumb_path);
      } else {
        fs.mkdirSync(path.dirname(row.deleted_thumb_from_path), { recursive: true });
        moveFileSync(row.thumb_path, row.deleted_thumb_from_path);
      }
      nextThumbPath = restoreThumb;
    } else {
      nextThumbPath = restoreThumb;
    }
  }

  const nextOriginalUrl = row.origin === 'local' ? pathToFileURL(restorePath).toString() : row.original_url;

  db.prepare(
    `UPDATE media
     SET local_path = ?, thumb_path = ?, deleted_at = NULL, deleted_from_path = NULL, deleted_from_url = NULL, deleted_thumb_from_path = NULL, original_url = ?
     WHERE id = ?`,
  ).run([row.deleted_from_path, nextThumbPath, nextOriginalUrl, mediaId]);
}

type PurgeMediaResult = {
  deletedRows: number;
  deletedFiles: number;
  queuedDeletes: number;
  missingFiles: number;
};

function purgeMedia(db: Db, mediaId: number): PurgeMediaResult {
  const row = db
    .prepare('SELECT local_path, thumb_path, deleted_at FROM media WHERE id = ?')
    .get([mediaId]) as
    | {
        local_path: string;
        thumb_path: string | null;
        deleted_at: string | null;
      }
    | undefined;

  if (!row) {
    return { deletedRows: 0, deletedFiles: 0, queuedDeletes: 0, missingFiles: 0 };
  }
  if (!row.deleted_at) {
    throw new Error('media not in trash');
  }

  const result: PurgeMediaResult = {
    deletedRows: 0,
    deletedFiles: 0,
    queuedDeletes: 0,
    missingFiles: 0,
  };

  for (const filePath of [row.local_path, row.thumb_path].filter((v): v is string => Boolean(v))) {
    if (!fs.existsSync(filePath)) {
      result.missingFiles += 1;
      continue;
    }
    const deleted = deleteFileBestEffortSync(filePath);
    if (deleted || !fs.existsSync(filePath)) {
      result.deletedFiles += 1;
    } else {
      result.queuedDeletes += 1;
    }
  }

  db.prepare('DELETE FROM media WHERE id = ?').run([mediaId]);
  cleanupOrphanRows(db);
  result.deletedRows = 1;
  return result;
}

type PruneTrashResult = PurgeMediaResult & {
  scannedRows: number;
};

function pruneDeletedMedia(db: Db, _layout: FsLayout, opts: { retentionDays: number }): PruneTrashResult {
  const retentionMs = Math.max(0, opts.retentionDays) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;
  const rows = db
    .prepare('SELECT id, deleted_at FROM media WHERE deleted_at IS NOT NULL')
    .all() as Array<{ id: number; deleted_at: string }>;

  const result: PruneTrashResult = {
    scannedRows: rows.length,
    deletedRows: 0,
    deletedFiles: 0,
    queuedDeletes: 0,
    missingFiles: 0,
  };

  for (const row of rows) {
    const deletedAtMs = Date.parse(row.deleted_at);
    if (Number.isNaN(deletedAtMs)) continue;
    if (deletedAtMs > cutoff) continue;
    const purged = purgeMedia(db, row.id);
    result.deletedRows += purged.deletedRows;
    result.deletedFiles += purged.deletedFiles;
    result.queuedDeletes += purged.queuedDeletes;
    result.missingFiles += purged.missingFiles;
  }

  return result;
}

function cleanupOrphanRows(db: Db) {
  db.prepare(
    `DELETE FROM source
     WHERE NOT EXISTS (
       SELECT 1 FROM media_source ms
       WHERE ms.source_id = source.id
     )`,
  ).run();
  db.prepare(
    `DELETE FROM tag
     WHERE NOT EXISTS (
       SELECT 1 FROM media_tag mt
       WHERE mt.tag_id = tag.id
     )`,
  ).run();
  db.prepare(
    `DELETE FROM collection
     WHERE NOT EXISTS (
       SELECT 1 FROM media_collection mc
       WHERE mc.collection_id = collection.id
     )`,
  ).run();
}

function getPrimaryAuthorHandle(db: Db, mediaId: number): string | null {
  const row = db
    .prepare(
      `SELECT s.author_handle as authorHandle
       FROM source s
       JOIN media_source ms ON ms.source_id = s.id
       WHERE ms.media_id = ?
       ORDER BY s.id DESC
       LIMIT 1`,
    )
    .get([mediaId]) as { authorHandle: string | null } | undefined;
  return row?.authorHandle ?? null;
}

function buildArchiveBaseName(input: {
  mediaId: number;
  savedAt: string;
  authorHandle: string | null;
  tags: string[];
  collectionName: string;
  type: string;
  template?: string | null;
}) {
  const d = safeDate(input.savedAt);
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const datePart = `${yyyy}${mm}${dd}`;
  const timePart = `${hh}${mi}${ss}`;
  const datetimePart = `${datePart}_${timePart}`;
  const authorPart = input.authorHandle ? `@${safeFileSegment(input.authorHandle)}` : '';
  const tagPart = input.tags.length
    ? sanitizeTagSegment(
        input.tags
          .slice(0, 3)
          .map((t) => safeFileSegment(t))
          .filter(Boolean)
          .join('-'),
      )
    : '';
  const idPart = `id${input.mediaId}`;
  const collectionPart = sanitizeTagSegment(
    input.collectionName
      .split(/[\\/]+/)
      .map((segment) => safeFileSegment(segment))
      .filter(Boolean)
      .join('-'),
  );
  const typePart = safeFileSegment(input.type);

  const fallback = truncateSegment([datetimePart, authorPart, tagPart, idPart].filter(Boolean).join('_'), 140);
  const template = input.template?.trim();
  if (!template) return fallback;

  const output = applyArchiveTemplate(template, {
    date: datePart,
    time: timePart,
    datetime: datetimePart,
    author: authorPart,
    tags: tagPart,
    id: idPart,
    type: typePart,
    collection: collectionPart,
  });

  const normalized = normalizeTemplateOutput(output);
  return truncateSegment(normalized || fallback, 140);
}

function applyArchiveTemplate(template: string, tokens: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (_m, key) => tokens[key] ?? '');
}

function normalizeTemplateOutput(input: string) {
  return input
    .replace(/[<>:"|?*\\/]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/-+/g, '-')
    .replace(/^[_-]+|[_-]+$/g, '')
    .trim();
}

function sanitizeTagSegment(segment: string) {
  return segment.replace(/_+/g, '_').replace(/-+/g, '-');
}

function truncateSegment(segment: string, maxLen: number) {
  if (segment.length <= maxLen) return segment;
  return segment.slice(0, maxLen);
}

function safeDate(input: string) {
  const d = new Date(input);
  if (Number.isNaN(d.valueOf())) return new Date();
  return d;
}

function safeFileSegment(input: string) {
  const cleaned = input.replace(/[<>:"|?*\\/]/g, '_').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return '';
  return cleaned;
}

function buildTrashPath(dirPath: string, originalPath: string, mediaId: number, deletedAt: string) {
  const ext = path.extname(originalPath) || '.bin';
  const base = safeFileSegment(path.basename(originalPath, ext)) || 'media';
  const stamp = deletedAt.replace(/[:.]/g, '').replace('T', '_').replace('Z', '');
  const name = `${base}_deleted_${mediaId}_${stamp}`;
  return ensureUniquePath(dirPath, name, ext);
}

function ensureUniquePath(dirPath: string, baseName: string, ext: string) {
  let candidate = path.join(dirPath, `${baseName}${ext}`);
  if (!fs.existsSync(candidate)) return candidate;
  for (let i = 2; i <= 500; i += 1) {
    const next = path.join(dirPath, `${baseName}-${i}${ext}`);
    if (!fs.existsSync(next)) return next;
  }
  throw new Error('too many duplicate files');
}

function resolveCollectionPath(libraryRoot: string, collectionName: string) {
  const segments = collectionName.split(/[\\/]+/).map((s) => s.trim()).filter(Boolean).map(sanitizeSegment);
  if (segments.length === 0) throw new Error('invalid collection name');
  const relative = path.join(...segments);
  const dirPath = path.resolve(libraryRoot, relative);
  if (!isSubPath(libraryRoot, dirPath)) throw new Error('invalid collection path');
  return { dirPath, relative };
}

function sanitizeSegment(segment: string) {
  const cleaned = segment.replace(/[<>:"|?*\\/]/g, '_').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error('invalid collection name');
  }
  return cleaned;
}

function isSubPath(root: string, target: string) {
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(target);
  const rootNorm = process.platform === 'win32' ? rootResolved.toLowerCase() : rootResolved;
  const targetNorm = process.platform === 'win32' ? targetResolved.toLowerCase() : targetResolved;
  if (rootNorm === targetNorm) return true;
  return targetNorm.startsWith(rootNorm + path.sep);
}

function getFsErrorCode(err: unknown) {
  return err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code ?? '') : '';
}

function isRetriableMoveErrorCode(code: string) {
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

function sleepSync(ms: number) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function canReuseExistingRestoreTarget(srcPath: string, destPath: string) {
  try {
    const srcStat = fs.statSync(srcPath);
    const destStat = fs.statSync(destPath);
    return srcStat.isFile() && destStat.isFile() && srcStat.size === destStat.size;
  } catch {
    return false;
  }
}

function unlinkFileWithRetrySync(
  srcPath: string,
  attempts = 10,
  delayMs = 160,
  opts?: { enqueueOnFinalFailure?: boolean },
): boolean {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.unlinkSync(srcPath);
      return true;
    } catch (err) {
      const code = getFsErrorCode(err);
      if (!isRetriableMoveErrorCode(code) || attempt === attempts - 1) {
        if (opts?.enqueueOnFinalFailure && isRetriableMoveErrorCode(code)) {
          enqueuePendingUnlink(srcPath, err);
          return false;
        }
        throw err;
      }
      sleepSync(delayMs);
    }
  }
  return false;
}

function deleteFileBestEffortSync(filePath: string): boolean {
  if (!filePath || !fs.existsSync(filePath)) return true;
  return unlinkFileWithRetrySync(filePath, 12, 200, { enqueueOnFinalFailure: true });
}

function moveFileSync(srcPath: string, destPath: string) {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.renameSync(srcPath, destPath);
      return;
    } catch (err) {
      const code = getFsErrorCode(err);
      if (code === 'EXDEV') {
        fs.copyFileSync(srcPath, destPath);
        unlinkFileWithRetrySync(srcPath, 10, 160, { enqueueOnFinalFailure: true });
        return;
      }
      if (!isRetriableMoveErrorCode(code) || attempt === 7) {
        lastErr = err;
        break;
      }
      lastErr = err;
      sleepSync(140 + attempt * 40);
    }
  }

  const lastCode = getFsErrorCode(lastErr);
  if (isRetriableMoveErrorCode(lastCode)) {
    fs.copyFileSync(srcPath, destPath);
    unlinkFileWithRetrySync(srcPath, 12, 200, { enqueueOnFinalFailure: true });
    return;
  }

  throw lastErr;
}
