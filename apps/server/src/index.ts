import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import cors from 'cors';

import { getDefaultConfig, getManagedDataDirForLibraryRoot, writePersistedDataLocation } from './config.js';
import { ensureFsLayout, getFsLayout } from './fs-layout.js';
import { openDb, migrate, type Db } from './db.js';
import { createRouter } from './routes.js';
import { logger } from './logger.js';

function pathsEqual(a: string, b: string) {
  const ar = path.resolve(a);
  const br = path.resolve(b);
  if (process.platform === 'win32') return ar.toLowerCase() === br.toLowerCase();
  return ar === br;
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

function normalizePathKey(p: string) {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function replacePrefix(p: string | null | undefined, fromDir: string, toDir: string): string | null {
  if (!p) return null;
  const resolved = path.resolve(p);
  const fromResolved = path.resolve(fromDir);
  const toResolved = path.resolve(toDir);
  const norm = normalizePathKey(resolved);
  const fromNorm = normalizePathKey(fromResolved);
  if (norm === fromNorm) return toResolved;
  if (norm.startsWith(fromNorm + path.sep)) {
    const suffix = resolved.slice(fromResolved.length);
    return toResolved + suffix;
  }
  return null;
}

function copyDirMergeSync(srcDir: string, destDir: string) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    const src = path.join(srcDir, ent.name);
    const dest = path.join(destDir, ent.name);
    if (ent.isDirectory()) {
      copyDirMergeSync(src, dest);
      continue;
    }
    if (ent.isFile()) {
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
      }
    }
  }
}

function moveDirMergeSync(srcDir: string, destDir: string) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  if (!fs.existsSync(destDir)) {
    try {
      fs.renameSync(srcDir, destDir);
      return;
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String((err as any).code ?? '') : '';
      if (code !== 'EXDEV') throw err;
    }
  }

  // Cross-device or dest already exists: merge-copy, then best-effort remove.
  copyDirMergeSync(srcDir, destDir);
  try {
    fs.rmSync(srcDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function moveFileSync(srcPath: string, destPath: string) {
  if (!fs.existsSync(srcPath)) return;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath)) throw new Error(`destination exists: ${destPath}`);
  try {
    fs.renameSync(srcPath, destPath);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as any).code ?? '') : '';
    if (code !== 'EXDEV') throw err;
    fs.copyFileSync(srcPath, destPath);
    fs.rmSync(srcPath, { force: true });
  }
}

function migrateDataDirToLibraryRoot(opts: {
  fromDataDir: string;
  libraryRoot: string;
  port: number;
}) {
  const fromDataDir = path.resolve(opts.fromDataDir);
  const libraryRoot = path.resolve(opts.libraryRoot);
  const toDataDir = getManagedDataDirForLibraryRoot(libraryRoot);
  if (pathsEqual(fromDataDir, toDataDir)) return;

  const toMediaDir = path.join(libraryRoot, '_unarchived');
  const fromMediaDir = path.join(fromDataDir, 'media');
  const fromThumbsDir = path.join(fromDataDir, 'thumbs');
  const fromTrashDir = path.join(fromDataDir, 'trash');
  const fromDbPath = path.join(fromDataDir, 'db.sqlite');

  const toDbPath = path.join(toDataDir, 'db.sqlite');
  const toThumbsDir = path.join(toDataDir, 'thumbs');
  const toTrashDir = path.join(toDataDir, 'trash');

  if (!fs.existsSync(fromDbPath)) return;
  if (fs.existsSync(toDbPath)) {
    // This can happen if the user previously migrated successfully, but later lost the persisted dataDir
    // (or created an empty home dir) and the server is trying to migrate again. Prefer recovery over crashing:
    // keep using the destination and persist it as the active dataDir.
    logger.warn('destination db already exists; skipping migration and using destination', {
      from: fromDataDir,
      to: toDataDir,
      libraryRoot,
    });
    writePersistedDataLocation({ dataDir: toDataDir, libraryRoot });
    return;
  }

  logger.info('migrating data dir to library root', {
    from: fromDataDir,
    to: toDataDir,
    libraryRoot,
    hint: `After migration, server will keep using the new location automatically.`,
  });

  fs.mkdirSync(toDataDir, { recursive: true });
  fs.mkdirSync(toMediaDir, { recursive: true });
  fs.mkdirSync(toThumbsDir, { recursive: true });
  fs.mkdirSync(toTrashDir, { recursive: true });

  // Move DB first (server isn't listening yet).
  moveFileSync(fromDbPath, toDbPath);
  moveDirMergeSync(fromThumbsDir, toThumbsDir);
  moveDirMergeSync(fromTrashDir, toTrashDir);
  moveDirMergeSync(fromMediaDir, toMediaDir);

  // Rewrite absolute paths inside the DB to reflect the new layout.
  const layout = getFsLayout({ ...getDefaultConfig(), dataDir: toDataDir, port: opts.port }, { libraryRoot });
  ensureFsLayout(layout);
  const db = openDb(layout);
  migrate(db);

  const rows = db
    .prepare(
      'SELECT id, origin, local_path, thumb_path, archived_from_path, deleted_from_path, deleted_thumb_from_path, original_url, archived_from_url, deleted_from_url FROM media',
    )
    .all() as Array<{
    id: number;
    origin: string;
    local_path: string;
    thumb_path: string | null;
    archived_from_path: string | null;
    deleted_from_path: string | null;
    deleted_thumb_from_path: string | null;
    original_url: string;
    archived_from_url: string | null;
    deleted_from_url: string | null;
  }>;

  const update = db.prepare(
    `UPDATE media
     SET local_path = ?,
         thumb_path = ?,
         archived_from_path = ?,
         deleted_from_path = ?,
         deleted_thumb_from_path = ?,
         original_url = ?,
         archived_from_url = ?,
         deleted_from_url = ?
     WHERE id = ?`,
  );

  const fromTrashMediaDir = path.join(fromDataDir, 'trash', 'media');
  const fromTrashThumbsDir = path.join(fromDataDir, 'trash', 'thumbs');
  const toTrashMediaDir = path.join(toDataDir, 'trash', 'media');
  const toTrashThumbsDir = path.join(toDataDir, 'trash', 'thumbs');

  for (const r of rows) {
    const nextLocal =
      replacePrefix(r.local_path, fromTrashMediaDir, toTrashMediaDir) ??
      replacePrefix(r.local_path, fromMediaDir, toMediaDir) ??
      r.local_path;
    const nextThumb = r.thumb_path
      ? (replacePrefix(r.thumb_path, fromTrashThumbsDir, toTrashThumbsDir) ??
        replacePrefix(r.thumb_path, fromThumbsDir, toThumbsDir) ??
        r.thumb_path)
      : null;
    const nextArchivedFrom = r.archived_from_path
      ? replacePrefix(r.archived_from_path, fromMediaDir, toMediaDir) ?? r.archived_from_path
      : null;
    const nextDeletedFrom = r.deleted_from_path
      ? replacePrefix(r.deleted_from_path, fromMediaDir, toMediaDir) ?? r.deleted_from_path
      : null;
    const nextDeletedThumbFrom = r.deleted_thumb_from_path
      ? replacePrefix(r.deleted_thumb_from_path, fromThumbsDir, toThumbsDir) ?? r.deleted_thumb_from_path
      : null;

    let nextOriginalUrl = r.original_url;
    let nextArchivedFromUrl = r.archived_from_url;
    let nextDeletedFromUrl = r.deleted_from_url;
    if (r.origin === 'local') {
      nextOriginalUrl = pathToFileURL(nextLocal).toString();
      if (nextArchivedFrom && nextArchivedFromUrl) {
        nextArchivedFromUrl = pathToFileURL(nextArchivedFrom).toString();
      }
      if (nextDeletedFrom && nextDeletedFromUrl) {
        nextDeletedFromUrl = pathToFileURL(nextDeletedFrom).toString();
      }
    }

    const changed =
      nextLocal !== r.local_path ||
      nextThumb !== r.thumb_path ||
      nextArchivedFrom !== r.archived_from_path ||
      nextDeletedFrom !== r.deleted_from_path ||
      nextDeletedThumbFrom !== r.deleted_thumb_from_path ||
      nextOriginalUrl !== r.original_url ||
      nextArchivedFromUrl !== r.archived_from_url ||
      nextDeletedFromUrl !== r.deleted_from_url;

    if (changed) {
      update.run([
        nextLocal,
        nextThumb,
        nextArchivedFrom,
        nextDeletedFrom,
        nextDeletedThumbFrom,
        nextOriginalUrl,
        nextArchivedFromUrl,
        nextDeletedFromUrl,
        r.id,
      ]);
    }
  }

  db.close();

  // Persist bootstrap so future starts always use the migrated location (even without env vars).
  writePersistedDataLocation({ dataDir: toDataDir, libraryRoot });

  logger.info('data dir migration complete', {
    dataDir: toDataDir,
    unarchivedDir: toMediaDir,
    health: `http://localhost:${opts.port}/api/health`,
  });
}

function migrateLibraryRootTwitterToClipNest(opts: { fromLibraryRoot: string; port: number }) {
  const fromLibraryRoot = path.resolve(opts.fromLibraryRoot);
  const base = path.basename(fromLibraryRoot);
  if (base.toLowerCase() !== 'twitter') return null;

  const parent = path.dirname(fromLibraryRoot);
  const toLibraryRoot = path.join(parent, 'ClipNest');
  if (fs.existsSync(toLibraryRoot)) {
    logger.warn('library root rename skipped: target already exists', {
      from: fromLibraryRoot,
      to: toLibraryRoot,
    });
    return null;
  }
  if (!fs.existsSync(fromLibraryRoot)) return null;

  logger.info('renaming library root folder', {
    from: fromLibraryRoot,
    to: toLibraryRoot,
    note: 'This is a one-time migration for the default library root folder name.',
  });

  moveDirMergeSync(fromLibraryRoot, toLibraryRoot);
  return { toLibraryRoot };
}

let cfg = getDefaultConfig();
let layout = getFsLayout(cfg, { libraryRoot: cfg.libraryRootDir ?? null });
ensureFsLayout(layout);
let db = openDb(layout);
migrate(db);

// If the user configured a library root in DB but data is still in the legacy home dir, migrate to <libraryRoot>/.clipnest.
const dbLibraryRootRaw = getSetting(db, 'library_root');
const libraryRootRaw = (cfg.libraryRootDir && cfg.libraryRootDir.trim()) || (dbLibraryRootRaw && dbLibraryRootRaw.trim()) || null;

if (!process.env.XIC_DATA_DIR?.trim() && libraryRootRaw) {
  try {
    const normalized = normalizeLibraryRoot(libraryRootRaw);
    const desired = getManagedDataDirForLibraryRoot(normalized);
    const isDefaultHomeDir = normalizePathKey(cfg.dataDir).startsWith(normalizePathKey(os.homedir()) + path.sep);
    if (isDefaultHomeDir && !pathsEqual(cfg.dataDir, desired)) {
      db.close();
      migrateDataDirToLibraryRoot({ fromDataDir: cfg.dataDir, libraryRoot: normalized, port: cfg.port });
      cfg = getDefaultConfig();
      layout = getFsLayout(cfg, { libraryRoot: cfg.libraryRootDir ?? normalized });
      ensureFsLayout(layout);
      db = openDb(layout);
      migrate(db);
    }

    // Keep the bootstrap in sync with the DB setting (but don't force dataDir moves here).
    writePersistedDataLocation({ libraryRoot: normalized });
  } catch (err) {
    logger.warn('libraryRoot present but migration skipped', { error: err instanceof Error ? err.message : String(err) });
  }
}

// One-time cosmetic migration: if user's library root folder is named "Twitter", rename it to "ClipNest"
// and rewrite absolute paths inside the DB. Skip when XIC_DATA_DIR is set because env overrides persistence.
if (!process.env.XIC_DATA_DIR?.trim()) {
  const activeRoot = getSetting(db, 'library_root') ?? cfg.libraryRootDir ?? null;
  if (activeRoot) {
    try {
      const normalized = normalizeLibraryRoot(activeRoot);
      // Only migrate if the managed data dir is inside the library root; this keeps the operation safe and atomic.
      const managedDataDir = getManagedDataDirForLibraryRoot(normalized);
      if (pathsEqual(layout.rootDir, managedDataDir)) {
        db.close();
        const rename = migrateLibraryRootTwitterToClipNest({ fromLibraryRoot: normalized, port: cfg.port });
        if (rename?.toLibraryRoot) {
          const toLibraryRoot = rename.toLibraryRoot;
          const toDataDir = getManagedDataDirForLibraryRoot(toLibraryRoot);
          // Persist bootstrap so restarts follow the renamed folder.
          writePersistedDataLocation({ dataDir: toDataDir, libraryRoot: toLibraryRoot });

          // Open DB at the new location and rewrite absolute paths.
          const nextCfg = { ...getDefaultConfig(), dataDir: toDataDir, port: cfg.port };
          const nextLayout = getFsLayout(nextCfg, { libraryRoot: toLibraryRoot });
          ensureFsLayout(nextLayout);
          const nextDb = openDb(nextLayout);
          migrate(nextDb);

          setSetting(nextDb, 'library_root', toLibraryRoot);

          const rows = nextDb
            .prepare(
              'SELECT id, origin, local_path, thumb_path, archived_from_path, deleted_from_path, deleted_thumb_from_path, original_url, archived_from_url, deleted_from_url FROM media',
            )
            .all() as Array<{
            id: number;
            origin: string;
            local_path: string;
            thumb_path: string | null;
            archived_from_path: string | null;
            deleted_from_path: string | null;
            deleted_thumb_from_path: string | null;
            original_url: string;
            archived_from_url: string | null;
            deleted_from_url: string | null;
          }>;

          const update = nextDb.prepare(
            `UPDATE media
             SET local_path = ?,
                 thumb_path = ?,
                 archived_from_path = ?,
                 deleted_from_path = ?,
                 deleted_thumb_from_path = ?,
                 original_url = ?,
                 archived_from_url = ?,
                 deleted_from_url = ?
             WHERE id = ?`,
          );

          for (const r of rows) {
            const nextLocal = replacePrefix(r.local_path, normalized, toLibraryRoot) ?? r.local_path;
            const nextThumb = r.thumb_path ? replacePrefix(r.thumb_path, normalized, toLibraryRoot) ?? r.thumb_path : null;
            const nextArchivedFrom = r.archived_from_path
              ? replacePrefix(r.archived_from_path, normalized, toLibraryRoot) ?? r.archived_from_path
              : null;
            const nextDeletedFrom = r.deleted_from_path
              ? replacePrefix(r.deleted_from_path, normalized, toLibraryRoot) ?? r.deleted_from_path
              : null;
            const nextDeletedThumbFrom = r.deleted_thumb_from_path
              ? replacePrefix(r.deleted_thumb_from_path, normalized, toLibraryRoot) ?? r.deleted_thumb_from_path
              : null;

            let nextOriginalUrl = r.original_url;
            let nextArchivedFromUrl = r.archived_from_url;
            let nextDeletedFromUrl = r.deleted_from_url;
            if (r.origin === 'local') {
              nextOriginalUrl = pathToFileURL(nextLocal).toString();
              if (nextArchivedFrom && nextArchivedFromUrl) nextArchivedFromUrl = pathToFileURL(nextArchivedFrom).toString();
              if (nextDeletedFrom && nextDeletedFromUrl) nextDeletedFromUrl = pathToFileURL(nextDeletedFrom).toString();
            }

            const changed =
              nextLocal !== r.local_path ||
              nextThumb !== r.thumb_path ||
              nextArchivedFrom !== r.archived_from_path ||
              nextDeletedFrom !== r.deleted_from_path ||
              nextDeletedThumbFrom !== r.deleted_thumb_from_path ||
              nextOriginalUrl !== r.original_url ||
              nextArchivedFromUrl !== r.archived_from_url ||
              nextDeletedFromUrl !== r.deleted_from_url;

            if (changed) {
              update.run([
                nextLocal,
                nextThumb,
                nextArchivedFrom,
                nextDeletedFrom,
                nextDeletedThumbFrom,
                nextOriginalUrl,
                nextArchivedFromUrl,
                nextDeletedFromUrl,
                r.id,
              ]);
            }
          }

          nextDb.close();

          // Re-open the active DB for the running process using the latest bootstrap.
          cfg = getDefaultConfig();
          layout = getFsLayout(cfg, { libraryRoot: cfg.libraryRootDir ?? toLibraryRoot });
          ensureFsLayout(layout);
          db = openDb(layout);
          migrate(db);

          logger.info('library root rename complete', {
            libraryRoot: toLibraryRoot,
            dataDir: layout.rootDir,
            health: `http://localhost:${cfg.port}/api/health`,
          });
        } else {
          // Rename didn't happen; reopen DB from the original layout.
          cfg = getDefaultConfig();
          layout = getFsLayout(cfg, { libraryRoot: cfg.libraryRootDir ?? normalized });
          ensureFsLayout(layout);
          db = openDb(layout);
          migrate(db);
        }
      }
    } catch (err) {
      logger.warn('library root rename skipped', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(
  cors({
    origin: true,
    credentials: false,
  }),
);

app.use('/api', createRouter({ db, layout, cfg }));

app.listen(cfg.port, () => {
  logger.info(`listening on http://localhost:${cfg.port}`);
  logger.info(`data dir: ${layout.rootDir}`);
});
