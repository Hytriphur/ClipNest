import fs from 'node:fs';
import path from 'node:path';
import type { ServerConfig } from './config.js';

export type FsLayout = {
  rootDir: string;
  dbPath: string;
  mediaDir: string;
  thumbsDir: string;
  trashDir: string;
  trashMediaDir: string;
  trashThumbsDir: string;
};

export function getFsLayout(cfg: ServerConfig, opts?: { libraryRoot?: string | null }): FsLayout {
  const libraryRoot = opts?.libraryRoot?.trim() ? path.resolve(opts.libraryRoot.trim()) : null;
  const mediaDir = libraryRoot ? path.join(libraryRoot, '_unarchived') : path.join(cfg.dataDir, 'media');
  return {
    rootDir: cfg.dataDir,
    dbPath: path.join(cfg.dataDir, 'db.sqlite'),
    mediaDir,
    thumbsDir: path.join(cfg.dataDir, 'thumbs'),
    trashDir: path.join(cfg.dataDir, 'trash'),
    trashMediaDir: path.join(cfg.dataDir, 'trash', 'media'),
    trashThumbsDir: path.join(cfg.dataDir, 'trash', 'thumbs'),
  };
}

export function ensureFsLayout(layout: FsLayout) {
  fs.mkdirSync(layout.rootDir, { recursive: true });
  fs.mkdirSync(layout.mediaDir, { recursive: true });
  fs.mkdirSync(layout.thumbsDir, { recursive: true });
  fs.mkdirSync(layout.trashDir, { recursive: true });
  fs.mkdirSync(layout.trashMediaDir, { recursive: true });
  fs.mkdirSync(layout.trashThumbsDir, { recursive: true });
}
