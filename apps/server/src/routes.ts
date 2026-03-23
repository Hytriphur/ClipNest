import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { z } from 'zod';
import mime from 'mime-types';

import type { Db } from './db.js';
import type { FsLayout } from './fs-layout.js';
import type { ServerConfig } from './config.js';
import { ingestItems } from './ingest.js';
import type { IngestProgressEvent } from './ingest.js';
import { ingestLocalFiles, scanLocalFiles } from './local-import.js';
import { hammingDistanceHex } from './phash.js';

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

  r.get('/health', (_req, res) => res.json({ ok: true }));

  r.get('/settings', (_req, res) => {
    const libraryRoot = getSetting(opts.db, 'library_root');
    const archiveTemplate = getSetting(opts.db, 'archive_template');
    res.json({ ok: true, libraryRoot: libraryRoot ?? null, archiveTemplate: archiveTemplate ?? null });
  });

  r.post('/settings', (req, res) => {
    const parsed = settingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }
    const payload = parsed.data;
    const hasLibraryRoot = Object.prototype.hasOwnProperty.call(payload, 'libraryRoot');
    const hasArchiveTemplate = Object.prototype.hasOwnProperty.call(payload, 'archiveTemplate');

    if (hasLibraryRoot) {
      const next = payload.libraryRoot ?? null;
      if (!next || !next.trim()) {
        clearSetting(opts.db, 'library_root');
      } else {
        try {
          const normalized = normalizeLibraryRoot(next);
          setSetting(opts.db, 'library_root', normalized);
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

    const libraryRoot = getSetting(opts.db, 'library_root');
    const archiveTemplate = getSetting(opts.db, 'archive_template');
    return res.json({ ok: true, libraryRoot: libraryRoot ?? null, archiveTemplate: archiveTemplate ?? null });
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

    const totalRow = opts.db
      .prepare(`SELECT COUNT(1) AS n FROM media m ${whereSql}`)
      .get(params) as { n: number };

    const rows = opts.db
      .prepare(
        `SELECT m.*
         FROM media m
         ${whereSql}
         ORDER BY m.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all([...params, limit, offset]) as any[];

    const items = rows.map((m) => mapMediaRow(opts.db, m));

    const nextOffset = rows.length < limit ? 0 : offset + items.length;
    res.json({ ok: true, items, nextOffset, totalCount: totalRow.n });
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
    if (row.deleted_at) return res.status(404).end();
    if (!fs.existsSync(row.local_path)) return res.status(404).end();

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
    const row = opts.db.prepare('SELECT thumb_path, deleted_at FROM media WHERE id = ?').get([id]) as
      | { thumb_path: string | null; deleted_at: string | null }
      | undefined;
    if (!row?.thumb_path) return res.status(404).end();
    if (row.deleted_at) return res.status(404).end();
    if (!fs.existsSync(row.thumb_path)) return res.status(404).end();

    const ct = mime.lookup(row.thumb_path) || 'image/webp';
    res.setHeader('content-type', ct);
    fs.createReadStream(row.thumb_path).pipe(res);
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

  const targetPath = row.archived_from_path;
  if (fs.existsSync(targetPath)) {
    throw new Error('target path already exists');
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  moveFileSync(row.local_path, targetPath);

  if (row.origin === 'local' && row.archived_from_url) {
    db.prepare(
      'UPDATE media SET local_path = ?, original_url = ?, archived_at = NULL, archived_from_path = NULL, archived_from_url = NULL WHERE id = ?',
    ).run([targetPath, row.archived_from_url, mediaId]);
  } else {
    db.prepare(
      'UPDATE media SET local_path = ?, archived_at = NULL, archived_from_path = NULL, archived_from_url = NULL WHERE id = ?',
    ).run([targetPath, mediaId]);
  }
}

function deleteMedia(db: Db, layout: FsLayout, mediaId: number) {
  const row = db
    .prepare(
      'SELECT local_path, thumb_path, origin, original_url, deleted_at FROM media WHERE id = ?',
    )
    .get([mediaId]) as
    | {
        local_path: string;
        thumb_path: string | null;
        origin: string;
        original_url: string;
        deleted_at: string | null;
      }
    | undefined;
  if (!row) return;
  if (row.deleted_at) return;
  if (!fs.existsSync(row.local_path)) throw new Error('file not found');

  const deletedAt = isoNow();
  const trashPath = buildTrashPath(layout.trashMediaDir, row.local_path, mediaId, deletedAt);
  moveFileSync(row.local_path, trashPath);

  let nextThumbPath: string | null = null;
  let deletedThumbFromPath: string | null = null;
  if (row.thumb_path && fs.existsSync(row.thumb_path)) {
    nextThumbPath = buildTrashPath(layout.trashThumbsDir, row.thumb_path, mediaId, deletedAt);
    moveFileSync(row.thumb_path, nextThumbPath);
    deletedThumbFromPath = row.thumb_path;
  }

  const deletedFromUrl = row.origin === 'local' ? row.original_url : null;
  const nextOriginalUrl =
    row.origin === 'local' ? pathToFileURL(trashPath).toString() : row.original_url;

  db.prepare(
    `UPDATE media
     SET local_path = ?, thumb_path = ?, deleted_at = ?, deleted_from_path = ?, deleted_from_url = ?, deleted_thumb_from_path = ?, original_url = ?
     WHERE id = ?`,
  ).run([
    trashPath,
    nextThumbPath,
    deletedAt,
    row.local_path,
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
  if (!fs.existsSync(row.local_path)) throw new Error('trash file missing');
  if (fs.existsSync(row.deleted_from_path)) throw new Error('target path already exists');

  fs.mkdirSync(path.dirname(row.deleted_from_path), { recursive: true });
  moveFileSync(row.local_path, row.deleted_from_path);

  let nextThumbPath: string | null = null;
  if (row.deleted_thumb_from_path && row.thumb_path && fs.existsSync(row.thumb_path)) {
    if (fs.existsSync(row.deleted_thumb_from_path)) throw new Error('thumb target already exists');
    fs.mkdirSync(path.dirname(row.deleted_thumb_from_path), { recursive: true });
    moveFileSync(row.thumb_path, row.deleted_thumb_from_path);
    nextThumbPath = row.deleted_thumb_from_path;
  }

  const nextOriginalUrl =
    row.origin === 'local' && row.deleted_from_url ? row.deleted_from_url : row.original_url;

  db.prepare(
    `UPDATE media
     SET local_path = ?, thumb_path = ?, deleted_at = NULL, deleted_from_path = NULL, deleted_from_url = NULL, deleted_thumb_from_path = NULL, original_url = ?
     WHERE id = ?`,
  ).run([row.deleted_from_path, nextThumbPath, nextOriginalUrl, mediaId]);
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
