/**
 * Normalize common X media URLs so that trivial query differences don't create duplicates.
 * This is NOT an auth mechanism; it's only used for dedupe and metadata.
 */
export function normalizeMediaUrl(rawUrl: string): string {
  let url: URL;
  const fixed = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
  try {
    url = new URL(fixed);
  } catch {
    return rawUrl;
  }

  if (url.hostname.endsWith('pximg.net')) {
    url.search = '';

    if (url.pathname.startsWith('/c/')) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 3) {
        url.pathname = '/' + parts.slice(2).join('/');
      }
    }

    if (url.pathname.includes('/img-master/')) {
      url.pathname = url.pathname.replace('/img-master/', '/img-original/');
    }

    url.pathname = url.pathname.replace(/_master1200(?=\.[a-z0-9]+$)/i, '');
    return url.toString();
  }

  if (url.hostname.endsWith('duitang.com')) {
    url.search = '';
    return url.toString();
  }

  // pbs.twimg.com/media/... (images)
  if (url.hostname === 'pbs.twimg.com') {
    // Keep `format` (often required) and standardize `name=orig`.
    const format = url.searchParams.get('format');
    url.search = '';

    if (url.pathname.startsWith('/media/')) {
      if (format) url.searchParams.set('format', format);
      url.searchParams.set('name', 'orig');
    }
    return url.toString();
  }

  // video.twimg.com/... (mp4)
  if (url.hostname === 'video.twimg.com') {
    // Video query params are typically transient tracking/version markers.
    // Strip them so identical clips collapse to one canonical URL.
    url.search = '';
    return url.toString();
  }

  return url.toString();
}
