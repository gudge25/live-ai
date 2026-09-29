import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, redactConfig } from './config.js';

const base = {
  ARI_URL: 'https://pbx.local:8089',
  ARI_USER: 'liveai',
  ARI_PASSWORD: 's3cr3t-ari-pass',
  MONITORED_EXTENSIONS: '222, 223',
  AUDIOSOCKET_ADVERTISE_HOST: '10.0.0.5:9092',
  ASSEMBLYAI_API_KEY: 'aai-key-123',
  UI_TOKEN: 'a-very-long-ui-token',
};

describe('loadConfig', () => {
  it('parses valid env with defaults', () => {
    const cfg = loadConfig(base);
    expect(cfg.MONITORED_EXTENSIONS).toEqual(['222', '223']);
    expect(cfg.CHANNEL_TECH).toBe('PJSIP');
    expect(cfg.AAI_LANGUAGE_CODES).toEqual(['en']);
    expect(cfg.AAI_DUAL_CHANNEL).toBe(false);
    expect(cfg.UI_PORT).toBe(8765);
    expect(cfg.AAI_SUMMARY_ENABLED).toBe(false);
    expect(cfg.AAI_SUMMARY_MODEL).toBe('qwen3.5-4b-32k-fast');
    expect(cfg.AAI_SUMMARY_TIMEOUT_MS).toBe(10000);
    expect(cfg.AAI_SUMMARY_SYSTEM_PROMPT).toMatch(/Plain text only/);
  });

  it('parses explicit summary settings', () => {
    const cfg = loadConfig({
      ...base,
      AAI_SUMMARY_ENABLED: 'true',
      AAI_SUMMARY_MODEL: 'gemini-2.5-flash-lite',
      AAI_SUMMARY_TIMEOUT_MS: '5000',
      AAI_SUMMARY_SYSTEM_PROMPT: 'Summarize briefly.',
    });
    expect(cfg.AAI_SUMMARY_ENABLED).toBe(true);
    expect(cfg.AAI_SUMMARY_MODEL).toBe('gemini-2.5-flash-lite');
    expect(cfg.AAI_SUMMARY_TIMEOUT_MS).toBe(5000);
    expect(cfg.AAI_SUMMARY_SYSTEM_PROMPT).toBe('Summarize briefly.');
  });

  it('reports a clear error when ARI_URL is missing', () => {
    const { ARI_URL: _, ...env } = base;
    try {
      loadConfig(env);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toContain('ARI_URL is required');
    }
  });

  it('treats empty strings as unset', () => {
    expect(() => loadConfig({ ...base, ARI_URL: '' })).toThrow(/ARI_URL is required/);
  });

  it('rejects a non-http ARI_URL', () => {
    expect(() => loadConfig({ ...base, ARI_URL: 'ftp://x' })).toThrow(/ARI_URL/);
  });

  it('never includes secrets in the error message', () => {
    try {
      loadConfig({ ...base, UI_TOKEN: 'short' });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('s3cr3t-ari-pass');
      expect((e as Error).message).not.toContain('aai-key-123');
    }
  });
});

describe('redactConfig', () => {
  it('does not leak the ARI password into logs', () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    });
    const log = pino(sink);
    log.info({ config: redactConfig(loadConfig(base)) }, 'config loaded');
    const out = chunks.join('');
    expect(out).toContain('config loaded');
    expect(out).not.toContain('s3cr3t-ari-pass');
    expect(out).not.toContain('aai-key-123');
    expect(out).not.toContain('a-very-long-ui-token');
  });
});
