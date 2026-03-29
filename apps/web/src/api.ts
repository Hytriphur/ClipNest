export type MediaTypeFilter = 'all' | 'image' | 'video';

export type MediaSource = {
  tweetUrl: string | null;
  sourcePageUrl: string;
  authorHandle: string | null;
  collectedAt: string;
};

export type CollectionItem = {
  id: number;
  name: string;
};

export type TagItem = {
  id: number;
  name: string;
  usage: number;
};

export type TimelineDay = {
  day: string;
  count: number;
};

export type MediaItem = {
  id: number;
  sha256: string;
  type: 'image' | 'video';
  originalUrl: string;
  width: number | null;
  height: number | null;
  savedAt: string;
  origin: 'x' | 'local';
  archivedAt: string | null;
  deletedAt: string | null;
  favorite: boolean;
  rating: number;
  fileUrl: string;
  thumbUrl: string | null;
  sources: MediaSource[];
  tags: string[];
  collections: string[];
};

const DEFAULT_API_ORIGIN = 'http://localhost:5174';

function resolveApiOrigin() {
  const configured = import.meta.env.VITE_API_BASE?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  if (typeof window !== 'undefined') {
    const { hostname, origin, protocol } = window.location;
    if ((protocol === 'http:' || protocol === 'https:') && (hostname === 'localhost' || hostname === '127.0.0.1')) {
      if (window.location.port === '5174') {
        return origin;
      }
      return `${protocol}//${hostname}:5174`;
    }
  }
  return DEFAULT_API_ORIGIN;
}

const API_ORIGIN = resolveApiOrigin();

function apiUrl(path: string) {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  return `${API_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`;
}

function normalizeMediaItem(item: MediaItem): MediaItem {
  return {
    ...item,
    fileUrl: apiUrl(item.fileUrl),
    thumbUrl: item.thumbUrl ? apiUrl(item.thumbUrl) : null,
  };
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: unknown };
      if (data?.error) {
        if (typeof data.error === 'string') {
          message = data.error;
        } else {
          message = JSON.stringify(data.error);
        }
      }
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export async function fetchMedia(opts: {
  offset: number;
  limit: number;
  type: MediaTypeFilter;
  q: string;
  authorHandle?: string;
  tag?: string;
  tagPresence?: 'tagged' | 'untagged';
  collection?: string;
  from?: string;
  to?: string;
  archived?: 'all' | 'yes' | 'no';
  deleted?: 'all' | 'yes' | 'no';
  favorite?: boolean;
}): Promise<{ items: MediaItem[]; nextOffset: number; totalCount: number | null }> {
  const params = new URLSearchParams();
  params.set('offset', String(opts.offset));
  params.set('limit', String(opts.limit));
  if (opts.type !== 'all') params.set('type', opts.type);
  if (opts.q.trim()) params.set('q', opts.q.trim());
  if (opts.authorHandle?.trim()) params.set('authorHandle', opts.authorHandle.trim());
  if (opts.tag?.trim()) params.set('tag', opts.tag.trim());
  if (opts.tagPresence) params.set('tagPresence', opts.tagPresence);
  if (opts.collection?.trim()) params.set('collection', opts.collection.trim());
  if (opts.from?.trim()) params.set('from', opts.from.trim());
  if (opts.to?.trim()) params.set('to', opts.to.trim());
  if (opts.archived && opts.archived !== 'all') params.set('archived', opts.archived);
  if (opts.deleted && opts.deleted !== 'all') params.set('deleted', opts.deleted);
  if (opts.favorite) params.set('favorite', '1');
  const r = await apiGet<{ ok: true; items: MediaItem[]; nextOffset: number; totalCount?: number }>(
    `/api/media?${params}`,
  );
  return {
    items: (r.items ?? []).map(normalizeMediaItem),
    nextOffset: r.nextOffset,
    totalCount: typeof r.totalCount === 'number' ? r.totalCount : null,
  };
}

export async function fetchTimelineDays(opts: {
  offset: number;
  limit: number;
  type: MediaTypeFilter;
  q: string;
  authorHandle?: string;
  tag?: string;
  tagPresence?: 'tagged' | 'untagged';
  collection?: string;
  from?: string;
  to?: string;
  archived?: 'all' | 'yes' | 'no';
  deleted?: 'all' | 'yes' | 'no';
  favorite?: boolean;
}): Promise<{ items: TimelineDay[]; totalCount: number | null }> {
  const params = new URLSearchParams();
  params.set('offset', String(opts.offset));
  params.set('limit', String(opts.limit));
  if (opts.type !== 'all') params.set('type', opts.type);
  if (opts.q.trim()) params.set('q', opts.q.trim());
  if (opts.authorHandle?.trim()) params.set('authorHandle', opts.authorHandle.trim());
  if (opts.tag?.trim()) params.set('tag', opts.tag.trim());
  if (opts.tagPresence) params.set('tagPresence', opts.tagPresence);
  if (opts.collection?.trim()) params.set('collection', opts.collection.trim());
  if (opts.from?.trim()) params.set('from', opts.from.trim());
  if (opts.to?.trim()) params.set('to', opts.to.trim());
  if (opts.archived && opts.archived !== 'all') params.set('archived', opts.archived);
  if (opts.deleted && opts.deleted !== 'all') params.set('deleted', opts.deleted);
  if (opts.favorite) params.set('favorite', '1');
  const r = await apiGet<{ ok: true; items: TimelineDay[]; totalCount?: number }>(`/api/media/days?${params}`);
  return { items: r.items ?? [], totalCount: typeof r.totalCount === 'number' ? r.totalCount : null };
}

export async function fetchStats(): Promise<{ mediaCount: number; sourceCount: number }> {
  const r = await apiGet<{ ok: true; mediaCount: number; sourceCount: number }>(`/api/stats`);
  return { mediaCount: r.mediaCount, sourceCount: r.sourceCount };
}

export async function addTag(mediaId: number, name: string) {
  return apiPost(`/api/media/${mediaId}/tag`, { name });
}

export async function removeTag(mediaId: number, name: string) {
  return apiPost(`/api/media/${mediaId}/untag`, { name });
}

export async function addCollection(mediaId: number, name: string) {
  return apiPost(`/api/media/${mediaId}/collect`, { name });
}

export async function removeCollection(mediaId: number, name: string) {
  return apiPost(`/api/media/${mediaId}/uncollect`, { name });
}

export async function unarchiveMedia(mediaId: number) {
  return apiPost(`/api/media/${mediaId}/unarchive`, {});
}

export async function favoriteMedia(mediaId: number) {
  return apiPost(`/api/media/${mediaId}/favorite`, {});
}

export async function unfavoriteMedia(mediaId: number) {
  return apiPost(`/api/media/${mediaId}/unfavorite`, {});
}

export async function deleteMedia(mediaId: number) {
  return apiPost(`/api/media/${mediaId}/delete`, {});
}

export async function undeleteMedia(mediaId: number) {
  return apiPost(`/api/media/${mediaId}/undelete`, {});
}

export async function purgeMedia(mediaId: number) {
  return apiPost(`/api/media/${mediaId}/purge`, {});
}

export async function rateMedia(mediaId: number, rating: number) {
  return apiPost(`/api/media/${mediaId}/rate`, { rating });
}

export async function fetchCollections(): Promise<CollectionItem[]> {
  const r = await apiGet<{ ok: true; items: CollectionItem[] }>(`/api/collections`);
  return r.items ?? [];
}

export async function fetchTags(input?: {
  popular?: boolean;
  limit?: number;
  includeAuto?: boolean;
}): Promise<TagItem[]> {
  const params = new URLSearchParams();
  if (input?.popular) params.set('popular', '1');
  if (input?.limit) params.set('limit', String(input.limit));
  if (input?.includeAuto) params.set('includeAuto', '1');
  const qs = params.toString();
  const r = await apiGet<{ ok: true; items: TagItem[] }>(`/api/tags${qs ? `?${qs}` : ''}`);
  return r.items ?? [];
}

export async function createCollection(name: string) {
  return apiPost<{ ok: true; item: CollectionItem }>(`/api/collections`, { name });
}

export async function importLocalFolder(input: { path: string; recursive?: boolean }) {
  return apiPost<{ ok: true; summary: { total: number; created: number; exists: number; failed: number } }>(
    `/api/local/import`,
    input,
  );
}

export async function fetchSettings(): Promise<{
  libraryRoot: string | null;
  archiveTemplate: string | null;
  trashRetentionDays: number;
  trashAutoCleanupEnabled: boolean;
}> {
  const r = await apiGet<{
    ok: true;
    libraryRoot: string | null;
    archiveTemplate?: string | null;
    trashRetentionDays?: number | null;
    trashAutoCleanupEnabled?: boolean | null;
  }>(`/api/settings`);
  return {
    libraryRoot: r.libraryRoot ?? null,
    archiveTemplate: r.archiveTemplate ?? null,
    trashRetentionDays: typeof r.trashRetentionDays === 'number' ? r.trashRetentionDays : 30,
    trashAutoCleanupEnabled: r.trashAutoCleanupEnabled ?? true,
  };
}

export async function saveSettings(input: {
  libraryRoot?: string | null;
  archiveTemplate?: string | null;
  trashRetentionDays?: number | null;
  trashAutoCleanupEnabled?: boolean | null;
}) {
  return apiPost<{
    ok: true;
    libraryRoot: string | null;
    archiveTemplate: string | null;
    trashRetentionDays: number;
    trashAutoCleanupEnabled: boolean;
  }>(`/api/settings`, input);
}

export async function pruneTrash(days?: number) {
  return apiPost<{
    ok: true;
    retentionDays: number;
    result: {
      scannedRows: number;
      deletedRows: number;
      deletedFiles: number;
      queuedDeletes: number;
      missingFiles: number;
    };
  }>(`/api/maintenance/trash/prune`, typeof days === 'number' ? { days } : {});
}

export async function fetchSimilarMedia(
  mediaId: number,
  opts?: { limit?: number; distance?: number },
): Promise<MediaItem[]> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.distance) params.set('distance', String(opts.distance));
  const qs = params.toString();
  const r = await apiGet<{ ok: true; items: MediaItem[] }>(`/api/media/${mediaId}/similar${qs ? `?${qs}` : ''}`);
  return (r.items ?? []).map(normalizeMediaItem);
}
