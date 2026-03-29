import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';

import { getDefaultConfig } from '../src/config.js';
import { openDb, migrate, type Db } from '../src/db.js';
import { ensureFsLayout, getFsLayout, type FsLayout } from '../src/fs-layout.js';
import { createRouter } from '../src/routes.js';

type TestContext = {
  baseUrl: string;
  tmpDir: string;
  layout: FsLayout;
  db: Db;
  close: () => Promise<void>;
};

let ctx: TestContext | null = null;

async function createContext(): Promise<TestContext> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xic-delete-'));
  const cfg = { ...getDefaultConfig(), dataDir: tmpDir };
  const layout = getFsLayout(cfg);
  ensureFsLayout(layout);
  const db = openDb(layout);
  migrate(db);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', createRouter({ db, layout, cfg }));

  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  return {
    baseUrl,
    tmpDir,
    layout,
    db,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        try {
          const closeDb = (db as any)?.close;
          if (typeof closeDb === 'function') {
            closeDb.call(db);
          }
        } catch {
          // ignore best-effort close
        }
      }),
  };
}

async function apiGet<T>(baseUrl: string, pathName: string): Promise<T> {
  const res = await fetch(`${baseUrl}${pathName}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function apiPost<T>(baseUrl: string, pathName: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${pathName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

beforeEach(async () => {
  ctx = await createContext();
});

afterEach(async () => {
  if (!ctx) return;
  await ctx.close();
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  ctx = null;
});

describe('delete + undelete media', () => {
  it('moves files to trash and restores them with undo', async () => {
    if (!ctx) throw new Error('missing context');
    const now = new Date().toISOString();
    const mediaPath = path.join(ctx.layout.mediaDir, 'sample.jpg');
    const thumbPath = path.join(ctx.layout.thumbsDir, 'sample.webp');
    fs.writeFileSync(mediaPath, 'sample');
    fs.writeFileSync(thumbPath, 'thumb');

    ctx.db
      .prepare(
        `INSERT INTO media (sha256, type, original_url, local_path, thumb_path, saved_at, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(['sha-test-1', 'image', 'https://example.test/original.jpg', mediaPath, thumbPath, now, 'x']);

    const row = ctx.db.prepare('SELECT id FROM media WHERE sha256 = ?').get(['sha-test-1']) as { id: number };
    const id = row.id;

    const listBefore = await apiGet<{ ok: true; items: any[] }>(ctx.baseUrl, '/media');
    expect(listBefore.items.length).toBe(1);

    await apiPost(ctx.baseUrl, `/media/${id}/delete`, {});

    const deletedRow = ctx.db
      .prepare(
        'SELECT local_path, thumb_path, deleted_at, deleted_from_path, deleted_thumb_from_path FROM media WHERE id = ?',
      )
      .get([id]) as {
      local_path: string;
      thumb_path: string | null;
      deleted_at: string | null;
      deleted_from_path: string | null;
      deleted_thumb_from_path: string | null;
    };

    expect(deletedRow.deleted_at).not.toBeNull();
    expect(deletedRow.deleted_from_path).toBe(mediaPath);
    expect(deletedRow.deleted_thumb_from_path).toBe(thumbPath);
    expect(fs.existsSync(mediaPath)).toBe(false);
    expect(fs.existsSync(thumbPath)).toBe(false);
    expect(fs.existsSync(deletedRow.local_path)).toBe(true);
    if (deletedRow.thumb_path) {
      expect(fs.existsSync(deletedRow.thumb_path)).toBe(true);
    }

    const listAfter = await apiGet<{ ok: true; items: any[] }>(ctx.baseUrl, '/media');
    expect(listAfter.items.length).toBe(0);
    const listDeleted = await apiGet<{ ok: true; items: any[] }>(ctx.baseUrl, '/media?deleted=yes');
    expect(listDeleted.items.length).toBe(1);

    await apiPost(ctx.baseUrl, `/media/${id}/undelete`, {});

    const restored = ctx.db
      .prepare('SELECT local_path, thumb_path, deleted_at FROM media WHERE id = ?')
      .get([id]) as { local_path: string; thumb_path: string | null; deleted_at: string | null };
    expect(restored.deleted_at).toBeNull();
    expect(restored.local_path).toBe(mediaPath);
    expect(restored.thumb_path).toBe(thumbPath);
    expect(fs.existsSync(mediaPath)).toBe(true);
    expect(fs.existsSync(thumbPath)).toBe(true);
  });

  it('purges deleted media and removes files permanently', async () => {
    if (!ctx) throw new Error('missing context');
    const now = new Date().toISOString();
    const mediaPath = path.join(ctx.layout.mediaDir, 'purge-target.jpg');
    const thumbPath = path.join(ctx.layout.thumbsDir, 'purge-target.webp');
    fs.writeFileSync(mediaPath, 'purge-sample');
    fs.writeFileSync(thumbPath, 'purge-thumb');

    ctx.db
      .prepare(
        `INSERT INTO media (sha256, type, original_url, local_path, thumb_path, saved_at, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(['sha-test-purge-1', 'image', 'https://example.test/purge.jpg', mediaPath, thumbPath, now, 'x']);

    const row = ctx.db.prepare('SELECT id FROM media WHERE sha256 = ?').get(['sha-test-purge-1']) as { id: number };

    await apiPost(ctx.baseUrl, `/media/${row.id}/delete`, {});

    const deleted = ctx.db
      .prepare('SELECT local_path, thumb_path, deleted_at FROM media WHERE id = ?')
      .get([row.id]) as { local_path: string; thumb_path: string | null; deleted_at: string | null };

    expect(deleted.deleted_at).not.toBeNull();
    expect(fs.existsSync(deleted.local_path)).toBe(true);
    if (deleted.thumb_path) {
      expect(fs.existsSync(deleted.thumb_path)).toBe(true);
    }

    await apiPost(ctx.baseUrl, `/media/${row.id}/purge`, {});

    const missing = ctx.db.prepare('SELECT id FROM media WHERE id = ?').get([row.id]);
    expect(missing).toBeUndefined();
    expect(fs.existsSync(deleted.local_path)).toBe(false);
    if (deleted.thumb_path) {
      expect(fs.existsSync(deleted.thumb_path)).toBe(false);
    }

    const listDeleted = await apiGet<{ ok: true; items: any[] }>(ctx.baseUrl, '/media?deleted=yes');
    expect(listDeleted.items.length).toBe(0);
  });

  it('prunes old trash items by retention days', async () => {
    if (!ctx) throw new Error('missing context');
    const now = new Date().toISOString();
    const mediaPath = path.join(ctx.layout.mediaDir, 'prune-target.jpg');
    fs.writeFileSync(mediaPath, 'prune-sample');

    ctx.db
      .prepare(
        `INSERT INTO media (sha256, type, original_url, local_path, thumb_path, saved_at, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(['sha-test-prune-1', 'image', 'https://example.test/prune.jpg', mediaPath, null, now, 'x']);

    const row = ctx.db.prepare('SELECT id FROM media WHERE sha256 = ?').get(['sha-test-prune-1']) as { id: number };

    await apiPost(ctx.baseUrl, `/media/${row.id}/delete`, {});

    const deleted = ctx.db
      .prepare('SELECT local_path, deleted_at FROM media WHERE id = ?')
      .get([row.id]) as { local_path: string; deleted_at: string | null };
    expect(deleted.deleted_at).not.toBeNull();
    expect(fs.existsSync(deleted.local_path)).toBe(true);

    const oldDeletedAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    ctx.db.prepare('UPDATE media SET deleted_at = ? WHERE id = ?').run([oldDeletedAt, row.id]);

    const pruned = await apiPost<{
      ok: true;
      retentionDays: number;
      result: { deletedRows: number; deletedFiles: number; missingFiles: number; queuedDeletes: number; scannedRows: number };
    }>(ctx.baseUrl, '/maintenance/trash/prune', { days: 30 });

    expect(pruned.retentionDays).toBe(30);
    expect(pruned.result.deletedRows).toBe(1);

    const missing = ctx.db.prepare('SELECT id FROM media WHERE id = ?').get([row.id]);
    expect(missing).toBeUndefined();
    expect(fs.existsSync(deleted.local_path)).toBe(false);
  });

  it('serves original image as thumb fallback when thumb file is missing', async () => {
    if (!ctx) throw new Error('missing context');
    const now = new Date().toISOString();
    const mediaPath = path.join(ctx.layout.mediaDir, 'thumb-fallback.jpg');
    const missingThumbPath = path.join(ctx.layout.thumbsDir, 'thumb-fallback.webp');
    fs.writeFileSync(mediaPath, 'fallback-image');

    ctx.db
      .prepare(
        `INSERT INTO media (sha256, type, original_url, local_path, thumb_path, saved_at, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(['sha-test-thumb-fallback-1', 'image', 'https://example.test/thumb-fallback.jpg', mediaPath, missingThumbPath, now, 'x']);

    const row = ctx.db
      .prepare('SELECT id FROM media WHERE sha256 = ?')
      .get(['sha-test-thumb-fallback-1']) as { id: number };

    const res = await fetch(`${ctx.baseUrl}/media/${row.id}/thumb`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/');
    expect(await res.text()).toBe('fallback-image');
  });

  it('marks externally deleted files as deleted when listing media', async () => {
    if (!ctx) throw new Error('missing context');
    const now = new Date().toISOString();
    const mediaPath = path.join(ctx.layout.mediaDir, 'external-missing.jpg');
    fs.writeFileSync(mediaPath, 'sample-external-delete');

    ctx.db
      .prepare(
        `INSERT INTO media (sha256, type, original_url, local_path, thumb_path, saved_at, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(['sha-test-missing-1', 'image', 'https://example.test/external-missing.jpg', mediaPath, null, now, 'x']);

    const row = ctx.db.prepare('SELECT id FROM media WHERE sha256 = ?').get(['sha-test-missing-1']) as { id: number };
    fs.unlinkSync(mediaPath);

    const list = await apiGet<{ ok: true; items: any[]; totalCount?: number }>(ctx.baseUrl, '/media');
    expect(list.items.some((item) => item.id === row.id)).toBe(false);

    const marked = ctx.db
      .prepare('SELECT deleted_at, deleted_from_path FROM media WHERE id = ?')
      .get([row.id]) as { deleted_at: string | null; deleted_from_path: string | null };
    expect(marked.deleted_at).not.toBeNull();
    expect(marked.deleted_from_path).toBe(mediaPath);
  });

  it('unarchives to a unique path when archive history target already exists', async () => {
    if (!ctx) throw new Error('missing context');
    const now = new Date().toISOString();
    const originalPath = path.join(ctx.layout.mediaDir, 'conflict-target.jpg');
    const archivedPath = path.join(ctx.layout.mediaDir, 'archived-conflict.jpg');
    fs.writeFileSync(originalPath, 'existing-original');
    fs.writeFileSync(archivedPath, 'archived-content');

    ctx.db
      .prepare(
        `INSERT INTO media (sha256, type, original_url, local_path, thumb_path, saved_at, origin, archived_at, archived_from_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run([
        'sha-test-unarchive-conflict-1',
        'image',
        'https://example.test/conflict.jpg',
        archivedPath,
        null,
        now,
        'x',
        now,
        originalPath,
      ]);

    const row = ctx.db
      .prepare('SELECT id FROM media WHERE sha256 = ?')
      .get(['sha-test-unarchive-conflict-1']) as { id: number };

    await apiPost(ctx.baseUrl, `/media/${row.id}/unarchive`, {});

    const restored = ctx.db
      .prepare('SELECT local_path, archived_at, archived_from_path FROM media WHERE id = ?')
      .get([row.id]) as { local_path: string; archived_at: string | null; archived_from_path: string | null };
    expect(restored.archived_at).toBeNull();
    expect(restored.archived_from_path).toBeNull();
    expect(restored.local_path).not.toBe(archivedPath);
    expect(restored.local_path).not.toBe(originalPath);
    expect(fs.existsSync(restored.local_path)).toBe(true);
    expect(fs.existsSync(archivedPath)).toBe(false);
    expect(fs.existsSync(originalPath)).toBe(true);
  });
});
