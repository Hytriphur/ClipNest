export type IngestItem = {
  sourcePageUrl: string;
  tweetUrl?: string;
  authorHandle?: string;
  mediaUrl: string;
  mediaType: 'image' | 'video';
  collectedAt: string;
  context?: IngestContext;
};

export type ExtractResult = {
  items: IngestItem[];
};

export type SiteId = 'x' | 'pixiv' | 'duitang' | 'xiaohongshu' | 'baidu' | 'google' | 'youtube' | 'other';

export type IngestContext = {
  site?: SiteId;
  referer?: string;
  pageTitle?: string;
  tags?: string[];
  artworkUrl?: string;
  alternateMediaUrls?: string[];
  youtubeAudioUrl?: string;
  youtubeAudioAltUrls?: string[];
  youtubeQualityLabel?: string;
  clientId?: string;
  displayName?: string;
};
