import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ServerConfig = {
  dataDir: string;
  port: number;
  maxConcurrentDownloads: number;
  requestTimeoutMs: number;
  userAgent: string;
  proxyUrl?: string;
};

export function getDefaultConfig(): ServerConfig {
  const envDataDir = process.env.XIC_DATA_DIR?.trim();
  const primaryDir = path.join(os.homedir(), '.clipnest');
  const legacyDir = path.join(os.homedir(), '.x-image-collector');
  const dataDir = envDataDir
    ? path.resolve(envDataDir)
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
    port: Number.isFinite(port) ? port : 5174,
    maxConcurrentDownloads: process.env.XIC_MAX_CONCURRENCY
      ? Math.max(1, Number(process.env.XIC_MAX_CONCURRENCY))
      : 12,
    requestTimeoutMs: process.env.XIC_TIMEOUT_MS ? Math.max(1_000, Number(process.env.XIC_TIMEOUT_MS)) : 30_000,
    userAgent: process.env.XIC_UA ?? 'clipnest/0.1 (local-first; no-x-api; contact: none)',
    proxyUrl,
  };
}
