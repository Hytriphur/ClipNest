import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './lib/storage';

function $(id: string) {
  return document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
}

function setHint(text: string) {
  const el = document.getElementById('saveHint');
  if (el) el.textContent = text;
}

async function init() {
  const s = await loadSettings();

  const serverUrl = $('serverUrl');
  const maxScrolls = $('maxScrolls');
  const stepDelayMs = $('stepDelayMs');
  const targets = $('targets');

  if (serverUrl) serverUrl.value = s.serverUrl ?? DEFAULT_SETTINGS.serverUrl;
  if (maxScrolls) maxScrolls.value = String(s.maxScrolls ?? DEFAULT_SETTINGS.maxScrolls);
  if (stepDelayMs) stepDelayMs.value = String(s.stepDelayMs ?? DEFAULT_SETTINGS.stepDelayMs);
  if (targets) targets.value = (s.targets ?? []).join('\n');

  document.getElementById('btnSaveSettings')?.addEventListener('click', async () => {
    const next = await loadSettings();
    next.serverUrl = serverUrl?.value?.trim() || DEFAULT_SETTINGS.serverUrl;
    next.maxScrolls = Math.max(1, Number(maxScrolls?.value ?? DEFAULT_SETTINGS.maxScrolls));
    next.stepDelayMs = Math.max(250, Number(stepDelayMs?.value ?? DEFAULT_SETTINGS.stepDelayMs));
    await saveSettings(next);
    setHint('设置已保存。');
  });

  document.getElementById('btnSaveTargets')?.addEventListener('click', async () => {
    const next = await loadSettings();
    const lines = (targets?.value ?? '')
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
    next.targets = Array.from(new Set(lines));
    await saveSettings(next);
    setHint(`目标已保存（${next.targets.length} 条）。`);
  });

  document.getElementById('btnOpenLibrary')?.addEventListener('click', async () => {
    await chrome.tabs.create({ url: 'http://localhost:5173' });
  });
}

void init();
