type SupportedSite = 'x' | 'pixiv' | 'duitang' | 'xiaohongshu' | 'baidu' | 'google' | 'youtube' | 'other' | 'unknown';

type SiteInfo = {
  key: SupportedSite;
  label: string;
  status: string;
  detail: string;
  hint: string;
  supported: boolean;
};

type PingResponse = {
  ok: boolean;
  serverUrl: string;
};

type LauncherStatusResponse = {
  ok: boolean;
  launcherOk?: boolean;
  launcherUrl?: string;
  error?: string;
  server?: {
    running?: boolean;
  };
};

type LauncherActionResponse = {
  ok: boolean;
  error?: string;
  out?: {
    ok?: boolean;
    running?: boolean;
    action?: string;
    error?: string;
  };
};

async function bg<T>(msg: unknown): Promise<T> {
  return (await chrome.runtime.sendMessage(msg)) as T;
}

function setText(id: string, text: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.setAttribute('title', text);
}

function setTone(id: string, tone: 'ok' | 'warn' | 'muted') {
  const el = document.getElementById(id);
  if (!el) return;
  el.setAttribute('data-tone', tone);
}

function setMeterState(id: string, state: 'ok' | 'warn' | 'muted') {
  const el = document.getElementById(id);
  if (!el) return;
  el.setAttribute('data-state', state);
}

function activateChip(site: SupportedSite) {
  const chips = document.querySelectorAll<HTMLElement>('[data-site-chip]');
  chips.forEach((chip) => {
    chip.dataset.active = chip.dataset.siteChip === site ? 'true' : 'false';
  });
}

function setButtonsBusy(busy: boolean) {
  const ids = ['btnStartServer', 'btnRestartServer'] as const;
  ids.forEach((id) => {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (!el) return;
    el.disabled = busy;
    el.dataset.busy = busy ? 'true' : 'false';
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
      hint: '当前标签页不是常规网页地址。',
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
      hint: '直接点网页里的保存按钮即可采集。',
      supported: true,
    };
  }

  if (host === 'pixiv.net' || host.endsWith('.pixiv.net') || host.endsWith('.pximg.net')) {
    return {
      key: 'pixiv',
      label: 'Pixiv',
      status: '已接入',
      detail: path.includes('/artworks/') ? '作品详情页' : '作品预览或列表页',
      hint: '支持单图、多图和常见视频作品保存。',
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
      hint: '仅在详情媒体显示保存按钮，尽量减少干扰。',
      supported: true,
    };
  }

  if (host === 'image.baidu.com' || host.endsWith('.image.baidu.com')) {
    return {
      key: 'baidu',
      label: '百度图片',
      status: '已接入',
      detail: '搜索结果或详情页',
      hint: '优先提取原图链接而非缩略图。',
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
      hint: '优先从跳转参数解析原图和来源页。',
      supported: true,
    };
  }

  if (
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host === 'youtu.be' ||
    host.endsWith('.youtu.be')
  ) {
    const isDetail =
      path.startsWith('/watch') ||
      /^\/shorts\/[^/]+/i.test(path) ||
      /^\/live\/[^/]+/i.test(path) ||
      host === 'youtu.be';
    return {
      key: 'youtube',
      label: 'YouTube',
      status: '已接入',
      detail: isDetail ? '视频详情页' : '非详情页',
      hint: isDetail ? '支持详情页保存视频（默认优先最高画质）。' : '请打开具体视频详情页再保存。',
      supported: true,
    };
  }

  return {
    key: 'other',
    label: host,
    status: '未接入',
    detail: parsed.pathname || '/',
    hint: '这个站点暂时没有专用采集逻辑。',
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
      ? '站内直接点保存按钮即可采集，弹窗只保留状态和快捷入口。'
      : '当前页面没有专用采集入口，但仍可打开图库和设置。',
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
  setText('serverStateLabel', ok ? '后端在线' : '后端离线');
  setText('serverHint', ok ? '可接收保存任务' : '可用下方按钮一键启动');
  setTone('serverStatus', ok ? 'ok' : 'warn');
  setMeterState('serverDot', ok ? 'ok' : 'warn');
}

function renderLauncherStatus(state: LauncherStatusResponse) {
  const launcherOnline = state.ok && state.launcherOk;
  const serverOnline = Boolean(state.server?.running);
  setText('launcherStatus', launcherOnline ? '在线' : '离线');
  setText('launcherUrl', state.launcherUrl || 'http://127.0.0.1:5180');
  if (launcherOnline) {
    setText('launcherHint', serverOnline ? '可用：启动/重启后端' : 'Launcher 在线，可一键拉起后端');
  } else {
    setText('launcherHint', state.error ? `Launcher 不可用：${state.error}` : '请先运行 launcher 服务');
  }
  setTone('launcherStatus', launcherOnline ? 'ok' : 'warn');

  const btnStart = document.getElementById('btnStartServer') as HTMLButtonElement | null;
  const btnRestart = document.getElementById('btnRestartServer') as HTMLButtonElement | null;
  if (btnStart) btnStart.disabled = !launcherOnline;
  if (btnRestart) btnRestart.disabled = !launcherOnline;
}

async function refreshRuntimeState() {
  const ping = await bg<PingResponse>({ type: 'XIC_PING' }).catch(() => ({
    ok: false,
    serverUrl: 'http://localhost:5174',
  }));
  const launcher = await bg<LauncherStatusResponse>({ type: 'XIC_LAUNCHER_STATUS' }).catch(() => ({
    ok: false,
    launcherOk: false,
    launcherUrl: 'http://127.0.0.1:5180',
  }));

  renderServerStatus(Boolean(ping.ok), ping.serverUrl);
  renderLauncherStatus(launcher);

  return { ping, launcher };
}

async function runLauncherAction(action: 'start' | 'restart') {
  setButtonsBusy(true);
  setText('launcherHint', action === 'start' ? '正在启动后端…' : '正在重启后端…');

  const msgType = action === 'start' ? 'XIC_LAUNCHER_START_SERVER' : 'XIC_LAUNCHER_RESTART_SERVER';
  const out = await bg<LauncherActionResponse>({ type: msgType }).catch((error) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));

  if (!out.ok) {
    setText('launcherHint', `操作失败：${out.error || '未知错误'}`);
    setButtonsBusy(false);
    return;
  }

  const actionText = out.out?.action === 'script_fallback' ? '（脚本兜底）' : '';
  if (out.out?.ok) {
    setText('launcherHint', action === 'start' ? `后端已启动${actionText}` : `后端已重启${actionText}`);
  } else {
    setText('launcherHint', `操作未完成：${out.out?.error || '等待超时'}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 700));
  await refreshRuntimeState();
  setButtonsBusy(false);
}

async function init() {
  const site = await getCurrentSiteInfo();
  renderSiteInfo(site);

  const { ping } = await refreshRuntimeState();
  const libraryUrl = buildLibraryUrl(ping.serverUrl);

  document.getElementById('btnOptions')?.addEventListener('click', async () => {
    await chrome.runtime.openOptionsPage();
  });

  document.getElementById('btnOpenLibrary')?.addEventListener('click', async () => {
    await chrome.tabs.create({ url: libraryUrl });
  });

  document.getElementById('btnStartServer')?.addEventListener('click', async () => {
    await runLauncherAction('start');
  });

  document.getElementById('btnRestartServer')?.addEventListener('click', async () => {
    await runLauncherAction('restart');
  });
}

void init();
