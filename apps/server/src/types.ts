export type IngestItem = {
  sourcePageUrl: string;
  tweetUrl?: string;
  authorHandle?: string;
  mediaUrl: string;
  mediaType: 'image' | 'video';
  collectedAt: string; // ISO string
  context?: any;
};

export type MediaRow = {
  id: number;
  sha256: string;
  phash: string | null;
  type: 'image' | 'video';
  original_url: string;
  local_path: string;
  thumb_path: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  created_at: string | null;
  saved_at: string;
  origin: 'x' | 'pixiv' | 'duitang' | 'local' | 'other';
  archived_at: string | null;
  deleted_at: string | null;
  deleted_from_path: string | null;
  deleted_from_url: string | null;
  deleted_thumb_from_path: string | null;
};
