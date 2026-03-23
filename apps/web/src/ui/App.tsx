import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  addCollection,
  addTag,
  createCollection,
  deleteMedia,
  fetchCollections,
  fetchMedia,
  fetchSettings,
  fetchSimilarMedia,
  fetchStats,
  fetchTags,
  fetchTimelineDays,
  favoriteMedia,
  importLocalFolder,
  removeCollection,
  removeTag,
  rateMedia,
  saveSettings,
  undeleteMedia,
  unfavoriteMedia,
  unarchiveMedia,
  type CollectionItem,
  type MediaItem,
  type MediaTypeFilter,
  type TagItem,
} from '../api';

type RouteKey = 'library' | 'archive' | 'timeline' | 'board' | 'favorites' | 'settings';

type Filters = {
  type: MediaTypeFilter;
  q: string;
  authorHandle: string;
  tag: string;
  tagPresence: 'all' | 'tagged' | 'untagged';
  collection: string;
  from: string;
  to: string;
  archived: 'all' | 'yes' | 'no';
  favoriteOnly: boolean;
};

type FeedState = {
  items: MediaItem[];
  nextOffset: number;
  totalCount: number | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
};

type TimelineDay = {
  day: string;
  count: number;
};

type TimelineDayState = {
  items: TimelineDay[];
  totalCount: number | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
};

type ToastState = {
  id: number;
  message: string;
  tone: 'success' | 'error';
  actionLabel?: string;
  onAction?: () => void;
};

type LastAction =
  | {
      kind: 'tag';
      ids: number[];
      tag: string;
      createdAt: number;
    }
  | {
      kind: 'collect';
      ids: number[];
      collection: string;
      createdAt: number;
    }
  | {
      kind: 'favorite';
      ids: number[];
      favorite: boolean;
      createdAt: number;
    }
  | {
      kind: 'delete';
      ids: number[];
      createdAt: number;
    }
  | null;

type BoardColumn = {
  key: string;
  title: string;
  items: MediaItem[];
  hint?: string;
  totalCount?: number | null;
  loading?: boolean;
  scope?: 'unarchived' | 'collection';
  collectionName?: string;
};

const EMPTY_FEED: FeedState = {
  items: [],
  nextOffset: 0,
  totalCount: null,
  loading: false,
  loaded: false,
  error: null,
};

const EMPTY_TIMELINE_DAYS: TimelineDayState = {
  items: [],
  totalCount: null,
  loading: false,
  loaded: false,
  error: null,
};

const DEFAULT_FILTERS: Filters = {
  type: 'all',
  q: '',
  authorHandle: '',
  tag: '',
  tagPresence: 'all',
  collection: '',
  from: '',
  to: '',
  archived: 'all',
  favoriteOnly: false,
};

const ROUTE_LABELS: Record<RouteKey, string> = {
  library: '图库',
  archive: '归档模式',
  timeline: '时间轴',
  board: '相簿看板',
  favorites: '收藏',
  settings: '设置',
};

const ARCHIVE_HINT =
  '归档模式会只展示未归档的内容，按左右方向键切换，选择相簿即可归档并进入下一张。';

const LIBRARY_PAGE_SIZE = 36;
const FAVORITES_PAGE_SIZE = 36;
const BOARD_COL_PAGE_SIZE = 4;
const TAGS_QUICK_LIMIT = 4;
const COLLECTIONS_QUICK_LIMIT = 6;
const PREVIEW_COLLECTION_LIMIT = 4;
const TIMELINE_DAY_PAGE_SIZE = 12;
const TIMELINE_ITEM_PAGE_SIZE = 24;

function parseRoute(hash: string): RouteKey {
  const trimmed = hash.replace(/^#\/?/, '').trim();
  if (trimmed.startsWith('archive')) return 'archive';
  if (trimmed.startsWith('timeline')) return 'timeline';
  if (trimmed.startsWith('board')) return 'board';
  if (trimmed.startsWith('favorites')) return 'favorites';
  if (trimmed.startsWith('settings')) return 'settings';
  return 'library';
}

function isTypingTarget(target: EventTarget | null) {
  if (!target || !(target as HTMLElement).tagName) return false;
  const node = target as HTMLElement;
  const tag = node.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || node.isContentEditable;
}

function uniqueStrings(list: string[]) {
  return Array.from(new Set(list.filter(Boolean)));
}

function intersectStrings(lists: string[][]) {
  if (!lists.length) return [];
  return lists.reduce((acc, list) => acc.filter((item) => list.includes(item)));
}

function formatDate(input: string) {
  const d = new Date(input);
  if (Number.isNaN(d.valueOf())) return input;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getSourceHost(url?: string) {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function formatDateTime(input: string) {
  const d = new Date(input);
  if (Number.isNaN(d.valueOf())) return input;
  return `${formatDate(input)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDateInput(date: Date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getRecentRange(days: number) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - Math.max(0, days - 1));
  return { from: formatDateInput(start), to: formatDateInput(end) };
}

function previewArchiveName(template: string, item?: MediaItem, collection?: string) {
  const d = item?.savedAt ? new Date(item.savedAt) : new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const datePart = `${yyyy}${mm}${dd}`;
  const timePart = `${hh}${mi}${ss}`;
  const datetimePart = `${datePart}_${timePart}`;
  const author = item?.sources?.[0]?.authorHandle ? `@${item.sources[0].authorHandle}` : '';
  const tags = item?.tags?.length ? item.tags.slice(0, 3).join('-') : '';
  const id = item ? `id${item.id}` : 'id0';
  const type = item?.type ?? 'image';
  const collectionPart = collection ?? item?.collections?.[0] ?? 'collection';
  const tokens: Record<string, string> = {
    date: datePart,
    time: timePart,
    datetime: datetimePart,
    author,
    tags,
    id,
    type,
    collection: collectionPart,
  };
  if (!template.trim()) {
    return [datetimePart, author, tags, id].filter(Boolean).join('_');
  }
  return template.replace(/\\{(\\w+)\\}/g, (_m, key) => tokens[key] ?? '');
}

function getPreviewUrls(items: MediaItem[], limit = 2) {
  return items
    .map((item) => item.thumbUrl ?? item.fileUrl)
    .filter((url): url is string => Boolean(url))
    .slice(0, limit);
}

function getTotalPages(totalCount: number | null, pageSize: number) {
  if (totalCount == null) return null;
  return Math.max(1, Math.ceil(totalCount / pageSize));
}

export function App() {
  const [route, setRoute] = useState<RouteKey>(() => parseRoute(window.location.hash));
  const [stats, setStats] = useState<{ mediaCount: number; sourceCount: number } | null>(null);
  const [collections, setCollections] = useState<CollectionItem[]>([]);
  const [tags, setTags] = useState<TagItem[]>([]);
  const [filtersDraft, setFiltersDraft] = useState<Filters>(DEFAULT_FILTERS);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [libraryPage, setLibraryPage] = useState(0);
  const [favoritesPage, setFavoritesPage] = useState(0);
  const [pagerDrafts, setPagerDrafts] = useState<Record<string, string>>({});
  const [libraryFeed, setLibraryFeed] = useState<FeedState>(EMPTY_FEED);
  const [favoritesFeed, setFavoritesFeed] = useState<FeedState>(EMPTY_FEED);
  const [archiveFeed, setArchiveFeed] = useState<FeedState>(EMPTY_FEED);
  const [boardColumns, setBoardColumns] = useState<BoardColumn[]>([]);
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [boardPageMap, setBoardPageMap] = useState<Record<string, number>>({});
  const [settings, setSettings] = useState<{ libraryRoot: string | null; archiveTemplate: string | null }>({
    libraryRoot: null,
    archiveTemplate: null,
  });
  const [settingsDraft, setSettingsDraft] = useState<{ libraryRoot: string; archiveTemplate: string }>({
    libraryRoot: '',
    archiveTemplate: '',
  });
  const [importPath, setImportPath] = useState('');
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [lastAction, setLastAction] = useState<LastAction>(null);
  const [similarItems, setSimilarItems] = useState<MediaItem[]>([]);
  const [similarLoading, setSimilarLoading] = useState(false);
  const [archiveIndex, setArchiveIndex] = useState(0);
  const [timelineDays, setTimelineDays] = useState<TimelineDayState>(EMPTY_TIMELINE_DAYS);
  const [timelineDayPage, setTimelineDayPage] = useState(0);
  const [timelineSelectedDay, setTimelineSelectedDay] = useState<string | null>(null);
  const [timelineItems, setTimelineItems] = useState<FeedState>(EMPTY_FEED);
  const [timelineItemsPage, setTimelineItemsPage] = useState(0);
  const [tagInput, setTagInput] = useState('');
  const [collectionInput, setCollectionInput] = useState('');
  const [collectionQuickInput, setCollectionQuickInput] = useState('');
  const [collectionCreateInput, setCollectionCreateInput] = useState('');
  const [tagReplaceFrom, setTagReplaceFrom] = useState('');
  const [tagReplaceTo, setTagReplaceTo] = useState('');
  const [tagToolTarget, setTagToolTarget] = useState<'from' | 'to'>('from');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [showTagInput, setShowTagInput] = useState(false);
  const [showCollectionInput, setShowCollectionInput] = useState(false);
  const [showBatchTagInput, setShowBatchTagInput] = useState(false);
  const [showBatchCollectionInput, setShowBatchCollectionInput] = useState(false);
  const [showCreateCollection, setShowCreateCollection] = useState(false);
  const [showDrawerTagInput, setShowDrawerTagInput] = useState(false);
  const [showTagTools, setShowTagTools] = useState(false);
  const [showSimilarDock, setShowSimilarDock] = useState(true);
  const [collectionPreviews, setCollectionPreviews] = useState<Record<string, MediaItem[]>>({});
  const [unarchivedPreview, setUnarchivedPreview] = useState<MediaItem[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const toastTimerRef = useRef<number | null>(null);
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  const collectionInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    if (!window.location.hash) {
      window.location.hash = '#/library';
    }
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    fetchStats().then(setStats).catch(() => null);
    refreshCollections();
    refreshTags();
    fetchSettings()
      .then((data) => {
        setSettings(data);
        setSettingsDraft({
          libraryRoot: data.libraryRoot ?? '',
          archiveTemplate: data.archiveTemplate ?? '',
        });
      })
      .catch(() => null);
  }, []);

  useEffect(() => {
    let active = true;
    async function loadPreviews() {
      if (!collections.length) {
        setCollectionPreviews({});
        return;
      }
      setPreviewLoading(true);
      try {
        const entries = await Promise.all(
          collections.map(async (col) => {
            const res = await fetchMedia({
              offset: 0,
              limit: 4,
              type: 'all',
              q: '',
              collection: col.name,
              archived: 'all',
            });
            return [col.name, res.items] as const;
          }),
        );
        if (active) {
          setCollectionPreviews(Object.fromEntries(entries));
        }
      } catch {
        if (active) {
          setCollectionPreviews({});
        }
      } finally {
        if (active) {
          setPreviewLoading(false);
        }
      }
    }
    loadPreviews();
    return () => {
      active = false;
    };
  }, [collections]);

  useEffect(() => {
    let active = true;
    fetchMedia({
      offset: 0,
      limit: 4,
      type: 'all',
      q: '',
      archived: 'no',
    })
      .then((res) => {
        if (active) setUnarchivedPreview(res.items);
      })
      .catch(() => {
        if (active) setUnarchivedPreview([]);
      });
    return () => {
      active = false;
    };
  }, [collections]);

  useEffect(() => {
    if (route === 'library') {
      loadLibrary(libraryPage);
    }
  }, [route, filters, libraryPage]);

  useEffect(() => {
    if (route === 'timeline') {
      loadTimelineDays(timelineDayPage);
    }
  }, [route, filters, timelineDayPage]);

  useEffect(() => {
    if (route !== 'timeline') return;
    if (!timelineSelectedDay) {
      setTimelineItems(EMPTY_FEED);
      return;
    }
    loadTimelineItems(timelineSelectedDay, timelineItemsPage);
  }, [route, timelineSelectedDay, timelineItemsPage, filters]);

  useEffect(() => {
    if (route === 'favorites') {
      loadFavorites(favoritesPage);
    }
  }, [route, filters, favoritesPage]);

  useEffect(() => {
    if (route === 'archive') {
      loadArchive('reset');
    }
    if (route === 'board') {
      loadBoard();
    }
    if (route === 'timeline') {
      resetTimelineState();
    }
  }, [route]);

  useEffect(() => {
    if (archiveIndex >= archiveFeed.items.length) {
      setArchiveIndex(Math.max(0, archiveFeed.items.length - 1));
    }
  }, [archiveFeed.items, archiveIndex]);

  useEffect(() => {
    if (!selectedId) {
      setSimilarItems([]);
      return;
    }
    setShowSimilarDock(true);
    setSimilarLoading(true);
    fetchSimilarMedia(selectedId, { limit: 18, distance: 12 })
      .then((items) => setSimilarItems(items))
      .catch(() => setSimilarItems([]))
      .finally(() => setSimilarLoading(false));
  }, [selectedId]);

  useEffect(() => {
    if (!multiSelect) {
      setSelectedIds([]);
    }
  }, [multiSelect]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'escape') {
        if (selectedId) {
          setSelectedId(null);
          return;
        }
        if (multiSelect) {
          setMultiSelect(false);
          return;
        }
      }
      const activeItem = selectedId ? findItemById(selectedId) : null;
      if ((route === 'archive' && archiveFeed.items.length) || activeItem) {
        if (key === 'arrowleft') {
          event.preventDefault();
          if (route === 'archive') moveArchive(-1);
          else moveSelected(-1);
        }
        if (key === 'arrowright') {
          event.preventDefault();
          if (route === 'archive') moveArchive(1);
          else moveSelected(1);
        }
        if (key === 'f') {
          event.preventDefault();
          if (activeItem) toggleFavorite([activeItem.id], !activeItem.favorite);
        }
        if (key === 't') {
          event.preventDefault();
          tagInputRef.current?.focus();
        }
        if (key === 'c') {
          event.preventDefault();
          collectionInputRef.current?.focus();
        }
        if (key === 'u') {
          event.preventDefault();
          undoLastAction();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [route, selectedId, archiveFeed.items, multiSelect, lastAction]);
  const actionIds = useMemo(() => {
    if (selectedIds.length) return selectedIds;
    if (selectedId) return [selectedId];
    return [];
  }, [selectedId, selectedIds]);

  const selectedItem = selectedId ? findItemById(selectedId) : null;
  const archiveItem = archiveFeed.items[archiveIndex] ?? null;

  function findItemById(id: number) {
    return (
      libraryFeed.items.find((item) => item.id === id) ||
      timelineItems.items.find((item) => item.id === id) ||
      favoritesFeed.items.find((item) => item.id === id) ||
      archiveFeed.items.find((item) => item.id === id) ||
      boardColumns.flatMap((col) => col.items).find((item) => item.id === id) ||
      null
    );
  }

  function refreshCollections() {
    fetchCollections()
      .then((items) => setCollections(items))
      .catch(() => null);
  }

  function refreshTags() {
    fetchTags({ popular: true, limit: TAGS_QUICK_LIMIT })
      .then((items) => setTags(items))
      .catch(() => null);
  }

  function syncMeta() {
    refreshCollections();
    refreshTags();
    showToast({ message: '已同步相簿与标签', tone: 'success' });
  }

  function showToast(next: Omit<ToastState, 'id'>) {
    const id = Date.now();
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToast({ ...next, id });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3800);
  }

  function updatePagerDraft(key: string, value: string) {
    setPagerDrafts((prev) => ({ ...prev, [key]: value }));
  }

  function jumpToCollection(name: string) {
    window.location.hash = '#/library';
    applyFilterPatch({
      collection: name,
      tag: '',
      authorHandle: '',
      q: '',
      archived: 'all',
    });
  }

  function jumpToUnarchived() {
    window.location.hash = '#/archive';
  }

  function updateFeedItems(
    setter: React.Dispatch<React.SetStateAction<FeedState>>,
    ids: number[],
    updater: (item: MediaItem) => MediaItem | null,
  ) {
    if (!ids.length) return;
    setter((prev) => ({
      ...prev,
      items: prev.items
        .map((item) => (ids.includes(item.id) ? updater(item) : item))
        .filter((item): item is MediaItem => Boolean(item)),
    }));
  }

  function updateBoardItems(ids: number[], updater: (item: MediaItem) => MediaItem | null) {
    if (!ids.length) return;
    setBoardColumns((prev) =>
      prev.map((col) => ({
        ...col,
        items: col.items
          .map((item) => (ids.includes(item.id) ? updater(item) : item))
          .filter((item): item is MediaItem => Boolean(item)),
      })),
    );
  }

  function applyMediaUpdate(ids: number[], updater: (item: MediaItem) => MediaItem | null) {
    updateFeedItems(setLibraryFeed, ids, updater);
    updateFeedItems(setFavoritesFeed, ids, updater);
    updateFeedItems(setArchiveFeed, ids, updater);
    updateFeedItems(setTimelineItems, ids, updater);
    updateBoardItems(ids, updater);
  }

  function resetTimelineState() {
    setTimelineDayPage(0);
    setTimelineSelectedDay(null);
    setTimelineItemsPage(0);
    setTimelineDays(EMPTY_TIMELINE_DAYS);
    setTimelineItems(EMPTY_FEED);
    updatePagerDraft('timeline-days', '');
    updatePagerDraft('timeline-items', '');
  }

  function selectTimelineDay(day: string | null) {
    setTimelineSelectedDay(day);
    setTimelineItemsPage(0);
    setTimelineItems(EMPTY_FEED);
    updatePagerDraft('timeline-items', '');
  }

  async function loadLibrary(page = libraryPage) {
    const safePage = Math.max(0, page);
    const offset = safePage * LIBRARY_PAGE_SIZE;
    setLibraryFeed((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await fetchMedia({
        offset,
        limit: LIBRARY_PAGE_SIZE,
        type: filters.type,
        q: filters.q,
        authorHandle: filters.authorHandle,
        tag: filters.tag,
        tagPresence: filters.tagPresence === 'all' ? undefined : filters.tagPresence,
        collection: filters.collection,
        from: filters.from,
        to: filters.to,
        archived: filters.archived,
        favorite: filters.favoriteOnly ? true : undefined,
      });
      setLibraryFeed((prev) => ({
        items: res.items,
        nextOffset: res.nextOffset,
        totalCount: res.totalCount,
        loading: false,
        loaded: true,
        error: null,
      }));
    } catch (err) {
      setLibraryFeed((prev) => ({
        ...prev,
        loading: false,
        loaded: true,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  async function loadTimelineDays(page = timelineDayPage) {
    const safePage = Math.max(0, page);
    const offset = safePage * TIMELINE_DAY_PAGE_SIZE;
    setTimelineDays((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await fetchTimelineDays({
        offset,
        limit: TIMELINE_DAY_PAGE_SIZE,
        type: filters.type,
        q: filters.q,
        authorHandle: filters.authorHandle,
        tag: filters.tag,
        tagPresence: filters.tagPresence === 'all' ? undefined : filters.tagPresence,
        collection: filters.collection,
        from: filters.from,
        to: filters.to,
        archived: filters.archived,
        favorite: filters.favoriteOnly ? true : undefined,
      });
      setTimelineDays({
        items: res.items,
        totalCount: res.totalCount,
        loading: false,
        loaded: true,
        error: null,
      });
      const fallbackDay = res.items[0]?.day ?? null;
      const keepCurrent =
        timelineSelectedDay && res.items.some((item) => item.day === timelineSelectedDay)
          ? timelineSelectedDay
          : null;
      const nextDay = keepCurrent ?? fallbackDay;
      if (nextDay !== timelineSelectedDay) {
        selectTimelineDay(nextDay);
      } else if (!nextDay) {
        setTimelineSelectedDay(null);
        setTimelineItems(EMPTY_FEED);
      }
    } catch (err) {
      setTimelineDays((prev) => ({
        ...prev,
        loading: false,
        loaded: true,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  async function loadTimelineItems(day: string, page = timelineItemsPage) {
    const safePage = Math.max(0, page);
    const offset = safePage * TIMELINE_ITEM_PAGE_SIZE;
    setTimelineItems((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await fetchMedia({
        offset,
        limit: TIMELINE_ITEM_PAGE_SIZE,
        type: filters.type,
        q: filters.q,
        authorHandle: filters.authorHandle,
        tag: filters.tag,
        tagPresence: filters.tagPresence === 'all' ? undefined : filters.tagPresence,
        collection: filters.collection,
        from: day,
        to: day,
        archived: filters.archived,
        favorite: filters.favoriteOnly ? true : undefined,
      });
      setTimelineItems({
        items: res.items,
        nextOffset: res.nextOffset,
        totalCount: res.totalCount,
        loading: false,
        loaded: true,
        error: null,
      });
    } catch (err) {
      setTimelineItems((prev) => ({
        ...prev,
        loading: false,
        loaded: true,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  async function loadFavorites(page = favoritesPage) {
    const safePage = Math.max(0, page);
    const offset = safePage * FAVORITES_PAGE_SIZE;
    setFavoritesFeed((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await fetchMedia({
        offset,
        limit: FAVORITES_PAGE_SIZE,
        type: filters.type,
        q: filters.q,
        authorHandle: filters.authorHandle,
        tag: filters.tag,
        tagPresence: filters.tagPresence === 'all' ? undefined : filters.tagPresence,
        collection: filters.collection,
        from: filters.from,
        to: filters.to,
        archived: filters.archived,
        favorite: true,
      });
      setFavoritesFeed((prev) => ({
        items: res.items,
        nextOffset: res.nextOffset,
        totalCount: res.totalCount,
        loading: false,
        loaded: true,
        error: null,
      }));
    } catch (err) {
      setFavoritesFeed((prev) => ({
        ...prev,
        loading: false,
        loaded: true,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  function refreshLibraryNow() {
    setLibraryPage(0);
    setLibraryFeed(EMPTY_FEED);
    if (route === 'library') {
      loadLibrary(0);
    }
    if (route === 'timeline') {
      resetTimelineState();
      loadTimelineDays(0);
    }
  }

  function refreshFavoritesNow() {
    setFavoritesPage(0);
    setFavoritesFeed(EMPTY_FEED);
    if (route === 'favorites') {
      loadFavorites(0);
    }
  }

  async function loadArchive(mode: 'reset' | 'append') {
    const offset = mode === 'append' ? archiveFeed.nextOffset : 0;
    setArchiveFeed((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await fetchMedia({
        offset,
        limit: 80,
        type: 'all',
        q: '',
        archived: 'no',
      });
      setArchiveFeed((prev) => ({
        items: mode === 'append' ? [...prev.items, ...res.items] : res.items,
        nextOffset: res.nextOffset,
        loading: false,
        loaded: true,
        error: null,
      }));
    } catch (err) {
      setArchiveFeed((prev) => ({
        ...prev,
        loading: false,
        loaded: true,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  async function fetchBoardColumn(col: BoardColumn, page: number) {
    const offset = Math.max(0, page) * BOARD_COL_PAGE_SIZE;
    return fetchMedia({
      offset,
      limit: BOARD_COL_PAGE_SIZE,
      type: 'all',
      q: '',
      collection: col.collectionName,
      archived: col.scope === 'unarchived' ? 'no' : 'all',
    });
  }

  async function loadBoardColumn(col: BoardColumn, page: number) {
    setBoardColumns((prev) =>
      prev.map((item) => (item.key === col.key ? { ...item, loading: true } : item)),
    );
    try {
      const res = await fetchBoardColumn(col, page);
      setBoardColumns((prev) =>
        prev.map((item) =>
          item.key === col.key
            ? {
                ...item,
                items: res.items,
                totalCount: res.totalCount ?? res.items.length,
                loading: false,
              }
            : item,
        ),
      );
    } catch (err) {
      setBoardColumns((prev) =>
        prev.map((item) => (item.key === col.key ? { ...item, loading: false } : item)),
      );
      setBoardError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadBoard() {
    setBoardLoading(true);
    setBoardError(null);
    try {
      const cols = await fetchCollections();
      const baseColumns: BoardColumn[] = [
        {
          key: 'unarchived',
          title: '未归档',
          hint: '优先处理的队列',
          items: [],
          scope: 'unarchived',
        },
        ...cols.map((col) => ({
          key: `col-${col.id}`,
          title: col.name,
          items: [],
          scope: 'collection' as const,
          collectionName: col.name,
        })),
      ];
      const results = await Promise.all(
        baseColumns.map(async (col) => {
          const res = await fetchBoardColumn(col, 0);
          return {
            ...col,
            items: res.items,
            totalCount: res.totalCount ?? res.items.length,
            loading: false,
          } as BoardColumn;
        }),
      );
      setBoardColumns(results);
      setBoardPageMap(Object.fromEntries(baseColumns.map((col) => [col.key, 0])));
      setBoardLoading(false);
    } catch (err) {
      setBoardError(err instanceof Error ? err.message : String(err));
      setBoardLoading(false);
    }
  }

  function applyFilters() {
    setFilters(filtersDraft);
    setLibraryPage(0);
    setFavoritesPage(0);
    setLibraryFeed(EMPTY_FEED);
    setFavoritesFeed(EMPTY_FEED);
    resetTimelineState();
  }

  function applyTimelineRange() {
    const from = filtersDraft.from.trim();
    const to = filtersDraft.to.trim();
    if (from && to && from > to) {
      applyFilterPatch({ from: to, to: from });
      return;
    }
    applyFilterPatch({ from, to });
  }

  function applyFilterPatch(patch: Partial<Filters>) {
    setFiltersDraft((prev) => {
      const next = { ...prev, ...patch };
      setFilters(next);
      setLibraryPage(0);
      setFavoritesPage(0);
      resetTimelineState();
      return next;
    });
    setLibraryFeed(EMPTY_FEED);
    setFavoritesFeed(EMPTY_FEED);
  }

  function resetFilters() {
    setFiltersDraft(DEFAULT_FILTERS);
    setFilters(DEFAULT_FILTERS);
    setLibraryPage(0);
    setFavoritesPage(0);
    setLibraryFeed(EMPTY_FEED);
    setFavoritesFeed(EMPTY_FEED);
    resetTimelineState();
    if (route === 'favorites') {
      window.location.hash = '#/library';
    }
  }

  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return Array.from(next);
    });
  }

  function toggleSelectAll(items: MediaItem[]) {
    const allIds = items.map((item) => item.id);
    const allSelected = allIds.every((id) => selectedIds.includes(id));
    if (allSelected) {
      setSelectedIds((prev) => prev.filter((id) => !allIds.includes(id)));
    } else {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...allIds])));
    }
  }

  async function toggleFavorite(ids: number[], nextValue: boolean, opts?: { silent?: boolean }) {
    if (!ids.length) return;
    try {
      await Promise.all(ids.map((id) => (nextValue ? favoriteMedia(id) : unfavoriteMedia(id))));
      applyMediaUpdate(ids, (item) => {
        if (!item) return item;
        const updated = { ...item, favorite: nextValue };
        if (!nextValue && favoritesFeed.items.some((fav) => fav.id === item.id)) {
          return route === 'favorites' ? null : updated;
        }
        return updated;
      });
      if (!opts?.silent) {
        setLastAction({ kind: 'favorite', ids, favorite: nextValue, createdAt: Date.now() });
        showToast({
          message: nextValue ? `已收藏 ${ids.length} 项` : `已取消收藏 ${ids.length} 项`,
          tone: 'success',
          actionLabel: '撤销',
          onAction: undoLastAction,
        });
      }
    } catch (err) {
      showToast({
        message: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    }
  }

  async function setRating(ids: number[], rating: number, opts?: { silent?: boolean }) {
    if (!ids.length) return;
    const nextRating = Math.max(0, Math.min(3, Math.floor(rating)));
    try {
      await Promise.all(ids.map((id) => rateMedia(id, nextRating)));
      applyMediaUpdate(ids, (item) => ({ ...item, rating: nextRating }));
      if (!opts?.silent) {
        showToast({
          message: nextRating === 0 ? '已清除评分' : `已评分 ${nextRating} 星`,
          tone: 'success',
        });
      }
    } catch (err) {
      showToast({
        message: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    }
  }

  async function addTags(ids: number[], tagName: string) {
    const name = tagName.trim();
    if (!name || !ids.length) return;
    try {
      await Promise.all(ids.map((id) => addTag(id, name)));
      applyMediaUpdate(ids, (item) => ({ ...item, tags: uniqueStrings([...(item.tags ?? []), name]) }));
      refreshTags();
      setLastAction({ kind: 'tag', ids, tag: name, createdAt: Date.now() });
      showToast({
        message: `已添加标签 ${name}`,
        tone: 'success',
        actionLabel: '撤销',
        onAction: undoLastAction,
      });
    } catch (err) {
      showToast({
        message: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    }
  }

  async function removeTags(ids: number[], tagName: string) {
    const name = tagName.trim();
    if (!name || !ids.length) return;
    try {
      await Promise.all(ids.map((id) => removeTag(id, name)));
      applyMediaUpdate(ids, (item) => ({ ...item, tags: (item.tags ?? []).filter((t) => t !== name) }));
      refreshTags();
    } catch (err) {
      showToast({
        message: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    }
  }

  function idsWithTag(ids: number[], name: string) {
    return ids.filter((id) => findItemById(id)?.tags?.includes(name));
  }

  function idsWithCollection(ids: number[], name: string) {
    return ids.filter((id) => findItemById(id)?.collections?.includes(name));
  }

  async function replaceTags(
    ids: number[],
    from: string,
    to: string,
    mode: 'replace' | 'merge',
  ): Promise<boolean> {
    const source = from.trim();
    const target = to.trim();
    if (!source || !target || !ids.length) return false;
    const affected = idsWithTag(ids, source);
    if (!affected.length) {
      showToast({ message: `未找到标签 ${source}`, tone: 'error' });
      return false;
    }
    try {
      await Promise.all([
        Promise.all(affected.map((id) => removeTag(id, source))),
        Promise.all(affected.map((id) => addTag(id, target))),
      ]);
      applyMediaUpdate(affected, (item) => ({
        ...item,
        tags: uniqueStrings((item.tags ?? []).filter((tag) => tag !== source).concat(target)),
      }));
      refreshTags();
      showToast({
        message: mode === 'merge' ? `已合并标签 ${source} → ${target}` : `已替换标签 ${source} → ${target}`,
        tone: 'success',
      });
      setTagReplaceFrom('');
      setTagReplaceTo('');
      return true;
    } catch (err) {
      showToast({
        message: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
      return false;
    }
  }

  async function addToCollection(ids: number[], name: string) {
    const nextName = name.trim();
    if (!nextName || !ids.length) return;
    try {
      if (!collections.some((col) => col.name === nextName)) {
        await createCollection(nextName);
        await refreshCollections();
      }
      await Promise.all(ids.map((id) => addCollection(id, nextName)));
      applyMediaUpdate(ids, (item) => ({
        ...item,
        collections: uniqueStrings([...(item.collections ?? []), nextName]),
        archivedAt: new Date().toISOString(),
      }));
      setArchiveFeed((prev) => ({
        ...prev,
        items: prev.items.filter((item) => !ids.includes(item.id)),
      }));
      setLastAction({ kind: 'collect', ids, collection: nextName, createdAt: Date.now() });
      showToast({
        message: `已归档到 ${nextName}`,
        tone: 'success',
        actionLabel: '撤销',
        onAction: undoLastAction,
      });
    } catch (err) {
      showToast({
        message: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    }
  }

  async function createCollectionOnly(name: string) {
    const nextName = name.trim();
    if (!nextName) return;
    try {
      if (!collections.some((col) => col.name === nextName)) {
        await createCollection(nextName);
        await refreshCollections();
      }
      if (route === 'board') {
        loadBoard();
      }
      showToast({ message: `已创建相簿 ${nextName}`, tone: 'success' });
    } catch (err) {
      showToast({
        message: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    }
  }

  async function createOrCollect(name: string, ids: number[]) {
    if (ids.length) {
      await addToCollection(ids, name);
    } else {
      await createCollectionOnly(name);
    }
  }

  async function removeFromCollection(ids: number[], name: string) {
    const nextName = name.trim();
    if (!nextName || !ids.length) return;
    try {
      await Promise.all(ids.map((id) => removeCollection(id, nextName)));
      applyMediaUpdate(ids, (item) => ({
        ...item,
        collections: (item.collections ?? []).filter((c) => c !== nextName),
      }));
    } catch (err) {
      showToast({
        message: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    }
  }

  async function unarchiveItems(ids: number[], opts?: { silent?: boolean }) {
    if (!ids.length) return;
    try {
      await Promise.all(ids.map((id) => unarchiveMedia(id)));
      applyMediaUpdate(ids, (item) => ({ ...item, archivedAt: null }));
      if (!opts?.silent) {
        showToast({
          message: `已撤销归档 ${ids.length} 项`,
          tone: 'success',
        });
      }
    } catch (err) {
      showToast({
        message: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    }
  }

  async function deleteItems(ids: number[], opts?: { silent?: boolean }) {
    if (!ids.length) return;
    try {
      await Promise.all(ids.map((id) => deleteMedia(id)));
      applyMediaUpdate(ids, () => null);
      setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
      if (selectedId && ids.includes(selectedId)) {
        setSelectedId(null);
      }
      if (!opts?.silent) {
        setLastAction({ kind: 'delete', ids, createdAt: Date.now() });
        showToast({
          message: `已删除 ${ids.length} 项`,
          tone: 'success',
          actionLabel: '撤销',
          onAction: undoLastAction,
        });
      }
    } catch (err) {
      showToast({
        message: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    }
  }

  async function undoLastAction() {
    if (!lastAction) return;
    const age = Date.now() - lastAction.createdAt;
    if (age > 20000) {
      setLastAction(null);
      showToast({
        message: '撤销窗口已过期',
        tone: 'error',
      });
      return;
    }
    if (lastAction.kind === 'tag') {
      await removeTags(lastAction.ids, lastAction.tag);
      setLastAction(null);
      showToast({ message: '已撤销标签操作', tone: 'success' });
    }
    if (lastAction.kind === 'collect') {
      await Promise.all([
        unarchiveItems(lastAction.ids, { silent: true }),
        removeFromCollection(lastAction.ids, lastAction.collection),
      ]);
      setLastAction(null);
      loadArchive('reset');
      showToast({ message: '已撤销归档操作', tone: 'success' });
    }
    if (lastAction.kind === 'favorite') {
      await toggleFavorite(lastAction.ids, !lastAction.favorite, { silent: true });
      setLastAction(null);
      showToast({ message: '已撤销收藏操作', tone: 'success' });
    }
    if (lastAction.kind === 'delete') {
      await Promise.all(lastAction.ids.map((id) => undeleteMedia(id)));
      setLastAction(null);
      refreshLibraryNow();
      refreshFavoritesNow();
      loadArchive('reset');
      if (route === 'board') {
        loadBoard();
      }
      showToast({ message: '宸叉挙閿€鍒犻櫎', tone: 'success' });
    }
  }

  function moveArchive(delta: number) {
    if (!archiveFeed.items.length) return;
    const next = Math.max(0, Math.min(archiveFeed.items.length - 1, archiveIndex + delta));
    setArchiveIndex(next);
  }

  function moveSelected(delta: number) {
    const items =
      route === 'favorites' ? favoritesFeed.items : route === 'timeline' ? timelineItems.items : libraryFeed.items;
    if (!selectedId || !items.length) return;
    const index = items.findIndex((item) => item.id === selectedId);
    if (index < 0) return;
    const next = Math.max(0, Math.min(items.length - 1, index + delta));
    setSelectedId(items[next]?.id ?? null);
  }

  async function handleImportLocal() {
    if (!importPath.trim()) return;
    setImportStatus('正在导入...');
    try {
      const res = await importLocalFolder({ path: importPath.trim(), recursive: true });
      setImportStatus(
        `导入完成：总计 ${res.summary.total}，新增 ${res.summary.created}，已存在 ${res.summary.exists}，失败 ${res.summary.failed}`,
      );
      refreshLibraryNow();
      loadArchive('reset');
    } catch (err) {
      setImportStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSaveSettings() {
    try {
      const res = await saveSettings({
        libraryRoot: settingsDraft.libraryRoot.trim() || null,
        archiveTemplate: settingsDraft.archiveTemplate.trim() || null,
      });
      setSettings(res);
      setSettingsDraft({
        libraryRoot: res.libraryRoot ?? '',
        archiveTemplate: res.archiveTemplate ?? '',
      });
      showToast({ message: '设置已保存', tone: 'success' });
    } catch (err) {
      showToast({ message: err instanceof Error ? err.message : String(err), tone: 'error' });
    }
  }

  function activeList() {
    if (route === 'favorites') return favoritesFeed.items;
    if (route === 'archive') return archiveFeed.items;
    if (route === 'timeline') return timelineItems.items;
    return libraryFeed.items;
  }

  const libraryPageCount = useMemo(
    () => getTotalPages(libraryFeed.totalCount, LIBRARY_PAGE_SIZE),
    [libraryFeed.totalCount],
  );
  const favoritesPageCount = useMemo(
    () => getTotalPages(favoritesFeed.totalCount, FAVORITES_PAGE_SIZE),
    [favoritesFeed.totalCount],
  );
  const timelineDayPageCount = useMemo(
    () => getTotalPages(timelineDays.totalCount, TIMELINE_DAY_PAGE_SIZE),
    [timelineDays.totalCount],
  );
  const timelineItemsPageCount = useMemo(
    () => getTotalPages(timelineItems.totalCount, TIMELINE_ITEM_PAGE_SIZE),
    [timelineItems.totalCount],
  );

  useEffect(() => {
    if (libraryPageCount && libraryPage >= libraryPageCount) {
      setLibraryPage(Math.max(0, libraryPageCount - 1));
    }
  }, [libraryPage, libraryPageCount]);

  useEffect(() => {
    if (favoritesPageCount && favoritesPage >= favoritesPageCount) {
      setFavoritesPage(Math.max(0, favoritesPageCount - 1));
    }
  }, [favoritesPage, favoritesPageCount]);

  useEffect(() => {
    if (timelineDayPageCount && timelineDayPage >= timelineDayPageCount) {
      setTimelineDayPage(Math.max(0, timelineDayPageCount - 1));
    }
  }, [timelineDayPage, timelineDayPageCount]);

  useEffect(() => {
    if (timelineItemsPageCount && timelineItemsPage >= timelineItemsPageCount) {
      setTimelineItemsPage(Math.max(0, timelineItemsPageCount - 1));
    }
  }, [timelineItemsPage, timelineItemsPageCount]);

  function renderRatingStars(
    value: number,
    onRate: (rating: number) => void,
    opts?: { compact?: boolean; stopPropagation?: boolean },
  ) {
    const stars = [1, 2, 3];
    return (
      <div className={`rating-stars ${opts?.compact ? 'rating-stars-compact' : ''}`}>
        {stars.map((star) => (
          <button
            key={star}
            className={`rating-star ${value >= star ? 'rating-star-active' : ''}`}
            onClick={(event) => {
              if (opts?.stopPropagation) event.stopPropagation();
              onRate(value === star ? 0 : star);
            }}
            aria-label={`评分 ${star} 星`}
            title={value === star ? '清除评分' : `评分 ${star} 星`}
          >
            {value >= star ? '★' : '☆'}
          </button>
        ))}
      </div>
    );
  }
  function renderMediaCard(item: MediaItem) {
    const isSelected = selectedIds.includes(item.id);
    const primarySource = item.sources?.[0];
    const author = primarySource?.authorHandle
      ? `@${primarySource.authorHandle}`
      : getSourceHost(primarySource?.sourcePageUrl ?? primarySource?.tweetUrl) ?? '未知来源';
    const savedLabel = formatDate(item.savedAt);
    return (
      <div
        key={item.id}
        className={`media-card ${isSelected ? 'media-card-selected' : ''}`}
        onClick={() => (multiSelect ? toggleSelect(item.id) : setSelectedId(item.id))}
      >
        {multiSelect ? (
          <button
            className={`media-check ${isSelected ? 'media-check-active' : ''}`}
            onClick={(event) => {
              event.stopPropagation();
              toggleSelect(item.id);
            }}
          >
            <span className="media-check-box">{isSelected ? '✓' : ''}</span>
          </button>
        ) : null}
        {isSelected && multiSelect ? <div className="media-selected-overlay" /> : null}
        <div className="media-thumb">
          {item.type === 'video' ? (
            <video src={item.fileUrl} poster={item.thumbUrl ?? undefined} muted preload="metadata" />
          ) : (
            <img src={item.thumbUrl ?? item.fileUrl} alt={item.tags?.join(',') || 'media'} loading="lazy" />
          )}
          <div className="media-overlay">
            <div className="media-overlay-left">
              <div className="media-author">{author}</div>
              <div className="media-date">{savedLabel}</div>
            </div>
            <div className="media-overlay-right">
              {item.archivedAt ? <span className="media-badge">已归档</span> : null}
              {item.favorite ? <span className="media-badge badge-fav">收藏</span> : null}
              {item.rating ? <span className="media-badge badge-rating">★{item.rating}</span> : null}
            </div>
          </div>
          {item.favorite ? <div className="media-fav-corner">★</div> : null}
        </div>
        <div className="media-meta">
          <div className="media-tags">
            {item.tags.slice(0, 2).map((tag) => (
              <span key={tag} className="media-tag">
                {tag}
              </span>
            ))}
            {item.tags.length > 2 ? <span className="media-tag">+{item.tags.length - 2}</span> : null}
            {multiSelect && isSelected ? <span className="media-selected-pill">已选中</span> : null}
          </div>
          <div className="media-actions">
            {renderRatingStars(item.rating ?? 0, (rating) => setRating([item.id], rating), {
              compact: true,
              stopPropagation: true,
            })}
            <button
              className={`mini-btn ${item.favorite ? 'mini-btn-active' : ''}`}
              onClick={(event) => {
                event.stopPropagation();
                toggleFavorite([item.id], !item.favorite);
              }}
            >
              {item.favorite ? '已收藏' : '收藏'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderMediaGrid(items: MediaItem[]) {
    if (!items.length && route === 'library' && libraryFeed.loaded && !libraryFeed.loading) {
      return <div className="empty-state">暂无内容，试试放宽筛选条件。</div>;
    }
    if (!items.length && route === 'favorites' && favoritesFeed.loaded && !favoritesFeed.loading) {
      return <div className="empty-state">还没有收藏，看到喜欢的图片记得点一下收藏。</div>;
    }
    return <div className="masonry">{items.map(renderMediaCard)}</div>;
  }

  function renderPagerLegacy(opts: {
    pagerKey: string;
    page: number;
    hasNext: boolean;
    loading: boolean;
    onPrev: () => void;
    onNext: () => void;
    onJump: (page: number) => void;
    totalPages?: number;
  }) {
    const draft = pagerDrafts[opts.pagerKey] ?? '';
    const totalLabel = opts.totalPages ? ` / 共 ${opts.totalPages} 页` : '';
    const handleJump = () => {
      const parsed = Math.floor(Number(draft));
      if (!Number.isFinite(parsed) || parsed < 1) return;
      const bounded = opts.totalPages ? Math.min(opts.totalPages, parsed) : parsed;
      opts.onJump(Math.max(0, bounded - 1));
      updatePagerDraft(opts.pagerKey, '');
    };
    return (
      <div className="pagination">
        <button className="btn btn-ghost" onClick={opts.onPrev} disabled={opts.loading || opts.page <= 0}>
          上一页
        </button>
        <div className="pagination-info">{`第 ${opts.page + 1} 页${totalLabel}`}</div>
        <div className="pagination-jump">
          <input
            className="input input-compact pagination-input"
            type="number"
            min={1}
            max={opts.totalPages}
            placeholder="页码"
            value={draft}
            onChange={(event) => updatePagerDraft(opts.pagerKey, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleJump();
            }}
          />
          <button className="btn btn-ghost" onClick={handleJump} disabled={opts.loading}>
            跳转
          </button>
        </div>
        <button className="btn btn-ghost" onClick={opts.onNext} disabled={opts.loading || !opts.hasNext}>
          下一页
        </button>
      </div>
    );
  }

  function renderPager(opts: {
    pagerKey: string;
    page: number;
    hasNext: boolean;
    loading: boolean;
    onPrev: () => void;
    onNext: () => void;
    onJump: (page: number) => void;
    totalPages?: number | null;
    totalCount?: number | null;
  }) {
    const draft = pagerDrafts[opts.pagerKey] ?? '';
    const totalPages = typeof opts.totalPages === 'number' ? opts.totalPages : null;
    const totalLabel = totalPages ? ` / 共 ${totalPages} 页` : '';
    const countLabel = typeof opts.totalCount === 'number' ? ` · ${opts.totalCount} 项` : '';
    const currentPage = totalPages ? Math.min(opts.page + 1, totalPages) : opts.page + 1;
    const handleJump = () => {
      const parsed = Math.floor(Number(draft));
      if (!Number.isFinite(parsed) || parsed < 1) return;
      const bounded = totalPages ? Math.min(totalPages, parsed) : parsed;
      opts.onJump(Math.max(0, bounded - 1));
      updatePagerDraft(opts.pagerKey, '');
    };
    return (
      <div className="pagination">
        <button className="btn btn-ghost" onClick={opts.onPrev} disabled={opts.loading || opts.page <= 0}>
          上一页
        </button>
        <div className="pagination-info">{`第 ${currentPage} 页${totalLabel}${countLabel}`}</div>
        <div className="pagination-jump">
          <input
            className="input input-compact pagination-input"
            type="number"
            min={1}
            max={totalPages || undefined}
            placeholder="页码"
            value={draft}
            onChange={(event) => updatePagerDraft(opts.pagerKey, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleJump();
            }}
          />
          <button className="btn btn-ghost" onClick={handleJump} disabled={opts.loading}>
            跳转
          </button>
        </div>
        <button className="btn btn-ghost" onClick={opts.onNext} disabled={opts.loading || !opts.hasNext}>
          下一页
        </button>
      </div>
    );
  }

  function renderBatchBarLegacy() {
    if (!multiSelect) return null;
    const count = selectedIds.length;
    return (
      <div className="batch-bar glass">
        <div className="batch-row">
          <div className="batch-title">已选择 {count} 项</div>
          <div className="batch-actions">
            <button className="btn" onClick={() => toggleSelectAll(activeList())}>
              全选/取消
            </button>
            <button className="btn" onClick={() => toggleFavorite(selectedIds, true)}>
              批量收藏
            </button>
            <button className="btn" onClick={() => toggleFavorite(selectedIds, false)}>
              取消收藏
            </button>
            <button className="btn" onClick={() => unarchiveItems(selectedIds)}>
              撤销归档
            </button>
            <button className="btn btn-danger" onClick={() => deleteItems(selectedIds)}>
              删除
            </button>
          </div>
        </div>
        <div className="batch-row">
          <div className="batch-group">
            <input
              ref={tagInputRef}
              className="input"
              placeholder="批量打标签"
              value={tagInput}
              onChange={(event) => setTagInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  addTags(selectedIds, tagInput);
                  setTagInput('');
                }
              }}
            />
            <button
              className="btn btn-primary"
              onClick={() => {
                addTags(selectedIds, tagInput);
                setTagInput('');
              }}
            >
              添加
            </button>
          </div>
          <div className="batch-group">
            <input
              ref={collectionInputRef}
              className="input"
              placeholder="批量归档到相簿"
              value={collectionInput}
              onChange={(event) => setCollectionInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  addToCollection(selectedIds, collectionInput);
                  setCollectionInput('');
                }
              }}
            />
            <button
              className="btn btn-primary"
              onClick={() => {
                addToCollection(selectedIds, collectionInput);
                setCollectionInput('');
              }}
            >
              归档
            </button>
          </div>
        </div>
        <div className="batch-row">
          <div className="batch-group">
            <span className="batch-label">评分</span>
            {renderRatingStars(uniformRating, (rating) => setRating(selectedIds, rating), { compact: true })}
            {selectedRatings.length > 0 && uniformRating === 0 && selectedRatings.some((r) => r > 0) ? (
              <span className="batch-hint">混合</span>
            ) : null}
          </div>
          <div className="batch-group">
            <button className="btn btn-ghost" onClick={() => setShowTagTools((prev) => !prev)}>
              {showTagTools ? '收起标签' : '标签整理'}
            </button>
          </div>
        </div>
        <div className="batch-row">
          <div className="batch-quick">
            {tags.map((tag) => (
              <button key={tag.id} className="pill" onClick={() => addTags(selectedIds, tag.name)}>
                {tag.name}
              </button>
            ))}
          </div>
          <div className="batch-quick">
            {collections.map((col) => (
              <button key={col.id} className="pill" onClick={() => addToCollection(selectedIds, col.name)}>
                {col.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  function renderBatchBarLegacy2() {
    if (!multiSelect) return null;
    const count = selectedIds.length;
    const allFavorite = selectedIds.length
      ? selectedIds.every((id) => Boolean(findItemById(id)?.favorite))
      : false;
    const selectedRatings = selectedIds.map((id) => findItemById(id)?.rating ?? 0);
    const uniformRating =
      selectedRatings.length && selectedRatings.every((rating) => rating === selectedRatings[0])
        ? selectedRatings[0]
        : 0;
    const mixedRatings = selectedRatings.length > 0 && uniformRating === 0 && selectedRatings.some((r) => r > 0);
    return (
      <div className="batch-bar glass">
        <div className="batch-row">
          <div className="batch-title">已选择 {count} 项</div>
          <div className="batch-actions">
            <button className="btn" onClick={() => toggleSelectAll(activeList())}>
              全选/取消
            </button>
            <button className="btn" onClick={() => toggleFavorite(selectedIds, !allFavorite)}>
              {allFavorite ? '取消收藏' : '批量收藏'}
            </button>
            <button className="btn btn-ghost" onClick={() => unarchiveItems(selectedIds)}>
              撤销归档
            </button>
            <button className="btn btn-danger" onClick={() => deleteItems(selectedIds)}>
              删除
            </button>
          </div>
        </div>
        <div className="batch-row">
          <div className="batch-group">
            <span className="batch-label">评分</span>
            {renderRatingStars(uniformRating, (rating) => setRating(selectedIds, rating), { compact: true })}
            {mixedRatings ? <span className="batch-hint">混合</span> : null}
          </div>
          <div className="batch-actions">
            <button className="btn btn-ghost" onClick={() => setShowTagTools((prev) => !prev)}>
              {showTagTools ? '收起标签整理' : '标签整理'}
            </button>
          </div>
        </div>
        <div className="batch-row">
          <div className="batch-quick">
            {tags.map((tag) => (
              <button key={tag.id} className="pill" onClick={() => addTags(selectedIds, tag.name)}>
                {tag.name}
              </button>
            ))}
            <button className="pill" onClick={() => setShowTagInput((prev) => !prev)}>
              {showTagInput ? '收起自定义' : '自定义标签'}
            </button>
          </div>
          <div className="batch-quick">
            {collections.map((col) => (
              <button key={col.id} className="pill" onClick={() => addToCollection(selectedIds, col.name)}>
                {col.name}
              </button>
            ))}
            <button className="pill" onClick={() => setShowCollectionInput((prev) => !prev)}>
              {showCollectionInput ? '收起相簿' : '新相簿'}
            </button>
          </div>
        </div>
        {showTagInput ? (
          <div className="batch-row">
            <div className="batch-group">
              <input
                ref={tagInputRef}
                className="input input-compact"
                placeholder="批量打标"
                value={tagInput}
                onChange={(event) => setTagInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    addTags(selectedIds, tagInput);
                    setTagInput('');
                  }
                }}
              />
              <button
                className="btn btn-primary"
                onClick={() => {
                  addTags(selectedIds, tagInput);
                  setTagInput('');
                }}
              >
                添加
              </button>
            </div>
          </div>
        ) : null}
        {showCollectionInput ? (
          <div className="batch-row">
            <div className="batch-group">
              <input
                ref={collectionInputRef}
                className="input input-compact"
                placeholder="批量归档到相簿"
                value={collectionInput}
                onChange={(event) => setCollectionInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    addToCollection(selectedIds, collectionInput);
                    setCollectionInput('');
                  }
                }}
              />
              <button
                className="btn btn-primary"
                onClick={() => {
                  addToCollection(selectedIds, collectionInput);
                  setCollectionInput('');
                }}
              >
                归档
              </button>
            </div>
          </div>
        ) : null}
        {showTagTools ? (
          <div className="batch-tools">
            <div className="batch-tools-row">
              <div className="batch-tool">
                <div className="batch-label">源标签</div>
                <input
                  className="input input-compact"
                  placeholder="要替换的标签"
                  value={tagReplaceFrom}
                  onFocus={() => setTagToolTarget('from')}
                  onChange={(event) => setTagReplaceFrom(event.target.value)}
                />
              </div>
              <div className="batch-tool">
                <div className="batch-label">目标标签</div>
                <input
                  className="input input-compact"
                  placeholder="替换为的标签"
                  value={tagReplaceTo}
                  onFocus={() => setTagToolTarget('to')}
                  onChange={(event) => setTagReplaceTo(event.target.value)}
                />
              </div>
              <div className="batch-tool-actions">
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    void replaceTags(selectedIds, tagReplaceFrom, tagReplaceTo, 'replace');
                  }}
                >
                  替换
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    void replaceTags(selectedIds, tagReplaceFrom, tagReplaceTo, 'merge');
                  }}
                >
                  合并
                </button>
              </div>
            </div>
            <div className="batch-tool-tags">
              <div className="batch-hint">
                点击标签填入{tagToolTarget === 'from' ? '源标签' : '目标标签'}
              </div>
              <div className="batch-quick">
                {tags.map((tag) => (
                  <button
                    key={tag.id}
                    className="pill"
                    onClick={() =>
                      tagToolTarget === 'from' ? setTagReplaceFrom(tag.name) : setTagReplaceTo(tag.name)
                    }
                  >
                    {tag.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}
        <div className="batch-row batch-row-footer">
          <div className="batch-actions">
            <button className="btn btn-ghost" onClick={() => setMultiSelect(false)}>
              关闭
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderBatchBar() {
    if (!multiSelect) return null;
    const count = selectedIds.length;
    const selectedItems = selectedIds
      .map((id) => findItemById(id))
      .filter((item): item is MediaItem => Boolean(item));
    const tagLists = selectedItems.map((item) => item.tags ?? []);
    const collectionLists = selectedItems.map((item) => item.collections ?? []);
    const commonTags = intersectStrings(tagLists);
    const commonCollections = intersectStrings(collectionLists);
    const allFavorite = selectedItems.length ? selectedItems.every((item) => item.favorite) : false;
    const selectedRatings = selectedItems.map((item) => item.rating ?? 0);
    const uniformRating =
      selectedRatings.length && selectedRatings.every((rating) => rating === selectedRatings[0])
        ? selectedRatings[0]
        : 0;
    const mixedRatings = selectedRatings.length > 0 && uniformRating === 0 && selectedRatings.some((r) => r > 0);
    const commonTagSet = new Set(commonTags);
    const commonCollectionSet = new Set(commonCollections);
    const quickTags = tags.filter((tag) => !commonTagSet.has(tag.name)).slice(0, TAGS_QUICK_LIMIT);
    const quickCollections = collections
      .filter((col) => !commonCollectionSet.has(col.name))
      .slice(0, COLLECTIONS_QUICK_LIMIT);
    return (
      <div className="batch-bar glass">
        <div className="batch-row batch-row-head">
          <div className="batch-title">已选择 {count} 项</div>
          <div className="batch-actions">
            <button className="btn btn-ghost" onClick={() => toggleSelectAll(activeList())}>
              全选 / 取消
            </button>
            <button className="btn" onClick={() => toggleFavorite(selectedIds, !allFavorite)}>
              {allFavorite ? '取消收藏' : '批量收藏'}
            </button>
            <button className="btn btn-ghost" onClick={() => unarchiveItems(selectedIds)}>
              撤销归档
            </button>
            <button className="btn btn-danger" onClick={() => deleteItems(selectedIds)}>
              删除
            </button>
          </div>
        </div>
        <div className="batch-row batch-row-mid">
          <div className="batch-group">
            <span className="batch-label">评分</span>
            {renderRatingStars(uniformRating, (rating) => setRating(selectedIds, rating), { compact: true })}
            {mixedRatings ? <span className="batch-hint">混合</span> : null}
          </div>
          <div className="batch-actions">
            <button className="btn btn-ghost" onClick={() => setShowTagTools((prev) => !prev)}>
              {showTagTools ? '收起标签整理' : '标签整理'}
            </button>
          </div>
        </div>
        <div className="batch-grid">
          <div className="batch-section">
            {commonTags.length ? (
              <>
                <div className="batch-row-header">
                  <span className="batch-section-title">已打标签</span>
                  <span className="batch-hint">{commonTags.length} 个</span>
                </div>
                <div className="batch-chip-row">
                  {commonTags.map((name) => (
                    <button
                      key={`common-${name}`}
                      className="pill pill-applied"
                      onClick={() => {
                        const ids = idsWithTag(selectedIds, name);
                        if (ids.length) removeTags(ids, name);
                      }}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            <div className="batch-row-header">
              <span className="batch-section-title">常用标签</span>
              <button className="pill pill-soft" onClick={() => setShowBatchTagInput((prev) => !prev)}>
                {showBatchTagInput ? '收起自定义' : '自定义'}
              </button>
            </div>
            <div className="batch-chip-row">
              {quickTags.map((tag) => (
                <button key={tag.id} className="pill" onClick={() => addTags(selectedIds, tag.name)}>
                  {tag.name}
                </button>
              ))}
            </div>
            {showBatchTagInput ? (
              <div className="inline-input">
                <input
                  ref={tagInputRef}
                  className="input input-compact"
                  placeholder="批量打标"
                  value={tagInput}
                  onChange={(event) => setTagInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      addTags(selectedIds, tagInput);
                      setTagInput('');
                    }
                  }}
                />
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    addTags(selectedIds, tagInput);
                    setTagInput('');
                  }}
                >
                  添加
                </button>
              </div>
            ) : null}
          </div>
          <div className="batch-section">
            {commonCollections.length ? (
              <>
                <div className="batch-row-header">
                  <span className="batch-section-title">已归档相簿</span>
                  <span className="batch-hint">{commonCollections.length} 个</span>
                </div>
                <div className="batch-chip-row">
                  {commonCollections.map((name) => (
                    <button
                      key={`common-col-${name}`}
                      className="pill pill-applied"
                      onClick={() => {
                        const ids = idsWithCollection(selectedIds, name);
                        if (ids.length) removeFromCollection(ids, name);
                      }}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            <div className="batch-row-header">
              <span className="batch-section-title">可选相簿</span>
              <button className="pill pill-soft" onClick={() => setShowBatchCollectionInput((prev) => !prev)}>
                {showBatchCollectionInput ? '收起新相簿' : '新相簿'}
              </button>
            </div>
            <div className="batch-chip-row">
              {quickCollections.map((col) => (
                <button key={col.id} className="pill" onClick={() => addToCollection(selectedIds, col.name)}>
                  {col.name}
                </button>
              ))}
            </div>
            {showBatchCollectionInput ? (
              <div className="inline-input">
                <input
                  ref={collectionInputRef}
                  className="input input-compact"
                  placeholder="批量归档到相簿"
                  value={collectionInput}
                  onChange={(event) => setCollectionInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      addToCollection(selectedIds, collectionInput);
                      setCollectionInput('');
                    }
                  }}
                />
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    addToCollection(selectedIds, collectionInput);
                    setCollectionInput('');
                  }}
                >
                  归档
                </button>
              </div>
            ) : null}
          </div>
        </div>
        {showTagTools ? (
          <div className="batch-tools">
            <div className="batch-tools-row">
              <div className="batch-tool">
                <div className="batch-label">源标签</div>
                <input
                  className="input input-compact"
                  placeholder="要替换的标签"
                  value={tagReplaceFrom}
                  onFocus={() => setTagToolTarget('from')}
                  onChange={(event) => setTagReplaceFrom(event.target.value)}
                />
              </div>
              <div className="batch-tool">
                <div className="batch-label">目标标签</div>
                <input
                  className="input input-compact"
                  placeholder="替换成的标签"
                  value={tagReplaceTo}
                  onFocus={() => setTagToolTarget('to')}
                  onChange={(event) => setTagReplaceTo(event.target.value)}
                />
              </div>
              <div className="batch-tool-actions">
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    void replaceTags(selectedIds, tagReplaceFrom, tagReplaceTo, 'replace');
                  }}
                >
                  替换
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    void replaceTags(selectedIds, tagReplaceFrom, tagReplaceTo, 'merge');
                  }}
                >
                  合并
                </button>
              </div>
            </div>
            <div className="batch-tool-tags">
              <div className="batch-hint">
                点击标签填入{tagToolTarget === 'from' ? '源标签' : '目标标签'}
              </div>
              <div className="batch-quick">
                {quickTags.map((tag) => (
                  <button
                    key={tag.id}
                    className="pill"
                    onClick={() =>
                      tagToolTarget === 'from' ? setTagReplaceFrom(tag.name) : setTagReplaceTo(tag.name)
                    }
                  >
                    {tag.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}
        <div className="batch-row batch-row-footer">
          <button className="btn" onClick={() => setMultiSelect(false)}>
            关闭
          </button>
        </div>
      </div>
    );
  }

  function renderAlbumPreviewCard(input: {
    title: string;
    subtitle?: string;
    items: MediaItem[];
    onClick?: () => void;
    tone?: 'warm' | 'cool' | 'accent';
  }) {
    const urls = getPreviewUrls(input.items);
    return (
      <button
        className={`album-preview-card glass ${input.tone ? `album-preview-${input.tone}` : ''}`}
        onClick={input.onClick}
      >
        <div className="album-preview-frames">
          {urls.map((src, index) => (
            <img
              key={`${src}-${index}`}
              className="album-preview-frame"
              style={{ '--i': index } as React.CSSProperties}
              src={src}
              alt=""
              loading="lazy"
            />
          ))}
          {urls.length === 0 ? <div className="album-preview-empty">空相簿</div> : null}
        </div>
        <div className="album-preview-meta">
          <div className="album-preview-title">{input.title}</div>
          <div className="album-preview-sub">{input.subtitle ?? `${input.items.length} 张预览`}</div>
        </div>
      </button>
    );
  }

  function renderAlbumPreviewRow() {
    if (!collections.length && !unarchivedPreview.length && !previewLoading) {
      return null;
    }
    const previewCollections = collections.slice(0, PREVIEW_COLLECTION_LIMIT);
    return (
      <div className="album-preview-row glass">
        <div className="album-preview-header">
          <div>
            <div className="h-title text-lg">相簿预览</div>
            <div className="muted-text">点击卡片即可快速筛选或进入归档。</div>
          </div>
          {previewLoading ? (
            <div className="pill loading-pill">
              <span className="loading-dot" />
              生成预览
            </div>
          ) : null}
        </div>
        <div className="album-preview-grid">
          {renderAlbumPreviewCard({
            title: '未归档',
            subtitle: '优先处理',
            items: unarchivedPreview,
            onClick: jumpToUnarchived,
            tone: 'warm',
          })}
          {previewCollections.map((col, index) =>
            renderAlbumPreviewCard({
              title: col.name,
              subtitle: `${collectionPreviews[col.name]?.length ?? 0} 张预览`,
              items: collectionPreviews[col.name] ?? [],
              onClick: () => jumpToCollection(col.name),
              tone: index % 2 === 0 ? 'cool' : 'accent',
            }),
          )}
        </div>
      </div>
    );
  }

  function renderFiltersLegacy() {
    return (
      <div className="filters glass">
        <div className="filters-row">
          <div className="filters-group">
            <input
              className="input"
              placeholder="搜索链接、标签、来源"
              value={filtersDraft.q}
              onChange={(event) => setFiltersDraft({ ...filtersDraft, q: event.target.value })}
            />
            <select
              className="input"
              value={filtersDraft.type}
              onChange={(event) =>
                setFiltersDraft({ ...filtersDraft, type: event.target.value as MediaTypeFilter })
              }
            >
              <option value="all">全部类型</option>
              <option value="image">图片</option>
              <option value="video">视频/GIF</option>
            </select>
            <select
              className="input"
              value={filtersDraft.archived}
              onChange={(event) =>
                setFiltersDraft({ ...filtersDraft, archived: event.target.value as Filters['archived'] })
              }
            >
              <option value="all">全部归档状态</option>
              <option value="no">未归档</option>
              <option value="yes">已归档</option>
            </select>
          </div>
          <div className="filters-group">
            <input
              className="input"
              placeholder="来源账号"
              value={filtersDraft.authorHandle}
              onChange={(event) => setFiltersDraft({ ...filtersDraft, authorHandle: event.target.value })}
            />
            <input
              className="input"
              placeholder="标签"
              value={filtersDraft.tag}
              onChange={(event) => setFiltersDraft({ ...filtersDraft, tag: event.target.value })}
            />
            <input
              className="input"
              placeholder="相簿"
              value={filtersDraft.collection}
              onChange={(event) => setFiltersDraft({ ...filtersDraft, collection: event.target.value })}
            />
          </div>
          <div className="filters-group">
            <input
              className="input"
              type="date"
              value={filtersDraft.from}
              onChange={(event) => setFiltersDraft({ ...filtersDraft, from: event.target.value })}
            />
            <input
              className="input"
              type="date"
              value={filtersDraft.to}
              onChange={(event) => setFiltersDraft({ ...filtersDraft, to: event.target.value })}
            />
            <div className="filters-actions">
              <button className="btn btn-primary" onClick={applyFilters}>
                应用筛选
              </button>
              <button className="btn" onClick={resetFilters}>
                重置
              </button>
              <button className="btn" onClick={() => setMultiSelect((prev) => !prev)}>
                {multiSelect ? '退出多选' : '多选'}
              </button>
            </div>
          </div>
        </div>
        <div className="filters-row">
          <div className="filters-quick">
            <div className="filters-label">常用标签</div>
            <div className="filters-chips">
              {tags.map((tag) => {
                const active = filtersDraft.tag === tag.name;
                return (
                  <button
                    key={tag.id}
                    className={`pill ${active ? 'pill-active' : ''}`}
                    onClick={() => applyFilterPatch({ tag: active ? '' : tag.name })}
                  >
                    {tag.name}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="filters-quick">
            <div className="filters-label">相簿</div>
            <div className="filters-chips">
              {collections.map((col) => {
                const active = filtersDraft.collection === col.name;
                return (
                  <button
                    key={col.id}
                    className={`pill ${active ? 'pill-active' : ''}`}
                    onClick={() => applyFilterPatch({ collection: active ? '' : col.name })}
                  >
                    {col.name}
                  </button>
                );
              })}
            </div>
            <div className="filters-create">
              <input
                className="input"
                placeholder="新建相簿并归档"
                value={collectionQuickInput}
                onChange={(event) => setCollectionQuickInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    createOrCollect(collectionQuickInput, actionIds);
                    setCollectionQuickInput('');
                  }
                }}
              />
              <button
                className="btn btn-primary"
                onClick={() => {
                  createOrCollect(collectionQuickInput, actionIds);
                  setCollectionQuickInput('');
                }}
              >
                创建并归档
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderFilters() {
    const recentRange = getRecentRange(7);
    const isRecent = filtersDraft.from === recentRange.from && filtersDraft.to === recentRange.to;
    const quickTags = tags.slice(0, TAGS_QUICK_LIMIT);
    const favoriteActive = route === 'favorites' || filtersDraft.favoriteOnly;
    return (
      <div className="filters glass">
        <div className="filters-row">
          <div className="filters-search">
            <input
              className="input input-search"
              placeholder="搜索图像、标签、来源"
              value={filtersDraft.q}
              onChange={(event) => setFiltersDraft({ ...filtersDraft, q: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') applyFilters();
              }}
            />
            <div className="input-hint">回车搜索</div>
          </div>
          <div className="filters-quick">
            <div className="filters-label">类型</div>
            <div className="filters-chips">
              {[
                { key: 'all', label: '全部' },
                { key: 'image', label: '图片' },
                { key: 'video', label: '视频/GIF' },
              ].map((item) => (
                <button
                  key={item.key}
                  className={`pill ${filtersDraft.type === item.key ? 'pill-active' : ''}`}
                  onClick={() => applyFilterPatch({ type: item.key as MediaTypeFilter })}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="filters-quick">
            <div className="filters-label">归档</div>
            <div className="filters-chips">
              {[
                { key: 'all', label: '全部' },
                { key: 'no', label: '未归档' },
                { key: 'yes', label: '已归档' },
              ].map((item) => (
                <button
                  key={item.key}
                  className={`pill ${filtersDraft.archived === item.key ? 'pill-active' : ''}`}
                  onClick={() => applyFilterPatch({ archived: item.key as Filters['archived'] })}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="filters-actions">
            <button
              className={`pill ${showAdvancedFilters ? 'pill-active' : ''}`}
              onClick={() => setShowAdvancedFilters((prev) => !prev)}
            >
              {showAdvancedFilters ? '收起筛选' : '高级筛选'}
            </button>
            <button className={`pill ${multiSelect ? 'pill-active' : ''}`} onClick={() => setMultiSelect((prev) => !prev)}>
              {multiSelect ? '已开启多选' : '多选'}
            </button>
          </div>
        </div>
        <div className="filters-row">
          <div className="filters-quick filters-quickline">
            <div className="filters-label">快捷</div>
            <div className="filters-chips">
              <button
                className={`pill ${favoriteActive ? 'pill-active' : ''}`}
                onClick={() => {
                  if (route === 'favorites') {
                    window.location.hash = '#/library';
                    applyFilterPatch({ favoriteOnly: false });
                    return;
                  }
                  applyFilterPatch({ favoriteOnly: !filtersDraft.favoriteOnly });
                }}
              >
                收藏
              </button>
              <button
                className={`pill ${filtersDraft.archived === 'no' ? 'pill-active' : ''}`}
                onClick={() => applyFilterPatch({ archived: 'no' })}
              >
                未归档
              </button>
              <button className={`pill ${isRecent ? 'pill-active' : ''}`} onClick={() => applyFilterPatch(recentRange)}>
                近 7 天
              </button>
              <button
                className={`pill ${filtersDraft.tagPresence === 'untagged' ? 'pill-active' : ''}`}
                onClick={() => applyFilterPatch({ tagPresence: 'untagged', tag: '' })}
              >
                无标签
              </button>
              <button
                className={`pill ${filtersDraft.tagPresence === 'tagged' ? 'pill-active' : ''}`}
                onClick={() => applyFilterPatch({ tagPresence: 'tagged', tag: '' })}
              >
                已打标
              </button>
              <button className="pill" onClick={resetFilters}>
                重置
              </button>
            </div>
          </div>
        </div>
        {showAdvancedFilters ? (
          <div className="filters-advanced">
            <div className="filters-row">
              <div className="filters-group">
                <input
                  className="input"
                  placeholder="来源账号"
                  value={filtersDraft.authorHandle}
                  onChange={(event) => setFiltersDraft({ ...filtersDraft, authorHandle: event.target.value })}
                />
                <input
                  className="input"
                  placeholder="标签"
                  value={filtersDraft.tag}
                  onChange={(event) => setFiltersDraft({ ...filtersDraft, tag: event.target.value })}
                />
                <input
                  className="input"
                  placeholder="相簿"
                  value={filtersDraft.collection}
                  onChange={(event) => setFiltersDraft({ ...filtersDraft, collection: event.target.value })}
                />
              </div>
              <div className="filters-group">
                <input
                  className="input"
                  type="date"
                  value={filtersDraft.from}
                  onChange={(event) => setFiltersDraft({ ...filtersDraft, from: event.target.value })}
                />
                <input
                  className="input"
                  type="date"
                  value={filtersDraft.to}
                  onChange={(event) => setFiltersDraft({ ...filtersDraft, to: event.target.value })}
                />
                <div className="filters-actions">
                  <button className="btn btn-primary" onClick={applyFilters}>
                    应用筛选
                  </button>
                  <button className="btn btn-ghost" onClick={resetFilters}>
                    清空
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
        <div className="filters-row">
          <div className="filters-quick">
            <div className="filters-label">常用标签</div>
            <div className="filters-chips">
              {quickTags.map((tag) => (
                <button
                  key={tag.id}
                  className={`pill ${filtersDraft.tag === tag.name ? 'pill-active' : ''}`}
                  onClick={() =>
                    applyFilterPatch({ tag: filtersDraft.tag === tag.name ? '' : tag.name })
                  }
                >
                  {tag.name}
                </button>
              ))}
              <button className="pill" onClick={() => setShowTagInput((prev) => !prev)}>
                {showTagInput ? '收起自定义' : '自定义'}
              </button>
            </div>
            {showTagInput ? (
              <div className="inline-input">
                <input
                  ref={tagInputRef}
                  className="input input-compact"
                  placeholder="自定义标签"
                  value={tagInput}
                  onChange={(event) => setTagInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      applyFilterPatch({ tag: tagInput.trim() });
                      setTagInput('');
                    }
                  }}
                />
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    applyFilterPatch({ tag: tagInput.trim() });
                    setTagInput('');
                  }}
                >
                  添加
                </button>
              </div>
            ) : null}
          </div>
          <div className="filters-quick">
            <div className="filters-label">相簿</div>
            <div className="filters-chips">
              {collections.map((col) => (
                <button
                  key={col.id}
                  className={`pill ${filtersDraft.collection === col.name ? 'pill-active' : ''}`}
                  onClick={() =>
                    applyFilterPatch({
                      collection: filtersDraft.collection === col.name ? '' : col.name,
                    })
                  }
                >
                  {col.name}
                </button>
              ))}
              <button className="pill" onClick={() => setShowCollectionInput((prev) => !prev)}>
                {showCollectionInput ? '收起新相簿' : '新相簿'}
              </button>
            </div>
            {showCollectionInput ? (
              <div className="inline-input">
                <input
                  className="input input-compact"
                  placeholder="新建相簿并归档"
                  value={collectionInput}
                  onChange={(event) => setCollectionInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      applyFilterPatch({ collection: collectionInput.trim() });
                      setCollectionInput('');
                    }
                  }}
                />
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    applyFilterPatch({ collection: collectionInput.trim() });
                    setCollectionInput('');
                  }}
                >
                  创建
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  function renderLibrary() {
    return (
      <div className="page page-paged">
        {renderFilters()}
        {renderAlbumPreviewRow()}
        {renderBatchBar()}
        {libraryFeed.error ? <div className="error-state">{libraryFeed.error}</div> : null}
        {renderMediaGrid(libraryFeed.items)}
        {libraryFeed.loaded || libraryFeed.loading
          ? renderPager({
              pagerKey: 'library',
              page: libraryPage,
              hasNext: libraryPageCount ? libraryPage + 1 < libraryPageCount : libraryFeed.nextOffset > 0,
              loading: libraryFeed.loading,
              onPrev: () => setLibraryPage((prev) => Math.max(0, prev - 1)),
              onNext: () =>
                setLibraryPage((prev) =>
                  libraryPageCount ? Math.min(libraryPageCount - 1, prev + 1) : prev + 1,
                ),
              onJump: (page) =>
                setLibraryPage(Math.max(0, libraryPageCount ? Math.min(libraryPageCount - 1, page) : page)),
              totalPages: libraryPageCount,
              totalCount: libraryFeed.totalCount,
            })
          : null}
      </div>
    );
  }

  function renderFavorites() {
    return (
      <div className="page page-paged">
        {renderFilters()}
        {renderBatchBar()}
        {favoritesFeed.error ? <div className="error-state">{favoritesFeed.error}</div> : null}
        {renderMediaGrid(favoritesFeed.items)}
        {favoritesFeed.loaded || favoritesFeed.loading
          ? renderPager({
              pagerKey: 'favorites',
              page: favoritesPage,
              hasNext: favoritesPageCount ? favoritesPage + 1 < favoritesPageCount : favoritesFeed.nextOffset > 0,
              loading: favoritesFeed.loading,
              onPrev: () => setFavoritesPage((prev) => Math.max(0, prev - 1)),
              onNext: () =>
                setFavoritesPage((prev) =>
                  favoritesPageCount ? Math.min(favoritesPageCount - 1, prev + 1) : prev + 1,
                ),
              onJump: (page) =>
                setFavoritesPage(Math.max(0, favoritesPageCount ? Math.min(favoritesPageCount - 1, page) : page)),
              totalPages: favoritesPageCount,
              totalCount: favoritesFeed.totalCount,
            })
          : null}
      </div>
    );
  }

  function renderTimeline() {
    const recentRange = getRecentRange(7);
    const monthRange = getRecentRange(30);
    const isRecent = filtersDraft.from === recentRange.from && filtersDraft.to === recentRange.to;
    const isMonth = filtersDraft.from === monthRange.from && filtersDraft.to === monthRange.to;
    const dayCount =
      typeof timelineDays.totalCount === 'number' ? timelineDays.totalCount : timelineDays.items.length;
    const itemCount =
      typeof timelineItems.totalCount === 'number' ? timelineItems.totalCount : timelineItems.items.length;
    const dayHasNext = timelineDayPageCount
      ? timelineDayPage + 1 < timelineDayPageCount
      : timelineDays.items.length === TIMELINE_DAY_PAGE_SIZE;
    const itemHasNext = timelineItemsPageCount
      ? timelineItemsPage + 1 < timelineItemsPageCount
      : timelineItems.nextOffset > 0;
    return (
      <div className="page page-paged">
        {renderFilters()}
        <div className="timeline-toolbar glass">
          <div className="filters-row">
            <div className="filters-quick timeline-range">
              <div className="filters-label">时间范围</div>
              <div className="timeline-range-inputs">
                <input
                  className="input input-compact"
                  type="date"
                  value={filtersDraft.from}
                  onChange={(event) => setFiltersDraft({ ...filtersDraft, from: event.target.value })}
                />
                <span className="muted-text">-</span>
                <input
                  className="input input-compact"
                  type="date"
                  value={filtersDraft.to}
                  onChange={(event) => setFiltersDraft({ ...filtersDraft, to: event.target.value })}
                />
              </div>
            </div>
            <div className="filters-quick">
              <div className="filters-label">快捷</div>
              <div className="filters-chips">
                <button className={`pill ${isRecent ? 'pill-active' : ''}`} onClick={() => applyFilterPatch(recentRange)}>
                  近7天
                </button>
                <button className={`pill ${isMonth ? 'pill-active' : ''}`} onClick={() => applyFilterPatch(monthRange)}>
                  近30天
                </button>
                <button className="pill" onClick={() => applyFilterPatch({ from: '', to: '' })}>
                  清除
                </button>
              </div>
            </div>
            <div className="filters-actions">
              <button className="btn btn-primary" onClick={applyTimelineRange}>
                应用时间
              </button>
            </div>
          </div>
        </div>
        {timelineDays.error ? <div className="error-state">{timelineDays.error}</div> : null}
        <div className="timeline-layout">
          <div className="timeline-days glass">
            <div className="timeline-days-header">
              <div className="h-title text-lg">按日期</div>
              <div className="muted-text">{dayCount ? `共 ${dayCount} 天` : '暂无日期'}</div>
            </div>
            <div className="timeline-days-list">
              {timelineDays.loading ? <div className="loading-row">正在加载日期...</div> : null}
              {!timelineDays.loading && timelineDays.items.length === 0 && timelineDays.loaded ? (
                <div className="empty-state">暂无内容</div>
              ) : null}
              {timelineDays.items.map((item) => {
                const active = timelineSelectedDay === item.day;
                return (
                  <button
                    key={item.day}
                    className={`timeline-day ${active ? 'active' : ''}`}
                    onClick={() => selectTimelineDay(item.day)}
                  >
                    <div className="timeline-day-main">
                      <div className="timeline-day-date">{item.day}</div>
                      <div className="timeline-day-hint">{item.count} 张</div>
                    </div>
                    {active ? <span className="timeline-day-badge">当前</span> : null}
                  </button>
                );
              })}
            </div>
            {timelineDays.loaded || timelineDays.loading
              ? renderPager({
                  pagerKey: 'timeline-days',
                  page: timelineDayPage,
                  hasNext: dayHasNext,
                  loading: timelineDays.loading,
                  onPrev: () => setTimelineDayPage((prev) => Math.max(0, prev - 1)),
                  onNext: () =>
                    setTimelineDayPage((prev) =>
                      timelineDayPageCount ? Math.min(timelineDayPageCount - 1, prev + 1) : prev + 1,
                    ),
                  onJump: (page) =>
                    setTimelineDayPage(
                      Math.max(0, timelineDayPageCount ? Math.min(timelineDayPageCount - 1, page) : page),
                    ),
                  totalPages: timelineDayPageCount,
                  totalCount: timelineDays.totalCount,
                })
              : null}
          </div>
          <div className="timeline-items">
            <div className="timeline-items-header glass">
              <div>
                <div className="h-title text-lg">{timelineSelectedDay ?? '选择日期'}</div>
                <div className="muted-text">
                  {timelineSelectedDay ? `共 ${itemCount} 张` : '请选择日期查看内容'}
                </div>
              </div>
              <div className="timeline-items-actions">
                <button
                  className="btn btn-ghost"
                  onClick={() => selectTimelineDay(timelineDays.items[0]?.day ?? null)}
                  disabled={!timelineDays.items.length}
                >
                  最近日期
                </button>
              </div>
            </div>
            {timelineItems.error ? <div className="error-state">{timelineItems.error}</div> : null}
            {timelineSelectedDay && timelineItems.loading ? (
              <div className="loading-row">正在加载内容...</div>
            ) : null}
            {timelineSelectedDay &&
            !timelineItems.loading &&
            timelineItems.items.length === 0 &&
            timelineItems.loaded ? (
              <div className="empty-state">该日期暂无内容</div>
            ) : null}
            {!timelineSelectedDay && timelineDays.loaded ? <div className="empty-state">请选择日期</div> : null}
            {timelineSelectedDay && timelineItems.items.length > 0 ? renderMediaGrid(timelineItems.items) : null}
            {timelineItems.loaded || timelineItems.loading
              ? renderPager({
                  pagerKey: 'timeline-items',
                  page: timelineItemsPage,
                  hasNext: itemHasNext,
                  loading: timelineItems.loading,
                  onPrev: () => setTimelineItemsPage((prev) => Math.max(0, prev - 1)),
                  onNext: () =>
                    setTimelineItemsPage((prev) =>
                      timelineItemsPageCount ? Math.min(timelineItemsPageCount - 1, prev + 1) : prev + 1,
                    ),
                  onJump: (page) =>
                    setTimelineItemsPage(
                      Math.max(0, timelineItemsPageCount ? Math.min(timelineItemsPageCount - 1, page) : page),
                    ),
                  totalPages: timelineItemsPageCount,
                  totalCount: timelineItems.totalCount,
                })
              : null}
          </div>
        </div>
      </div>
    );
  }

  function renderBoard() {
    return (
      <div className="page">
        <div className="board-header glass">
          <div>
            <div className="h-title text-xl">相簿看板</div>
            <div className="muted-text">浏览各相簿与未归档队列，点击即可查看细节。</div>
          </div>
          <div className="board-actions">
            <button className="btn btn-ghost" onClick={loadBoard}>
              刷新
            </button>
            <button
              className={`btn ${showCreateCollection ? 'btn-primary' : ''}`}
              onClick={() => setShowCreateCollection((prev) => !prev)}
            >
              {showCreateCollection ? '关闭新相簿' : '新相簿'}
            </button>
          </div>
        </div>
        {showCreateCollection ? (
          <div className="board-create glass">
            <input
              className="input input-compact"
              placeholder="新相簿名"
              value={collectionCreateInput}
              onChange={(event) => setCollectionCreateInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  createOrCollect(collectionCreateInput, actionIds);
                  setCollectionCreateInput('');
                }
              }}
            />
            <button
              className="btn btn-primary"
              onClick={() => {
                createOrCollect(collectionCreateInput, actionIds);
                setCollectionCreateInput('');
              }}
            >
              创建并归档
            </button>
          </div>
        ) : null}
        {renderAlbumPreviewRow()}
        {boardError ? <div className="error-state">{boardError}</div> : null}
        {boardLoading ? <div className="loading-row">正在加载看板...</div> : null}
        <div className="board">
          {boardColumns.map((col) => {
            const page = boardPageMap[col.key] ?? 0;
            const totalPages = getTotalPages(col.totalCount ?? null, BOARD_COL_PAGE_SIZE);
            const hasNext = totalPages ? page + 1 < totalPages : col.items.length === BOARD_COL_PAGE_SIZE;
            const showPager = totalPages ? totalPages > 1 : page > 0 || hasNext;
            return (
              <div key={col.key} className="board-col glass">
                <div className="board-col-header">
                  <div className="board-col-title">{col.title}</div>
                  {col.hint ? <div className="board-col-hint">{col.hint}</div> : null}
                  {typeof col.totalCount === 'number' ? (
                    <div className="board-col-meta">共 {col.totalCount} 张</div>
                  ) : null}
                </div>
                <div className="board-col-body">
                  {col.loading ? <div className="loading-row">正在加载...</div> : null}
                  {!col.loading && col.items.length === 0 ? <div className="empty-state">空相簿</div> : null}
                  {col.items.map((item) => (
                    <button key={item.id} className="board-card" onClick={() => setSelectedId(item.id)}>
                      <img src={item.thumbUrl ?? item.fileUrl} alt="media" loading="lazy" />
                      <div className="board-card-meta">
                        <span>{item.tags.slice(0, 1).join(' ') || '未标记'}</span>
                        <span>{item.favorite ? '已收藏' : ''}</span>
                      </div>
                    </button>
                  ))}
                </div>
                {showPager
                  ? renderPager({
                      pagerKey: `board-${col.key}`,
                      page,
                      hasNext,
                      loading: Boolean(col.loading),
                      totalPages,
                      totalCount: typeof col.totalCount === 'number' ? col.totalCount : null,
                      onPrev: () => {
                        const next = Math.max(0, page - 1);
                        setBoardPageMap((prev) => ({ ...prev, [col.key]: next }));
                        loadBoardColumn(col, next);
                      },
                      onNext: () => {
                        const next = totalPages ? Math.min(totalPages - 1, page + 1) : page + 1;
                        setBoardPageMap((prev) => ({ ...prev, [col.key]: next }));
                        loadBoardColumn(col, next);
                      },
                      onJump: (nextPage) => {
                        const bounded = totalPages ? Math.min(totalPages - 1, nextPage) : nextPage;
                        setBoardPageMap((prev) => ({ ...prev, [col.key]: Math.max(0, bounded) }));
                        loadBoardColumn(col, Math.max(0, bounded));
                      },
                    })
                  : null}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function renderArchiveLegacy() {
    if (archiveFeed.error) {
      return <div className="error-state">{archiveFeed.error}</div>;
    }
    if (archiveFeed.loaded && archiveFeed.items.length === 0) {
      return <div className="empty-state">所有内容都已归档，可以去图库或收藏看看。</div>;
    }
    return (
      <div className="archive-page">
        <div className="archive-header glass">
          <div>
            <div className="h-title text-xl">归档模式</div>
            <div className="muted-text">{ARCHIVE_HINT}</div>
          </div>
          <div className="archive-actions">
            <button className="btn" onClick={() => loadArchive('reset')}>
              刷新队列
            </button>
            <div className="pill">
              进度 {archiveIndex + 1}/{archiveFeed.items.length || 1}
            </div>
          </div>
        </div>
        <div className="archive-view">
          <div className="archive-main glass">
            {archiveItem ? (
              <>
                <div className="archive-media">
                  {archiveItem.type === 'video' ? (
                    <video src={archiveItem.fileUrl} controls poster={archiveItem.thumbUrl ?? undefined} />
                  ) : (
                    <img src={archiveItem.fileUrl} alt="archive" />
                  )}
                </div>
                <div className="archive-toolbar">
                  <button className="btn btn-ghost" onClick={() => moveArchive(-1)}>
                    上一张
                  </button>
                  <button className="btn btn-ghost" onClick={() => moveArchive(1)}>
                    下一张
                  </button>
                  <button
                    className={`btn ${archiveItem.favorite ? 'btn-primary' : ''}`}
                    onClick={() => toggleFavorite([archiveItem.id], !archiveItem.favorite)}
                  >
                    {archiveItem.favorite ? '取消收藏' : '收藏'}
                  </button>
                  <button className="btn btn-danger" onClick={() => deleteItems([archiveItem.id])}>
                    删除
                  </button>
                  <button className="btn" onClick={undoLastAction}>
                    撤销
                  </button>
                </div>
              </>
            ) : (
              <div className="loading-row">正在加载...</div>
            )}
          </div>
          <div className="archive-side glass">
            {archiveItem ? (
              <>
                <div className="section">
                  <div className="section-title">快速归档</div>
                  <div className="chip-grid">
                    {collections.map((col) => (
                      <button
                        key={col.id}
                        className="pill"
                        onClick={() => addToCollection([archiveItem.id], col.name)}
                      >
                        {col.name}
                      </button>
                    ))}
                  </div>
                  <div className="inline-input">
                    <input
                      ref={collectionInputRef}
                      className="input"
                      placeholder="新相簿名称"
                      value={collectionInput}
                      onChange={(event) => setCollectionInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          addToCollection([archiveItem.id], collectionInput);
                          setCollectionInput('');
                        }
                      }}
                    />
                    <button
                      className="btn btn-primary"
                      onClick={() => {
                        addToCollection([archiveItem.id], collectionInput);
                        setCollectionInput('');
                      }}
                    >
                      归档
                    </button>
                  </div>
                </div>
                <div className="section">
                  <div className="section-title">评分</div>
                  {renderRatingStars(archiveItem.rating ?? 0, (rating) => setRating([archiveItem.id], rating))}
                </div>
                <div className="section">
                  <div className="section-title">标签</div>
                  {appliedTags.length ? (
                    <div className="chip-grid chip-grid-applied">
                      {appliedTags.map((name) => (
                        <button
                          key={`applied-${name}`}
                          className="pill pill-applied"
                          onClick={() => removeTags([archiveItem.id], name)}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div className="chip-grid chip-grid-common">
                    {availableTags.map((tag) => (
                      <button key={tag.id} className="pill" onClick={() => addTags([archiveItem.id], tag.name)}>
                        {tag.name}
                      </button>
                    ))}
                  </div>
                  <div className="inline-input">
                    <input
                      ref={tagInputRef}
                      className="input"
                      placeholder="添加标签"
                      value={tagInput}
                      onChange={(event) => setTagInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          addTags([archiveItem.id], tagInput);
                          setTagInput('');
                        }
                      }}
                    />
                    <button
                      className="btn btn-primary"
                      onClick={() => {
                        addTags([archiveItem.id], tagInput);
                        setTagInput('');
                      }}
                    >
                      添加
                    </button>
                  </div>
                </div>
                <div className="section">
                  <div className="section-title">来源</div>
                  <div className="meta-list">
                    {archiveItem.sources.map((source, index) => (
                      <div key={`${source.tweetUrl ?? 'src'}-${index}`} className="meta-row">
                        <div>
                          {source.authorHandle
                            ? `@${source.authorHandle}`
                            : getSourceHost(source.sourcePageUrl ?? source.tweetUrl) ?? '未知来源'}
                        </div>
                        <div className="muted-text">{formatDateTime(source.collectedAt)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>
        <div className="archive-strip">
          {archiveFeed.items.map((item, idx) => (
            <button
              key={item.id}
              className={`strip-item ${idx === archiveIndex ? 'strip-item-active' : ''}`}
              onClick={() => setArchiveIndex(idx)}
            >
              <img src={item.thumbUrl ?? item.fileUrl} alt="thumb" />
            </button>
          ))}
        </div>
      </div>
    );
  }

  function renderArchive() {
    const appliedTags = archiveItem?.tags ?? [];
    const appliedTagSet = new Set(appliedTags);
    const availableTags = tags.filter((tag) => !appliedTagSet.has(tag.name));
    const pageSize = 12;
    const pageCount = Math.max(1, Math.ceil(archiveFeed.items.length / pageSize));
    const pageIndex = Math.min(Math.floor(archiveIndex / pageSize), pageCount - 1);
    const pageStart = pageIndex * pageSize;
    const pageItems = archiveFeed.items.slice(pageStart, pageStart + pageSize);
    const jumpPage = (delta: number) => {
      const next = Math.min(Math.max(pageIndex + delta, 0), pageCount - 1);
      setArchiveIndex(next * pageSize);
    };
    if (archiveFeed.error) {
      return <div className="error-state">{archiveFeed.error}</div>;
    }
    if (archiveFeed.loaded && archiveFeed.items.length === 0) {
      return <div className="empty-state">所有内容都已归档，可以回到图库或收藏继续浏览。</div>;
    }
    return (
      <div className="archive-page">
        <div className="archive-header glass">
          <div>
            <div className="h-title text-xl">归档模式</div>
            <div className="muted-text">{ARCHIVE_HINT}</div>
          </div>
          <div className="archive-actions">
            <button className="btn" onClick={() => loadArchive('reset')}>
              刷新队列
            </button>
            <div className="pill">
              进度 {archiveIndex + 1}/{archiveFeed.items.length || 1}
            </div>
          </div>
        </div>
        <div className="archive-view">
          <div className="archive-main glass">
            {archiveItem ? (
              <>
                <div className="archive-media">
                  {archiveItem.type === 'video' ? (
                    <video src={archiveItem.fileUrl} controls poster={archiveItem.thumbUrl ?? undefined} />
                  ) : (
                    <img src={archiveItem.fileUrl} alt="archive" />
                  )}
                </div>
                <div className="archive-toolbar">
                  <button className="btn btn-ghost" onClick={() => moveArchive(-1)}>
                    上一张
                  </button>
                  <button className="btn btn-ghost" onClick={() => moveArchive(1)}>
                    下一张
                  </button>
                  <button
                    className={`btn ${archiveItem.favorite ? 'btn-primary' : ''}`}
                    onClick={() => toggleFavorite([archiveItem.id], !archiveItem.favorite)}
                  >
                    {archiveItem.favorite ? '取消收藏' : '收藏'}
                  </button>
                  <button className="btn btn-danger" onClick={() => deleteItems([archiveItem.id])}>
                    删除
                  </button>
                  <button className="btn btn-ghost" onClick={undoLastAction}>
                    撤销
                  </button>
                </div>
              </>
            ) : (
              <div className="loading-row">正在加载...</div>
            )}
          </div>
          <div className="archive-side glass">
            {archiveItem ? (
              <>
                <div className="section">
                  <div className="section-title">快速归档</div>
                  <div className="chip-grid">
                    {collections.map((col) => (
                      <button
                        key={col.id}
                        className="pill"
                        onClick={() => addToCollection([archiveItem.id], col.name)}
                      >
                        {col.name}
                      </button>
                    ))}
                    <button className="pill" onClick={() => setShowCollectionInput((prev) => !prev)}>
                      {showCollectionInput ? '收起自定义' : '自定义相簿'}
                    </button>
                  </div>
                  {showCollectionInput ? (
                    <div className="inline-input">
                      <input
                        ref={collectionInputRef}
                        className="input input-compact"
                        placeholder="新相簿名"
                        value={collectionInput}
                        onChange={(event) => setCollectionInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            addToCollection([archiveItem.id], collectionInput);
                            setCollectionInput('');
                          }
                        }}
                      />
                      <button
                        className="btn btn-primary"
                        onClick={() => {
                          addToCollection([archiveItem.id], collectionInput);
                          setCollectionInput('');
                        }}
                      >
                        归档
                      </button>
                    </div>
                  ) : null}
                </div>
                <div className="section">
                  <div className="section-title">标签</div>
                  {appliedTags.length ? (
                    <div className="chip-grid chip-grid-applied">
                      {appliedTags.map((name) => (
                        <button
                          key={name}
                          className="pill pill-applied"
                          title="Remove"
                          onClick={() => removeTags([archiveItem.id], name)}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div className="chip-grid chip-grid-common">
                    {availableTags.map((tag) => (
                      <button key={tag.id} className="pill" onClick={() => addTags([archiveItem.id], tag.name)}>
                        {tag.name}
                      </button>
                    ))}
                    <button className="pill" onClick={() => setShowTagInput((prev) => !prev)}>
                      {showTagInput ? '收起自定义' : '自定义标签'}
                    </button>
                  </div>
                  {showTagInput ? (
                    <div className="inline-input">
                      <input
                        ref={tagInputRef}
                        className="input input-compact"
                        placeholder="添加标签"
                        value={tagInput}
                        onChange={(event) => setTagInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            addTags([archiveItem.id], tagInput);
                            setTagInput('');
                          }
                        }}
                      />
                      <button
                        className="btn btn-primary"
                        onClick={() => {
                          addTags([archiveItem.id], tagInput);
                          setTagInput('');
                        }}
                      >
                        添加
                      </button>
                    </div>
                  ) : null}
                </div>
                <div className="section">
                  <div className="section-title">来源</div>
                  <div className="meta-list">
                    {archiveItem.sources.map((source, index) => (
                      <div key={`${source.tweetUrl ?? 'src'}-${index}`} className="meta-row">
                        <div>
                          {source.authorHandle
                            ? `@${source.authorHandle}`
                            : getSourceHost(source.sourcePageUrl ?? source.tweetUrl) ?? '未知来源'}
                        </div>
                        <div className="muted-text">{formatDateTime(source.collectedAt)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>
        <div className="archive-strip-header">
          <div className="muted-text">
            缩略图 {pageIndex + 1}/{pageCount}
          </div>
          <div className="archive-strip-actions">
            <button className="btn btn-ghost" onClick={() => jumpPage(-1)} disabled={pageIndex === 0}>
              上一页
            </button>
            <button className="btn btn-ghost" onClick={() => jumpPage(1)} disabled={pageIndex + 1 >= pageCount}>
              下一页
            </button>
          </div>
        </div>
        <div className="archive-strip">
          {pageItems.map((item, idx) => {
            const absoluteIndex = pageStart + idx;
            return (
            <button
              key={item.id}
              className={`strip-item ${absoluteIndex === archiveIndex ? 'strip-item-active' : ''}`}
              onClick={() => setArchiveIndex(absoluteIndex)}
            >
              <img src={item.thumbUrl ?? item.fileUrl} alt="thumb" />
            </button>
            );
          })}
        </div>
      </div>
    );
  }

  function renderSettings() {
    const previewName = previewArchiveName(settingsDraft.archiveTemplate, selectedItem ?? libraryFeed.items[0]);
    return (
      <div className="page">
        <div className="settings glass">
          <div className="h-title text-xl">设置</div>
          <div className="muted-text">
            当前根目录：{settings.libraryRoot ? settings.libraryRoot : '未设置'} · 命名模板：
            {settings.archiveTemplate ? settings.archiveTemplate : '默认'}
          </div>
          <div className="settings-section">
            <div className="settings-title">根图库目录</div>
            <div className="muted-text">归档会把图片移动到该目录下的相簿文件夹。</div>
            <input
              className="input"
              placeholder="例如 D:\\\\XLibrary"
              value={settingsDraft.libraryRoot}
              onChange={(event) => setSettingsDraft({ ...settingsDraft, libraryRoot: event.target.value })}
            />
          </div>
          <div className="settings-section">
            <div className="settings-title">自动命名模板</div>
            <div className="muted-text">
              可用变量：{`{date} {time} {datetime} {author} {tags} {id} {type} {collection}`}
            </div>
            <input
              className="input"
              placeholder="{datetime}_{author}_{tags}_{id}"
              value={settingsDraft.archiveTemplate}
              onChange={(event) => setSettingsDraft({ ...settingsDraft, archiveTemplate: event.target.value })}
            />
            <div className="preview-box">预览：{previewName || '（空）'}</div>
          </div>
          <div className="settings-actions">
            <button className="btn btn-primary" onClick={handleSaveSettings}>
              保存设置
            </button>
          </div>
        </div>
        <div className="settings glass">
          <div className="settings-section">
            <div className="settings-title">导入本地文件夹</div>
            <div className="muted-text">选择已有的图片目录导入到图库索引中。</div>
            <div className="inline-input">
              <input
                className="input"
                placeholder="例如 D:\\\\Pictures"
                value={importPath}
                onChange={(event) => setImportPath(event.target.value)}
              />
              <button className="btn btn-primary" onClick={handleImportLocal}>
                导入
              </button>
            </div>
            {importStatus ? <div className="muted-text">{importStatus}</div> : null}
          </div>
        </div>
      </div>
    );
  }

  function renderDrawer() {
    if (!selectedItem) return null;
    const appliedTags = selectedItem.tags ?? [];
    const appliedTagSet = new Set(appliedTags);
    const availableTags = tags.filter((tag) => !appliedTagSet.has(tag.name));
    const primarySource = selectedItem.sources[0];
    const sourceLabel = primarySource?.authorHandle
      ? `@${primarySource.authorHandle}`
      : getSourceHost(primarySource?.sourcePageUrl ?? primarySource?.tweetUrl) ?? null;
    const originLabel =
      selectedItem.origin === 'local' ? '本地导入' : sourceLabel ? `来自 ${sourceLabel}` : '站点采集';
    const sizeLabel =
      selectedItem.width && selectedItem.height ? `${selectedItem.width} × ${selectedItem.height}` : null;
    const openUrl = primarySource?.tweetUrl ?? primarySource?.sourcePageUrl ?? null;
    return (
      <div className="drawer">
        <div className="drawer-content glass">
          <div className="drawer-header">
            <div className="drawer-header-info">
              <div className="drawer-title">图片详情</div>
              <div className="drawer-sub">
                {formatDateTime(selectedItem.savedAt)}
                {originLabel ? ` · ${originLabel}` : ''}
              </div>
            </div>
            <button className="btn btn-ghost" onClick={() => setSelectedId(null)}>
              关闭
            </button>
          </div>
          <div className="drawer-hero">
            <div className="drawer-media-frame">
              <div className="drawer-media">
                {selectedItem.type === 'video' ? (
                  <video src={selectedItem.fileUrl} controls poster={selectedItem.thumbUrl ?? undefined} />
                ) : (
                  <img src={selectedItem.fileUrl} alt="media" />
                )}
              </div>
            </div>
            <div className="drawer-hero-meta">
              <div className="meta-chips">
                <span className="meta-chip">{selectedItem.type === 'video' ? '视频 / GIF' : '图片'}</span>
                {sizeLabel ? <span className="meta-chip">{sizeLabel}</span> : null}
                <span
                  className={`meta-chip ${
                    selectedItem.origin === 'local' ? 'meta-chip-neutral' : 'meta-chip-accent'
                  }`}
                >
                  {selectedItem.origin === 'local' ? '本地导入' : '站点采集'}
                </span>
                {selectedItem.archivedAt ? <span className="meta-chip meta-chip-archived">已归档</span> : null}
                {selectedItem.favorite ? <span className="meta-chip meta-chip-fav">已收藏</span> : null}
              </div>
              <div className="drawer-actions">
                <button
                  className={`btn ${selectedItem.favorite ? 'btn-primary' : ''}`}
                  onClick={() => toggleFavorite([selectedItem.id], !selectedItem.favorite)}
                >
                  {selectedItem.favorite ? '取消收藏' : '收藏'}
                </button>
                {selectedItem.archivedAt ? (
                  <button className="btn" onClick={() => unarchiveItems([selectedItem.id])}>
                    撤销归档
                  </button>
                ) : null}
                <button className="btn btn-danger" onClick={() => deleteItems([selectedItem.id])}>
                  删除
                </button>
                {openUrl ? (
                  <a className="btn" href={openUrl} target="_blank" rel="noreferrer">
                    {primarySource?.tweetUrl ? '打开原推文' : '打开来源'}
                  </a>
                ) : null}
              </div>
            </div>
          </div>
          <div className="drawer-grid">
            <div className="drawer-section">
              <div className="section-title">评分</div>
              {renderRatingStars(selectedItem.rating ?? 0, (rating) => setRating([selectedItem.id], rating))}
            </div>
            <div className="drawer-section">
              <div className="section-title">相簿</div>
              <div className="chip-grid">
                {collections.map((col) => (
                  <button
                    key={col.id}
                    className={`pill ${selectedItem.collections.includes(col.name) ? 'pill-active' : ''}`}
                    onClick={() =>
                      selectedItem.collections.includes(col.name)
                        ? removeFromCollection([selectedItem.id], col.name)
                        : addToCollection([selectedItem.id], col.name)
                    }
                  >
                    {col.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="drawer-section">
              <div className="section-title">标签</div>
              {appliedTags.length ? (
                <>
                  <div className="section-hint">已打标签</div>
                  <div className="chip-grid chip-grid-applied">
                    {appliedTags.map((name) => (
                      <button
                        key={`applied-${name}`}
                        className="pill pill-applied"
                        onClick={() => removeTags([selectedItem.id], name)}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <div className="muted-text">暂无标签</div>
              )}
              <div className="section-hint">常用标签</div>
              <div className="chip-grid chip-grid-common">
                {availableTags.map((tag) => (
                  <button
                    key={tag.id}
                    className="pill"
                    onClick={() => addTags([selectedItem.id], tag.name)}
                  >
                    {tag.name}
                  </button>
                ))}
                <button className="pill" onClick={() => setShowDrawerTagInput((prev) => !prev)}>
                  {showDrawerTagInput ? '收起自定义' : '自定义标签'}
                </button>
              </div>
              {showDrawerTagInput ? (
                <div className="inline-input">
                  <input
                    ref={tagInputRef}
                    className="input input-compact"
                    placeholder="输入标签，回车添加"
                    value={tagInput}
                    onChange={(event) => setTagInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        addTags([selectedItem.id], tagInput);
                        setTagInput('');
                      }
                    }}
                  />
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      addTags([selectedItem.id], tagInput);
                      setTagInput('');
                    }}
                  >
                    添加
                  </button>
                </div>
              ) : null}
            </div>
            <div className="drawer-section">
              <div className="section-title">相似推荐</div>
              {similarLoading ? <div className="muted-text">正在加载相似图片...</div> : null}
              {!similarLoading && similarItems.length === 0 ? (
                <div className="muted-text">暂无相似内容</div>
              ) : (
                <div className="similar-grid">
                  {similarItems.map((item) => (
                    <button key={item.id} className="similar-card" onClick={() => setSelectedId(item.id)}>
                      <img src={item.thumbUrl ?? item.fileUrl} alt="similar" />
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="drawer-section">
              <div className="section-title">来源</div>
              {selectedItem.sources.length ? (
                <div className="meta-list">
                  {selectedItem.sources.map((source, index) => (
                    <div key={`${source.tweetUrl ?? 'src'}-${index}`} className="meta-row">
                      <div>
                        {source.authorHandle
                          ? `@${source.authorHandle}`
                          : getSourceHost(source.sourcePageUrl ?? source.tweetUrl) ?? '未知来源'}
                      </div>
                      <div className="muted-text">{source.tweetUrl ?? source.sourcePageUrl}</div>
                      <div className="meta-row-time">{formatDateTime(source.collectedAt)}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="muted-text">暂无来源记录</div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderSimilarDock() {
    if (!selectedItem || !showSimilarDock) return null;
    return (
      <aside className="similar-dock glass">
        <div className="similar-dock-header">
          <div className="section-title">相似推荐</div>
          <button className="mini-btn" onClick={() => setShowSimilarDock(false)}>
            隐藏
          </button>
        </div>
        {similarLoading ? <div className="muted-text">正在加载相似图片...</div> : null}
        {!similarLoading && similarItems.length === 0 ? (
          <div className="muted-text">暂无相似内容</div>
        ) : (
          <div className="similar-dock-grid">
            {similarItems.slice(0, 8).map((item) => (
              <button key={item.id} className="similar-dock-card" onClick={() => setSelectedId(item.id)}>
                <img src={item.thumbUrl ?? item.fileUrl} alt="similar" />
              </button>
            ))}
          </div>
        )}
      </aside>
    );
  }

  function renderSimilarDockToggle() {
    if (!selectedItem || showSimilarDock) return null;
    return (
      <button className="similar-dock-toggle" onClick={() => setShowSimilarDock(true)}>
        相似推荐
      </button>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar glass">
        <div>
          <div className="h-title text-2xl">ClipNest</div>
          <div className="muted-text">
            {stats
              ? `已收集媒体 ${stats.mediaCount} 项 · 来源记录 ${stats.sourceCount} 条`
              : '本地图库已连接'}
          </div>
        </div>
        <nav className="nav">
          {Object.entries(ROUTE_LABELS).map(([key, label]) => (
            <a key={key} className={`nav-pill ${route === key ? 'nav-pill-active' : ''}`} href={`#/${key}`}>
              {label}
            </a>
          ))}
        </nav>
        <div className="topbar-actions">
          <button className="btn btn-primary" onClick={syncMeta}>
            刷新相簿
          </button>
          <button className="btn btn-ghost topbar-hidden" onClick={refreshTags}>
            刷新标签
          </button>
        </div>
      </header>

      <main className="main">
        {route === 'library' ? renderLibrary() : null}
        {route === 'favorites' ? renderFavorites() : null}
        {route === 'timeline' ? renderTimeline() : null}
        {route === 'board' ? renderBoard() : null}
        {route === 'archive' ? renderArchive() : null}
        {route === 'settings' ? renderSettings() : null}
      </main>

      {renderDrawer()}
      {renderSimilarDock()}
      {renderSimilarDockToggle()}

      {toast ? (
        <div className={`toast ${toast.tone}`}>
          <span>{toast.message}</span>
          {toast.actionLabel && toast.onAction ? (
            <button className="toast-action" onClick={toast.onAction}>
              {toast.actionLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
