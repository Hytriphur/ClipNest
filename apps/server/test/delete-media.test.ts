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
});
