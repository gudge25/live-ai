import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, buildSocketUrl, normalizeSettings, parseExtensions } from './settings';

describe('settings', () => {
  it('builds the socket url with token and extensions', () => {
    const url = new URL(buildSocketUrl({ ...DEFAULT_SETTINGS, token: 'a b', extensions: '222, 223,,222' }));
    expect(url.searchParams.get('token')).toBe('a b');
    expect(url.searchParams.get('ext')).toBe('222,223');
  });

  it('rejects non-ws urls', () => {
    expect(() => buildSocketUrl({ ...DEFAULT_SETTINGS, serverUrl: 'http://x' })).toThrow();
  });

  it('fills defaults for missing fields', () => {
    expect(normalizeSettings({ token: 't', extensions: 5 })).toEqual({ ...DEFAULT_SETTINGS, token: 't' });
    expect(parseExtensions('')).toEqual([]);
  });
});
