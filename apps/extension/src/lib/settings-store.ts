import { browser } from 'wxt/browser';
import { normalizeSettings, SETTINGS_KEY, type Settings } from './settings';

export async function loadSettings(): Promise<Settings> {
  const res = await browser.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(res[SETTINGS_KEY]);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
}

/** Calls `cb` whenever settings change in any extension page. Returns an unsubscribe function. */
export function watchSettings(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && SETTINGS_KEY in changes) cb(normalizeSettings(changes[SETTINGS_KEY]?.newValue));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
