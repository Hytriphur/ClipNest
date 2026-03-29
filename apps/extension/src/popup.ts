type SupportedSite = 'x' | 'pixiv' | 'duitang' | 'xiaohongshu' | 'baidu' | 'google' | 'other' | 'unknown';

type SiteInfo = {
  key: SupportedSite;
  label: string;
  status: string;
  detail: string;
  hint: string;
  supported: boolean;
};

async function bg<T>(msg: unknown): Promise<T> {
  return (await chrome.runtime.sendMessage(msg)) as T;
}

function setText(id: string, text: string) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = text;
    el.setAttribute('title', text);
  }
}

function setTone(id: string, tone: 'ok' | 'warn' | 'muted') {
  const el = document.getElementById(id);
  if (el) {
    el.setAttribute('data-tone', tone);
  }
}

function setMeterState(id: string, state: 'ok' | 'warn' | 'muted') {
  const el = document.getElementById(id);
  if (el) {
    el.setAttribute('data-state', state);
  }
}

function activateChip(site: SupportedSite) {
  const chips = document.querySelectorAll<HTMLElement>('[data-site-chip]');
  chips.forEach((chip) => {
    chip.dataset.active = chip.dataset.siteChip === site ? 'true' : 'false';
  });
}

function buildLibraryUrl(serverUrl: string) {
  try {
    const url = new URL(serverUrl);
    url.port = '5173';
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return 'http://localhost:5173/';
  }
}

function parseServerDisplay(serverUrl: string) {
  try {
    const url = new URL(serverUrl);
    return {
      host: url.hostname || 'localhost',
      port: url.port || (url.protocol === 'https:' ? '443' : '80'),
      full: serverUrl,
    };
  } catch {
    return {
      host: 'localhost',
      port: '5174',
      full: serverUrl || 'http://localhost:5174',
    };
  }
}

function detectSite(url?: string): SiteInfo {
  if (!url) {
    return {
      key: 'unknown',
      label: '未识别页面',
      status: '无法读取',
      detail: '没有可用地址',
      hint: '刷新网页后再试一次。',
      supported: false,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      key: 'unknown',
      label: '未识别页面',
      status: '无法识别',
      detail: url,
      hint: '当前标签页不是常规网页。',
      supported: false,
    };
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) {
    const detail = path.includes('/status/')
      ? '帖子详情页'
      : path.endsWith('/media')
        ? '媒体页'
        : '信息流或列表页';
    return {
      key: 'x',
      label: 'X',
      status: '已接入',
      detail,
      hint: '网页里的保存按钮可直接采集。',
      supported: true,
    };
  }

  if (host === 'pixiv.net' || host.endsWith('.pixiv.net') || host.endsWith('.pximg.net')) {
    return {
      key: 'pixiv',
      label: 'Pixiv',
      status: '已接入',
      detail: path.includes('/artworks/') ? '作品详情页' : '作品预览或列表页',
      hint: '预览区和详情页都可以直接保存。',
      supported: true,
    };
  }

  if (host === 'duitang.com' || host.endsWith('.duitang.com')) {
    return {
      key: 'duitang',
      label: '堆糖',
      status: '已接入',
      detail: '图片流或详情页',
      hint: '常见图片卡片会自动出现保存按钮。',
      supported: true,
    };
  }

  if (
    host === 'xiaohongshu.com' ||
    host.endsWith('.xiaohongshu.com') ||
    host === 'rednote.com' ||
    host.endsWith('.rednote.com')
  ) {
    return {
      key: 'xiaohongshu',
      label: '小红书',
      status: '已接入',
      detail: path.includes('/explore/') || path.includes('/discovery/item/') ? '笔记详情页' : '信息流或预览页',
      hint: '优先支持常见图片、视频和笔记详情采集。',
      supported: true,
    };
  }

  if (host === 'image.baidu.com' || host.endsWith('.image.baidu.com')) {
    return {
      key: 'baidu',
      label: '百度图片',
      status: '已接入',
      detail: '搜索结果或详情页',
      hint: '优先从结果卡片提取原图链接而不是缩略图。',
      supported: true,
    };
  }

  if (
    host === 'images.google.com' ||
    ((host === 'www.google.com' || host.endsWith('.google.com')) &&
      path.startsWith('/search') &&
      parsed.searchParams.get('tbm') === 'isch')
  ) {
    return {
      key: 'google',
      label: 'Google 图片',
      status: '已接入',
      detail: '搜索结果页',
      hint: '优先从 imgres 链接解析原图与来源页。',
      supported: true,
    };
  }

  return {
    key: 'other',
    label: host,
    status: '未接入',
    detail: parsed.pathname || '/',
    hint: '这个站点暂时没有专用采集入口。',
    supported: false,
  };
}

async function getCurrentSiteInfo(): Promise<SiteInfo> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return detectSite(tabs[0]?.url);
  } catch (error) {
    return {
      key: 'unknown',
      label: '未识别页面',
      status: '读取失败',
      detail: error instanceof Error ? error.message : String(error),
      hint: '仍然可以打开图库和设置。',
      supported: false,
    };
  }
}

function renderSiteInfo(site: SiteInfo) {
  setText('siteName', site.label);
  setText('siteStatus', site.status);
  setText('siteDetail', site.detail);
  setText('siteHint', site.hint);
  setText(
    'usageHint',
    site.supported
      ? '只保留状态、图库和设置入口，点网页里的保存按钮就能采集。'
      : '当前页面没有专用保存入口，但仍可打开图库和设置。',
  );
  setTone('siteStatus', site.supported ? 'ok' : 'warn');
  activateChip(site.key);
}

function renderServerStatus(ok: boolean, serverUrl: string) {
  const display = parseServerDisplay(serverUrl);
  setText('serverHost', display.host);
  setText('serverPort', display.port);
  setText('serverUrl', display.full);
  setText('serverStatus', ok ? '已连接' : '未连接');
  setText('serverStateLabel', ok ? '服务在线' : '服务离线');
  setText('serverHint', ok ? '已经可以接收保存任务。' : '先启动 ClipNest Server。');
  setTone('serverStatus', ok ? 'ok' : 'warn');
  setMeterState('serverDot', ok ? 'ok' : 'warn');
}

async function init() {
  const ping = await bg<{ ok: boolean; serverUrl: string }>({ type: 'XIC_PING' }).catch(() => ({
    ok: false,
    serverUrl: 'http://localhost:5174',
  }));
  const site = await getCurrentSiteInfo();
  const libraryUrl = buildLibraryUrl(ping.serverUrl);

  renderServerStatus(ping.ok, ping.serverUrl);
  renderSiteInfo(site);

  document.getElementById('btnOptions')?.addEventListener('click', async () => {
    await chrome.runtime.openOptionsPage();
  });

  document.getElementById('btnOpenLibrary')?.addEventListener('click', async () => {
    await chrome.tabs.create({ url: libraryUrl });
  });
}

void init();
