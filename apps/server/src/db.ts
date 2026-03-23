import type { FsLayout } from './fs-layout.js';
import { createRequire } from 'node:module';

type BetterSqlite3Database = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(params?: any): any;
    get(params?: any): any;
    all(params?: any): any[];
  };
  pragma(sql: string): any;
};

export type Db = BetterSqlite3Database;

export function openDb(layout: FsLayout): Db {
  let mod: any;
  try {
    // Optional dependency to avoid hard install failures on some machines.
    // If this is missing, we throw a helpful error on startup.
    const require = createRequire(import.meta.url);
    mod = require('better-sqlite3');
  } catch (err) {
    const msg =
      'Missing optional dependency "better-sqlite3". ' +
      'Install it (may require native build tools) or adjust the server to use another SQLite driver.\n' +
      'Original error: ' +
      String(err);
    throw new Error(msg);
  }

  const Database = mod.default ?? mod;
  const db: Db = new Database(layout.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function migrate(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sha256 TEXT NOT NULL UNIQUE,
      phash TEXT,
      type TEXT NOT NULL CHECK(type IN ('image','video')),
      original_url TEXT NOT NULL,
      local_path TEXT NOT NULL,
      thumb_path TEXT,
      width INTEGER,
      height INTEGER,
      duration_ms INTEGER,
      created_at TEXT,
      saved_at TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'x',
      archived_at TEXT,
      archived_from_path TEXT,
      archived_from_url TEXT,
      deleted_at TEXT,
      deleted_from_path TEXT,
      deleted_from_url TEXT,
      deleted_thumb_from_path TEXT,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      rating INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS source (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tweet_url TEXT,
      source_page_url TEXT NOT NULL,
      author_handle TEXT,
      tweet_id TEXT,
      collected_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media_source (
      media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      source_id INTEGER NOT NULL REFERENCES source(id) ON DELETE CASCADE,
      PRIMARY KEY (media_id, source_id)
    );

    CREATE TABLE IF NOT EXISTS tag (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL DEFAULT 'manual'
    );

    CREATE TABLE IF NOT EXISTS media_tag (
      media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
      PRIMARY KEY (media_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS collection (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS media_collection (
      media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      collection_id INTEGER NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
      PRIMARY KEY (media_id, collection_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  ensureColumn(db, 'media', 'origin', `origin TEXT NOT NULL DEFAULT 'x'`);
  ensureColumn(db, 'media', 'archived_at', `archived_at TEXT`);
  ensureColumn(db, 'media', 'archived_from_path', `archived_from_path TEXT`);
  ensureColumn(db, 'media', 'archived_from_url', `archived_from_url TEXT`);
  ensureColumn(db, 'media', 'deleted_at', `deleted_at TEXT`);
  ensureColumn(db, 'media', 'deleted_from_path', `deleted_from_path TEXT`);
  ensureColumn(db, 'media', 'deleted_from_url', `deleted_from_url TEXT`);
  ensureColumn(db, 'media', 'deleted_thumb_from_path', `deleted_thumb_from_path TEXT`);
  ensureColumn(db, 'media', 'is_favorite', `is_favorite INTEGER NOT NULL DEFAULT 0`);
  ensureColumn(db, 'media', 'phash', `phash TEXT`);
  ensureColumn(db, 'media', 'rating', `rating INTEGER NOT NULL DEFAULT 0`);
  ensureColumn(db, 'tag', 'source', `source TEXT NOT NULL DEFAULT 'manual'`);
  db.exec(`UPDATE tag SET source = 'manual' WHERE source IS NULL OR source = ''`);
}

function ensureColumn(db: Db, table: string, column: string, ddl: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const hasColumn = rows.some((r) => r.name === column);
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
