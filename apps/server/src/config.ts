import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ServerConfig = {
  dataDir: string;
  libraryRootDir?: string;
  port: number;
  maxConcurrentDownloads: number;
  requestTimeoutMs: number;
  userAgent: string;
  proxyUrl?: string;
};

type PersistedDataLocation = {
  dataDir?: string | null;
  libraryRoot?: string | null;
};

function getDataLocationConfigPath() {
  return path.join(os.homedir(), '.clipnest-bootstrap.json');
}

function readPersistedDataLocation(): PersistedDataLocation | null {
  const configPath = getDataLocationConfigPath();
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as PersistedDataLocation;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writePersistedDataLocation(input: PersistedDataLocation) {
  const configPath = getDataLocationConfigPath();
  const prev = readPersistedDataLocation() ?? {};
  const next: PersistedDataLocation = { ...prev };

  // Merge update: callers often update only one field (e.g. libraryRoot) and should not wipe the other (dataDir).
  if (Object.prototype.hasOwnProperty.call(input, 'dataDir')) {
    const v = input.dataDir;
    if (typeof v === 'string' && v.trim()) next.dataDir = path.resolve(v.trim());
    else delete next.dataDir;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'libraryRoot')) {
    const v = input.libraryRoot;
    if (typeof v === 'string' && v.trim()) next.libraryRoot = path.resolve(v.trim());
    else delete next.libraryRoot;
  }

  fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8');
}

export function getManagedDataDirForLibraryRoot(libraryRoot: string) {
  return path.join(path.resolve(libraryRoot), '.clipnest');
}

export function getDefaultConfig(): ServerConfig {
  const envDataDir = process.env.XIC_DATA_DIR?.trim();
  const persisted = readPersistedDataLocation();
  const primaryDir = path.join(os.homedir(), '.clipnest');
  const legacyDir = path.join(os.homedir(), '.x-image-collector');
  const dataDir = envDataDir
    ? path.resolve(envDataDir)
    : persisted?.dataDir?.trim()
      ? path.resolve(persisted.dataDir.trim())
    : fs.existsSync(primaryDir)
      ? primaryDir
      : fs.existsSync(legacyDir)
        ? legacyDir
        : primaryDir;

  const port = process.env.PORT ? Number(process.env.PORT) : 5174;
  const envProxy = process.env.XIC_PROXY?.trim();
  const envProxyLower = envProxy?.toLowerCase();
  const disabledByEnv =
    envProxyLower === 'off' || envProxyLower === 'none' || envProxyLower === 'disable' || envProxyLower === 'disabled';
  const proxyUrl = disabledByEnv
    ? undefined
    : envProxy ||
      process.env.HTTPS_PROXY?.trim() ||
      process.env.HTTP_PROXY?.trim() ||
      'http://127.0.0.1:7890';

  return {
    dataDir,
    libraryRootDir: persisted?.libraryRoot?.trim() ? path.resolve(persisted.libraryRoot.trim()) : undefined,
    port: Number.isFinite(port) ? port : 5174,
    maxConcurrentDownloads: process.env.XIC_MAX_CONCURRENCY
      ? Math.max(1, Number(process.env.XIC_MAX_CONCURRENCY))
      : 12,
    requestTimeoutMs: process.env.XIC_TIMEOUT_MS ? Math.max(1_000, Number(process.env.XIC_TIMEOUT_MS)) : 30_000,
    userAgent: process.env.XIC_UA ?? 'clipnest/0.1 (local-first; no-x-api; contact: none)',
    proxyUrl,
  };
}
