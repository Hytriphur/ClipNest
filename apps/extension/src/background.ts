import pLimit from 'p-limit';
import type { IngestItem } from './lib/types';
import { loadSettings } from './lib/storage';

type AutoState = {
  running: boolean;
  runId: string | null;
};

type RecentVideo = {
  url: string;
  ts: number;
};

type PixivMeta = {
  artworkId: string;
  artworkUrl: string;
  title?: string;
  authorHandle?: string;
  tags: string[];
  pageCount: number;
  originalUrl?: string;
  illustType?: number;
};

const state: AutoState = {
  running: false,
  runId: null,
};

const pixivMetaCache = new Map<string, PixivMeta>();
const recentVideoByTab = new Map<number, RecentVideo[]>();
const keepAlivePorts = new Set<chrome.runtime.Port>();
const portByClientId = new Map<string, chrome.runtime.Port>();
const clientIdsByPort = new Map<chrome.runtime.Port, Set<string>>();
const tabByClientId = new Map<string, number>();
const tabIdByPort = new Map<chrome.runtime.Port, number>();
type CachedProgress = { event: string; data: any; ts: number };
const progressByClientId = new Map<string, CachedProgress>();
const PROGRESS_CACHE_TTL_MS = 5 * 60 * 1000;
const activeStreams = new Map<string, Promise<void>>();
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let lastActiveTabId: number | null = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'xic-ingest') return;
  keepAlivePorts.add(port);
  const tabId = port.sender?.tab?.id;
  if (typeof tabId === 'number' && tabId >= 0) {
    tabIdByPort.set(port, tabId);
  }
  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'XIC_REGISTER_CLIENTS' && Array.isArray(msg.clientIds)) {
      registerClientIds(port, msg.clientIds.map((id: any) => String(id ?? '')).filter(Boolean));
      return;
    }
    if (msg.type === 'XIC_INGEST_ITEMS_STREAM') {
      void startStreamFromPort(port, msg);
    }
  });
  port.onDisconnect.addListener(() => {
    cleanupPort(port);
  });
});

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isXVideoCandidateUrl(url: string): boolean {
  if (!url.includes('video.twimg.com')) return false;
  if (!/\.m3u8(\?|$)/i.test(url) && !/\.mp4(\?|$)/i.test(url)) return false;
  if (/\.(m4s|ts)(\?|$)/i.test(url)) return false;
  return true;
}

function rememberRecentVideo(tabId: number, url: string) {
  const now = Date.now();
  const list = recentVideoByTab.get(tabId) ?? [];
  if (!list.find((item) => item.url === url)) list.push({ url, ts: now });
  const fresh = list.filter((item) => now - item.ts < 90_000).slice(-40);
  recentVideoByTab.set(tabId, fresh);
}

function getRecentVideoUrls(tabId: number): string[] {
  const now = Date.now();
  const list = recentVideoByTab.get(tabId) ?? [];
  const fresh = list.filter((item) => now - item.ts < 90_000);
  recentVideoByTab.set(tabId, fresh);
  return fresh.map((item) => item.url);
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const tabId = details.tabId ?? -1;
    if (tabId < 0) return;
    const url = details.url ?? '';
    if (!isXVideoCandidateUrl(url)) return;
    rememberRecentVideo(tabId, url);
  },
  { urls: ['https://video.twimg.com/*'] },
);

function isPixivItem(item: IngestItem): boolean {
  if (item.context?.site === 'pixiv') return true;
  const hay = `${item.sourcePageUrl ?? ''} ${item.mediaUrl ?? ''}`.toLowerCase();
  return hay.includes('pixiv.net') || hay.includes('pximg.net');
}

function extractPixivArtworkId(value?: string | null): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    const match = u.pathname.match(/artworks\/(\d+)/);
    if (match?.[1]) return match[1];
  } catch {
    const m = String(value).match(/artworks\/(\d+)/);
    if (m?.[1]) return m[1];
  }
  return null;
}

function extractPixivPageIndex(url: string): number | null {
  const match = url.match(/_p(\d+)/);
  if (!match?.[1]) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function mergeTags(base?: string[] | null, extra?: string[] | null): string[] {
  const out: string[] = [];
  const add = (value?: string | null) => {
    if (!value) return;
    const v = value.trim();
    if (!v) return;
    if (!out.includes(v)) out.push(v);
  };
  if (Array.isArray(base)) base.forEach((t) => add(String(t)));
  if (Array.isArray(extra)) extra.forEach((t) => add(String(t)));
  return out.slice(0, 40);
}

async function fetchPixivJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`pixiv HTTP ${res.status}`);
  const data = (await res.json()) as any;
  if (data?.error) throw new Error(data?.message ?? 'pixiv error');
  return data?.body as T;
}

async function fetchPixivMeta(artworkId: string): Promise<PixivMeta | null> {
  try {
    const body = await fetchPixivJson<any>(`https://www.pixiv.net/ajax/illust/${artworkId}`);
    const tags = Array.isArray(body?.tags?.tags) ? body.tags.tags.map((t: any) => String(t?.tag ?? '')) : [];
    const authorHandle = body?.userName ? String(body.userName) : undefined;
    const pageCount = Number(body?.pageCount ?? 1);
    const originalUrl = body?.urls?.original ? String(body.urls.original) : undefined;
    const title = body?.title ? String(body.title) : undefined;
    const illustType = body?.illustType ? Number(body.illustType) : undefined;
    const artworkUrl = `https://www.pixiv.net/artworks/${artworkId}`;
    return {
      artworkId,
      artworkUrl,
      title,
      authorHandle,
      tags: tags.filter(Boolean),
      pageCount: Number.isFinite(pageCount) && pageCount > 0 ? pageCount : 1,
      originalUrl,
      illustType,
    };
  } catch {
    return null;
  }
}

async function ensurePixivMeta(artworkId: string): Promise<PixivMeta | null> {
  const cached = pixivMetaCache.get(artworkId);
  if (cached) return cached;
  const meta = await fetchPixivMeta(artworkId);
  if (meta) pixivMetaCache.set(artworkId, meta);
  return meta;
}

async function fetchPixivPages(artworkId: string): Promise<string[]> {
  try {
    const body = await fetchPixivJson<any[]>(`https://www.pixiv.net/ajax/illust/${artworkId}/pages`);
    if (!Array.isArray(body)) return [];
    return body
      .map((page) => String(page?.urls?.original ?? ''))
      .map((url) => url.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function enrichPixivItems(items: IngestItem[]): Promise<IngestItem[]> {
  const grouped = new Map<string, IngestItem[]>();
  const passthrough: IngestItem[] = [];

  for (const item of items) {
    if (!isPixivItem(item)) {
      passthrough.push(item);
      continue;
    }
    const artworkId =
      extractPixivArtworkId(item.context?.artworkUrl ?? '') ??
      extractPixivArtworkId(item.sourcePageUrl ?? '') ??
      extractPixivArtworkId(item.mediaUrl ?? '');
    if (!artworkId) {
      passthrough.push(item);
      continue;
    }
    if (!grouped.has(artworkId)) grouped.set(artworkId, []);
    grouped.get(artworkId)!.push(item);
  }

  const enriched: IngestItem[] = [...passthrough];
  for (const [artworkId, group] of grouped) {
    const meta = await ensurePixivMeta(artworkId);
    for (const item of group) {
      const pageIndex = item.mediaUrl ? extractPixivPageIndex(item.mediaUrl) : null;
      const canReplace = item.mediaType === 'image' && (pageIndex === null || pageIndex === 0);
      const mediaUrl = meta?.originalUrl && canReplace ? meta.originalUrl : item.mediaUrl;
      const tags = mergeTags(item.context?.tags, meta?.tags);
      const artworkUrl = item.context?.artworkUrl ?? meta?.artworkUrl;
      const sourcePageUrl = artworkUrl ?? item.sourcePageUrl;
      const context = {
        ...(item.context ?? {}),
        site: 'pixiv' as const,
        tags,
        artworkUrl,
        referer: artworkUrl ?? item.context?.referer,
        pageTitle: item.context?.pageTitle ?? meta?.title,
      };
      enriched.push({
        ...item,
        mediaUrl,
        sourcePageUrl,
        authorHandle: item.authorHandle ?? meta?.authorHandle,
        context,
      });
    }
  }

  return enriched;
}

async function buildPixivItemsForArtwork(artworkUrl: string): Promise<IngestItem[]> {
  const artworkId = extractPixivArtworkId(artworkUrl);
  if (!artworkId) return [];
  const meta = await ensurePixivMeta(artworkId);
  if (!meta) return [];
  const pageUrls = await fetchPixivPages(artworkId);
  const urls = pageUrls.length ? pageUrls : meta.originalUrl ? [meta.originalUrl] : [];
  const collectedAt = new Date().toISOString();
  return urls.map((url) => ({
    sourcePageUrl: meta.artworkUrl,
    authorHandle: meta.authorHandle,
    mediaUrl: url,
    mediaType: 'image' as const,
    collectedAt,
    context: {
      site: 'pixiv',
      referer: meta.artworkUrl,
      pageTitle: meta.title,
      tags: meta.tags,
      artworkUrl: meta.artworkUrl,
    },
  }));
}

async function pingServer(serverUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/api/health`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

async function ingest(serverUrl: string, items: IngestItem[]) {
  const enrichedItems = await enrichPixivItems(items);
  const res = await fetch(`${serverUrl}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: enrichedItems }),
  });
  if (!res.ok) throw new Error(`server ingest failed: HTTP ${res.status}`);
  return (await res.json()) as any;
}

function deriveDisplayName(url: string): string {
  try {
    const u = new URL(url);
    const base = u.pathname.split('/').filter(Boolean).pop();
    if (base) return decodeURIComponent(base);
  } catch {
    // ignore
  }
  const fallback = url.split('/').filter(Boolean).pop();
  return fallback || 'media';
}

function attachClientMeta(items: IngestItem[], requestId: string) {
  const metaById = new Map<string, { displayName: string }>();
  const withMeta = items.map((item, index) => {
    const existingId = typeof item.context?.clientId === 'string' ? item.context.clientId.trim() : '';
    const clientId = existingId || `${requestId}-${index + 1}`;
    const existingName = typeof item.context?.displayName === 'string' ? item.context.displayName.trim() : '';
    const displayName = existingName || deriveDisplayName(item.mediaUrl);
    metaById.set(clientId, { displayName });
    const context = { ...(item.context ?? {}), clientId, displayName };
    return { ...item, context };
  });
  return { items: withMeta, metaById };
}

function sendProgressToTab(tabId: number | undefined, event: string, data: any): boolean {
  if (!tabId || tabId < 0) return false;
  try {
    const p = chrome.tabs.sendMessage(tabId, { type: 'XIC_INGEST_PROGRESS', event, data });
    if (p && typeof (p as Promise<unknown>).catch === 'function') {
      void (p as Promise<unknown>).catch(() => {
        // Ignore when a tab has no matching content script.
      });
    }
    return true;
  } catch {
    return false;
  }
}

function broadcastProgress(event: string, data: any) {
  if (!keepAlivePorts.size) return;
  for (const port of keepAlivePorts) {
    try {
      port.postMessage({ type: 'XIC_INGEST_PROGRESS', event, data });
    } catch {
      // ignore
    }
  }
}

function broadcastRuntimeProgress(event: string, data: any) {
  try {
    const p = chrome.runtime.sendMessage({ type: 'XIC_INGEST_PROGRESS', event, data });
    if (p && typeof (p as Promise<unknown>).catch === 'function') {
      void (p as Promise<unknown>).catch(() => {
        // ignore when no listeners exist
      });
    }
  } catch {
    // ignore
  }
}

function pruneProgressCache() {
  if (!progressByClientId.size) return;
  const now = Date.now();
  for (const [id, entry] of progressByClientId.entries()) {
    if (now - entry.ts > PROGRESS_CACHE_TTL_MS) {
      progressByClientId.delete(id);
    }
  }
}

function cacheProgress(clientId: string, event: string, data: any) {
  if (!clientId) return;
  progressByClientId.set(clientId, { event, data, ts: Date.now() });
  pruneProgressCache();
}

function replayCachedProgress(port: chrome.runtime.Port, clientIds: string[]) {
  if (!clientIds.length) return;
  pruneProgressCache();
  for (const id of clientIds) {
    const cached = progressByClientId.get(id);
    if (!cached) continue;
    try {
      port.postMessage({ type: 'XIC_INGEST_PROGRESS', event: cached.event, data: cached.data });
    } catch {
      // ignore
    }
  }
}

function registerClientIds(port: chrome.runtime.Port, clientIds: string[]) {
  if (!clientIds.length) return;
  let set = clientIdsByPort.get(port);
  if (!set) {
    set = new Set<string>();
    clientIdsByPort.set(port, set);
  }
  const tabId = tabIdByPort.get(port);
  for (const id of clientIds) {
    if (!id) continue;
    set.add(id);
    portByClientId.set(id, port);
    if (typeof tabId === 'number' && tabId >= 0) {
      tabByClientId.set(id, tabId);
    }
  }
  replayCachedProgress(port, clientIds);
}

function cleanupPort(port: chrome.runtime.Port) {
  keepAlivePorts.delete(port);
  tabIdByPort.delete(port);
  const ids = clientIdsByPort.get(port);
  if (ids) {
    for (const id of ids) {
      if (portByClientId.get(id) === port) {
        portByClientId.delete(id);
      }
      if (tabByClientId.get(id)) {
        tabByClientId.delete(id);
      }
    }
  }
  clientIdsByPort.delete(port);
}

async function startStreamFromPort(port: chrome.runtime.Port, msg: any) {
  const items = (msg?.items ?? []) as IngestItem[];
  if (!items.length) {
    try {
      port.postMessage({ type: 'XIC_INGEST_PROGRESS', event: 'error', data: { error: 'no items' } });
    } catch {
      // ignore
    }
    return;
  }

  const settings = await loadSettings();
  const explicitTabId = Number.isFinite(msg?.tabId) ? Number(msg.tabId) : undefined;
  const tabId = typeof explicitTabId === 'number' ? explicitTabId : tabIdByPort.get(port);
  if (typeof tabId === 'number' && tabId >= 0) {
    lastActiveTabId = tabId;
  }

  const clientIds = items
    .map((item) => (typeof item?.context?.clientId === 'string' ? item.context.clientId.trim() : ''))
    .filter(Boolean);
  if (clientIds.length) {
    registerClientIds(port, clientIds);
  }

  try {
    await ingestStream(settings.serverUrl, items, tabId);
  } catch {
    // ingestStream already reports error via dispatchProgress
  }
}

function sendProgressToClient(clientId: string | undefined, event: string, data: any): boolean {
  if (!clientId) return false;
  const port = portByClientId.get(clientId);
  if (!port) return false;
  try {
    port.postMessage({ type: 'XIC_INGEST_PROGRESS', event, data });
    return true;
  } catch {
    return false;
  }
}

function dispatchProgress(tabId: number | undefined, event: string, data: any) {
  const payload =
    event === 'progress' && data && typeof data === 'object' ? { ...data, ts: Date.now() } : data;
  const clientId = typeof payload?.clientId === 'string' ? payload.clientId : undefined;
  const stage = typeof payload?.stage === 'string' ? payload.stage : '';
  const mappedTabId =
    typeof tabId === 'number' && tabId >= 0 ? tabId : clientId ? tabByClientId.get(clientId) : undefined;
  if (typeof mappedTabId === 'number' && mappedTabId >= 0) {
    lastActiveTabId = mappedTabId;
  }
  const fallbackTabId =
    mappedTabId ??
    (keepAlivePorts.size === 0 && typeof lastActiveTabId === 'number' && lastActiveTabId >= 0
      ? lastActiveTabId
      : undefined);
  if (clientId && event === 'progress') {
    cacheProgress(clientId, event, payload);
  }
  sendProgressToClient(clientId, event, payload);
  sendProgressToTab(fallbackTabId, event, payload);
  broadcastProgress(event, payload);
  broadcastRuntimeProgress(event, payload);
  if (clientId && (stage === 'created' || stage === 'exists' || stage === 'failed')) {
    tabByClientId.delete(clientId);
  }
}

function ensureStreamKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    // No-op heartbeat to keep the MV3 service worker alive during SSE.
  }, 20000);
}

function stopStreamKeepAliveIfIdle() {
  if (activeStreams.size > 0) return;
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: any) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let dataLines: string[] = [];

  const flush = () => {
    if (!dataLines.length) return;
    const raw = dataLines.join('\n');
    dataLines = [];
    let payload: any = raw;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { raw };
    }
    onEvent(eventName, payload);
    eventName = 'message';
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      flush();
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line) {
        flush();
      } else if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
      idx = buffer.indexOf('\n');
    }
  }
}

async function ingestStream(serverUrl: string, items: IngestItem[], tabId?: number): Promise<number> {
  const enrichedItems = await enrichPixivItems(items);
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const { items: payloadItems, metaById } = attachClientMeta(enrichedItems, requestId);
  for (const item of payloadItems) {
    const clientId = item.context?.clientId;
    if (!clientId) continue;
    if (typeof tabId === 'number' && tabId >= 0) {
      tabByClientId.set(clientId, tabId);
    }
    dispatchProgress(tabId, 'progress', {
      clientId,
      stage: 'queued',
      url: item.mediaUrl,
      mediaType: item.mediaType,
      displayName: metaById.get(clientId)?.displayName ?? item.context?.displayName,
    });
  }

  let res: Response;
  try {
    res = await fetch(`${serverUrl}/api/ingest/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: payloadItems }),
    });
  } catch (err) {
    for (const item of payloadItems) {
      const clientId = item.context?.clientId;
      if (!clientId) continue;
      dispatchProgress(tabId, 'progress', {
        clientId,
        stage: 'failed',
        url: item.mediaUrl,
        mediaType: item.mediaType,
        displayName: metaById.get(clientId)?.displayName ?? item.context?.displayName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }
  if (!res.ok || !res.body) {
    const err = new Error(`server ingest failed: HTTP ${res.status}`);
    for (const item of payloadItems) {
      const clientId = item.context?.clientId;
      if (!clientId) continue;
      dispatchProgress(tabId, 'progress', {
        clientId,
        stage: 'failed',
        url: item.mediaUrl,
        mediaType: item.mediaType,
        displayName: metaById.get(clientId)?.displayName ?? item.context?.displayName,
        error: err.message,
      });
    }
    throw err;
  }

  const streamId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const streamPromise = consumeSseStream(res.body, (event, data) => {
    const clientId = data?.clientId;
    if (clientId && metaById.has(clientId) && !data.displayName) {
      data.displayName = metaById.get(clientId)?.displayName;
    }
    dispatchProgress(tabId, event, data);
  })
    .catch((err) => {
      dispatchProgress(tabId, 'error', { error: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => {
      activeStreams.delete(streamId);
      stopStreamKeepAliveIfIdle();
    });
  activeStreams.set(streamId, streamPromise);
  ensureStreamKeepAlive();

  return payloadItems.length;
}

function summarizeIngest(out: any, total: number) {
  const results = Array.isArray(out?.results) ? out.results : [];
  if (!results.length) {
    return {
      ok: true,
      count: total,
      okCount: total,
      failedCount: 0,
      createdCount: 0,
      existsCount: 0,
    };
  }
  const failed = results.filter((r: any) => r?.ok === false || r?.status === 'failed');
  const createdCount = results.filter((r: any) => r?.status === 'created').length;
  const existsCount = results.filter((r: any) => r?.status === 'exists').length;
  const okCount = results.length - failed.length;
  const error = failed[0]?.error;
  return {
    ok: failed.length === 0,
    count: total,
    okCount,
    failedCount: failed.length,
    createdCount,
    existsCount,
    error: failed.length ? error ?? 'some items failed' : undefined,
  };
}

async function extractFromTab(tabId: number): Promise<IngestItem[]> {
  const r = await chrome.tabs.sendMessage(tabId, { type: 'XIC_EXTRACT' });
  if (!r?.ok) throw new Error(r?.error ?? 'extract failed');
  return (r.items ?? []) as IngestItem[];
}

async function scrollTab(tabId: number) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.scrollBy(0, Math.floor(window.innerHeight * 0.92)),
  });
}

async function waitForTabComplete(tabId: number, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await sleep(250);
  }
  throw new Error('tab load timeout');
}

async function runAutoTargets() {
  const settings = await loadSettings();
  const serverUrl = settings.serverUrl;
  const ok = await pingServer(serverUrl);
  if (!ok) throw new Error(`server not reachable at ${serverUrl}`);

  const runId = String(Date.now());
  state.running = true;
  state.runId = runId;

  const limit = pLimit(2);
  const submitted = new Set<string>(); // extension-side URL memory for this run

  for (const targetUrl of settings.targets) {
    if (!state.running || state.runId !== runId) break;
    if (!targetUrl.trim()) continue;

    const tab = await chrome.tabs.create({ url: targetUrl.trim(), active: false });
    if (!tab.id) continue;

    try {
      await waitForTabComplete(tab.id, 25_000);

      for (let step = 0; step < settings.maxScrolls; step++) {
        if (!state.running || state.runId !== runId) break;

        let items: IngestItem[] = [];
        try {
          items = await extractFromTab(tab.id);
        } catch {
          // Content script might not be ready yet.
          await sleep(500);
          continue;
        }

        const fresh = items.filter((it) => {
          if (submitted.has(it.mediaUrl)) return false;
          submitted.add(it.mediaUrl);
          return true;
        });

        if (fresh.length) {
          await limit(() => ingest(serverUrl, fresh));
        }

        await scrollTab(tab.id);
        await sleep(settings.stepDelayMs);
      }
    } finally {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        // ignore
      }
    }
  }

  state.running = false;
  state.runId = null;
}

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (msg?.type === 'XIC_INGEST_PROGRESS') {
        sendResponse({ ok: true });
        return;
      }
    if (msg?.type === 'XIC_GET_PROGRESS') {
      const ids = Array.isArray(msg?.clientIds) ? msg.clientIds.map((id: any) => String(id ?? '')).filter(Boolean) : [];
      const items: Array<CachedProgress & { clientId: string }> = [];
      if (ids.length) {
        for (const id of ids) {
          const cached = progressByClientId.get(id);
          if (!cached) continue;
          items.push({ ...cached, clientId: id });
        }
      } else {
        for (const [id, cached] of progressByClientId.entries()) {
          items.push({ ...cached, clientId: id });
        }
      }
      sendResponse({ ok: true, items });
      return;
    }
    if (msg?.type === 'XIC_CLEAR_PROGRESS') {
      const ids = Array.isArray(msg?.clientIds) ? msg.clientIds.map((id: any) => String(id ?? '')).filter(Boolean) : [];
      for (const id of ids) {
        progressByClientId.delete(id);
        tabByClientId.delete(id);
      }
      sendResponse({ ok: true });
      return;
    }
    const settings = await loadSettings();
    if (msg?.type === 'XIC_GET_SERVER_PROGRESS') {
      const ids = Array.isArray(msg?.clientIds) ? msg.clientIds.map((id: any) => String(id ?? '')).filter(Boolean) : [];
      try {
        const qs = new URLSearchParams();
        if (ids.length) qs.set('clientIds', ids.join(','));
        const url = `${settings.serverUrl}/api/ingest/progress${qs.toString() ? `?${qs.toString()}` : ''}`;
        const res = await fetch(url, { method: 'GET' });
        if (!res.ok) {
          sendResponse({ ok: false, error: `server HTTP ${res.status}` });
          return;
        }
        const data = (await res.json()) as any;
        const items = Array.isArray(data?.items) ? data.items : [];
        sendResponse({ ok: true, items });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (msg?.type === 'XIC_CLEAR_SERVER_PROGRESS') {
      const ids = Array.isArray(msg?.clientIds) ? msg.clientIds.map((id: any) => String(id ?? '')).filter(Boolean) : [];
      try {
        const res = await fetch(`${settings.serverUrl}/api/ingest/progress/clear`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientIds: ids }),
        });
        if (!res.ok) {
          sendResponse({ ok: false, error: `server HTTP ${res.status}` });
          return;
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (msg?.type === 'XIC_GET_RECENT_VIDEO_URLS') {
      const tabId = sender?.tab?.id ?? (Number.isFinite(msg?.tabId) ? Number(msg.tabId) : -1);
      if (!tabId || tabId < 0) {
        sendResponse({ ok: false, urls: [] });
        return;
      }
      sendResponse({ ok: true, urls: getRecentVideoUrls(tabId) });
      return;
    }
    if (msg?.type === 'XIC_PING') {
      const ok = await pingServer(settings.serverUrl);
      sendResponse({ ok, serverUrl: settings.serverUrl });
      return;
    }
    if (msg?.type === 'XIC_ENRICH_ITEMS') {
      const items = (msg.items ?? []) as IngestItem[];
      if (!items.length) {
        sendResponse({ ok: true, items: [] });
        return;
      }
      try {
        const enriched = await enrichPixivItems(items);
        sendResponse({ ok: true, items: enriched });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (msg?.type === 'XIC_PIXIV_BUILD_ITEMS') {
      const artworkUrl = String(msg.artworkUrl ?? '').trim();
      if (!artworkUrl) {
        sendResponse({ ok: false, error: 'missing artwork url', items: [] });
        return;
      }
      try {
        const items = await buildPixivItemsForArtwork(artworkUrl);
        if (!items.length) {
          sendResponse({ ok: false, error: 'pixiv metadata unavailable', items: [] });
          return;
        }
        sendResponse({ ok: true, items });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err), items: [] });
      }
      return;
    }
    if (msg?.type === 'XIC_INGEST_ITEMS') {
      const items = (msg.items ?? []) as IngestItem[];
      if (!items.length) {
        sendResponse({ ok: true, count: 0, okCount: 0, failedCount: 0, createdCount: 0, existsCount: 0 });
        return;
      }
      const out = await ingest(settings.serverUrl, items);
      const summary = summarizeIngest(out, items.length);
      sendResponse({ ...summary, out });
      return;
    }
    if (msg?.type === 'XIC_INGEST_ITEMS_STREAM') {
      const items = (msg.items ?? []) as IngestItem[];
      if (!items.length) {
        sendResponse({ ok: true, count: 0, queued: 0 });
        return;
      }
      const tabId = sender?.tab?.id ?? (Number.isFinite(msg?.tabId) ? Number(msg.tabId) : -1);
      if (typeof tabId === 'number' && tabId >= 0) lastActiveTabId = tabId;
      const count = await ingestStream(settings.serverUrl, items, tabId);
      sendResponse({ ok: true, count, queued: count });
      return;
    }
    if (msg?.type === 'XIC_PIXIV_SAVE_ALL') {
      const artworkUrl = String(msg.artworkUrl ?? '').trim();
      if (!artworkUrl) {
        sendResponse({ ok: false, error: 'missing artwork url', okCount: 0, failedCount: 1 });
        return;
      }
      const items = await buildPixivItemsForArtwork(artworkUrl);
      if (!items.length) {
        sendResponse({ ok: false, error: 'pixiv metadata unavailable', okCount: 0, failedCount: 1 });
        return;
      }
      const out = await ingest(settings.serverUrl, items);
      const summary = summarizeIngest(out, items.length);
      sendResponse({ ...summary, out });
      return;
    }
    if (msg?.type === 'XIC_PIXIV_SAVE_ALL_STREAM') {
      const artworkUrl = String(msg.artworkUrl ?? '').trim();
      if (!artworkUrl) {
        sendResponse({ ok: false, error: 'missing artwork url' });
        return;
      }
      const items = await buildPixivItemsForArtwork(artworkUrl);
      if (!items.length) {
        sendResponse({ ok: false, error: 'pixiv metadata unavailable' });
        return;
      }
      const tabId = sender?.tab?.id ?? (Number.isFinite(msg?.tabId) ? Number(msg.tabId) : -1);
      if (typeof tabId === 'number' && tabId >= 0) lastActiveTabId = tabId;
      const count = await ingestStream(settings.serverUrl, items, tabId);
      sendResponse({ ok: true, count, queued: count });
      return;
    }
    if (msg?.type === 'XIC_SAVE_PAGE') {
      const tabId = msg.tabId as number;
      const items = await extractFromTab(tabId);
      const out = await ingest(settings.serverUrl, items);
      const summary = summarizeIngest(out, items.length);
      sendResponse({ ...summary, out });
      return;
    }
    if (msg?.type === 'XIC_AUTO_START') {
      if (state.running) {
        sendResponse({ ok: false, error: 'auto already running' });
        return;
      }
      runAutoTargets()
        .then(() => void 0)
        .catch(() => void 0);
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'XIC_AUTO_STOP') {
      state.running = false;
      state.runId = null;
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: 'unknown message' });
  })().catch((e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true;
});
