function normalizeRawUrl(rawUrl: string): string {
  if (rawUrl.startsWith('//')) return `https:${rawUrl}`;
  return rawUrl;
}

function stripQuery(rawUrl: string): string {
  try {
    const url = new URL(normalizeRawUrl(rawUrl));
    url.search = '';
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function normalizePixivUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(normalizeRawUrl(rawUrl));
  } catch {
    return rawUrl;
  }

  if (!url.hostname.endsWith('pximg.net')) return rawUrl;

  url.search = '';
  const wasCustomThumb = url.pathname.includes('/custom-thumb/');

  if (url.pathname.startsWith('/c/')) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 3) {
      url.pathname = '/' + parts.slice(2).join('/');
    }
  }

  if (url.pathname.includes('/custom-thumb/')) {
    url.pathname = url.pathname.replace('/custom-thumb/', '/img-master/');
    url.pathname = url.pathname.replace(/_custom\d+(?=\.[a-z0-9]+$)/i, '_master1200');
  }

  if (url.pathname.includes('/img-master/')) {
    if (!wasCustomThumb) {
      url.pathname = url.pathname.replace('/img-master/', '/img-original/');
    }
  }

  if (url.pathname.includes('/img-original/')) {
    url.pathname = url.pathname.replace(/_master1200(?=\.[a-z0-9]+$)/i, '');
  }

  return url.toString();
}

function normalizeXUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(normalizeRawUrl(rawUrl));
  } catch {
    return rawUrl;
  }

  if (url.hostname === 'pbs.twimg.com') {
    const format = url.searchParams.get('format');
    url.search = '';
    if (url.pathname.startsWith('/media/')) {
      if (format) url.searchParams.set('format', format);
      url.searchParams.set('name', 'orig');
    }
    return url.toString();
  }

  if (url.hostname === 'video.twimg.com') {
    return url.toString();
  }

  return url.toString();
}

export function normalizeMediaUrl(rawUrl: string): string {
  const fixed = normalizeRawUrl(rawUrl);
  try {
    const url = new URL(fixed);
    if (url.hostname.endsWith('pximg.net')) return normalizePixivUrl(rawUrl);
    if (url.hostname.endsWith('duitang.com')) return stripQuery(rawUrl);
    if (url.hostname === 'pbs.twimg.com' || url.hostname === 'video.twimg.com') return normalizeXUrl(rawUrl);
  } catch {
    return rawUrl;
  }
  return fixed;
}
