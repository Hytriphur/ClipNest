const KEY = 'xic_settings_v1';

export type Settings = {
  serverUrl: string;
  launcherUrl: string;
  launcherToken: string;
  targets: string[];
  maxScrolls: number;
  stepDelayMs: number;
};

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: 'http://localhost:5174',
  launcherUrl: 'http://127.0.0.1:5180',
  launcherToken: '',
  targets: [],
  maxScrolls: 40,
  stepDelayMs: 900,
};

export async function loadSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get(KEY);
  const v = data[KEY] as Partial<Settings> | undefined;
  return {
    serverUrl: typeof v?.serverUrl === 'string' ? v.serverUrl : DEFAULT_SETTINGS.serverUrl,
    launcherUrl: typeof v?.launcherUrl === 'string' ? v.launcherUrl : DEFAULT_SETTINGS.launcherUrl,
    launcherToken: typeof v?.launcherToken === 'string' ? v.launcherToken : DEFAULT_SETTINGS.launcherToken,
    targets: Array.isArray(v?.targets) ? v.targets.filter((x) => typeof x === 'string') : DEFAULT_SETTINGS.targets,
    maxScrolls: typeof v?.maxScrolls === 'number' ? v.maxScrolls : DEFAULT_SETTINGS.maxScrolls,
    stepDelayMs: typeof v?.stepDelayMs === 'number' ? v.stepDelayMs : DEFAULT_SETTINGS.stepDelayMs,
  };
}

export async function saveSettings(next: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: next });
}
