import { loadSettings, saveSettings } from './lib/storage';

async function getActiveTabId(): Promise<number> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const id = tabs[0]?.id;
  if (!id) throw new Error('no active tab');
  return id;
}

async function bg<T>(msg: any): Promise<T> {
  return (await chrome.runtime.sendMessage(msg)) as T;
}

function setText(id: string, text: string) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

async function init() {
  const ping = await bg<{ ok: boolean; serverUrl: string }>({ type: 'XIC_PING' }).catch(() => ({ ok: false, serverUrl: 'http://localhost:5174' }));
  setText('serverUrl', ping.serverUrl);
  setText('serverStatus', ping.ok ? '（在线）' : '（离线）');

  document.getElementById('btnOptions')?.addEventListener('click', async () => {
    await chrome.runtime.openOptionsPage();
  });

  document.getElementById('btnOpenLibrary')?.addEventListener('click', async () => {
    await chrome.tabs.create({ url: 'http://localhost:5173' });
  });

  document.getElementById('btnSavePage')?.addEventListener('click', async () => {
    setText('lastResult', '正在提取并保存...');
    try {
      const tabId = await getActiveTabId();
      const r = await bg<{
        ok: boolean;
        count?: number;
        okCount?: number;
        failedCount?: number;
        error?: string;
      }>({ type: 'XIC_SAVE_PAGE', tabId });
      if (!r.ok) {
        setText('lastResult', `失败：${r.error ?? '未知错误'}`);
        return;
      }
      const okCount = Number.isFinite(r.okCount) ? r.okCount : r.count ?? 0;
      const failedCount = Number.isFinite(r.failedCount) ? r.failedCount : 0;
      setText(
        'lastResult',
        failedCount > 0
          ? `已提取 ${r.count ?? 0}，保存成功 ${okCount}，失败 ${failedCount}：${r.error ?? '未知错误'}`
          : `已提取 ${r.count ?? 0} 条，保存请求已发送。`,
      );
    } catch (e) {
      setText('lastResult', `失败：${e instanceof Error ? e.message : String(e)}`);
    }
  });

  document.getElementById('btnAddTarget')?.addEventListener('click', async () => {
    setText('lastResult', '正在加入自动目标...');
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tabs[0]?.url;
      if (!url) {
        setText('lastResult', '无法获取当前页面 URL。');
        return;
      }
      const next = await loadSettings();
      const trimmed = url.trim();
      const set = new Set(next.targets ?? []);
      set.add(trimmed);
      next.targets = Array.from(set);
      await saveSettings(next);
      setText('lastResult', `已加入目标：${trimmed}`);
    } catch (e) {
      setText('lastResult', `失败：${e instanceof Error ? e.message : String(e)}`);
    }
  });

  document.getElementById('btnAutoStart')?.addEventListener('click', async () => {
    setText('lastResult', '正在启动自动采集...');
    const r = await bg<{ ok: boolean; error?: string }>({ type: 'XIC_AUTO_START' });
    setText('lastResult', r.ok ? '自动采集已启动。稍后在图库查看新增。' : `启动失败：${r.error}`);
  });

  document.getElementById('btnAutoStop')?.addEventListener('click', async () => {
    const r = await bg<{ ok: boolean }>({ type: 'XIC_AUTO_STOP' });
    setText('lastResult', r.ok ? '自动采集已停止。' : '停止失败。');
  });
}

void init();
