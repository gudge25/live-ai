export interface Settings {
  /** Backend UI WebSocket endpoint, e.g. ws://localhost:8765/ui */
  serverUrl: string;
  token: string;
  /** Comma-separated extensions to display; empty means all. */
  extensions: string;
  agentLabel: string;
  callerLabel: string;
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: 'ws://localhost:8765/ui',
  token: '',
  extensions: '222',
  agentLabel: 'Agent',
  callerLabel: 'Caller',
};

export const SETTINGS_KEY = 'settings';

export function normalizeSettings(raw: unknown): Settings {
  const s = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === 'string') s[k] = v;
    }
  }
  return s;
}

export function parseExtensions(list: string): string[] {
  return [...new Set(list.split(',').map((e) => e.trim()).filter(Boolean))];
}

/** Builds `${serverUrl}?token=..&ext=..`; throws on an invalid URL. */
export function buildSocketUrl(settings: Settings): string {
  const url = new URL(settings.serverUrl);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Server URL must start with ws:// or wss://');
  url.searchParams.set('token', settings.token);
  const exts = parseExtensions(settings.extensions);
  if (exts.length) url.searchParams.set('ext', exts.join(','));
  else url.searchParams.delete('ext');
  return url.toString();
}
