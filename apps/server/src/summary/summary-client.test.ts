import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logger.js';
import { summaryClientFactory } from './summary-client.js';

const opts = { apiKey: 'aai-key-123', model: 'qwen3.5-4b-32k-fast', systemPrompt: 'Summarize briefly.', timeoutMs: 5000 };

function fakeLog() {
  const warn = vi.fn();
  return { log: { warn } as unknown as Logger, warn };
}

const fetchMockOf = (impl: (url: string, init?: RequestInit) => Promise<Response>) => vi.fn(impl);

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('summaryClientFactory', () => {
  it('sends the raw API key (no Bearer prefix) and returns the completion text', async () => {
    const fetchMock = fetchMockOf(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Short summary.' } }] }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = summaryClientFactory(opts);
    const { log } = fakeLog();

    const summary = await client('Agent: hi\nCaller: hello', log);

    expect(summary).toBe('Short summary.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://llm-gateway.assemblyai.com/v1/chat/completions');
    expect(init!.headers).toMatchObject({ authorization: 'aai-key-123' });
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      model: 'qwen3.5-4b-32k-fast',
      messages: [
        { role: 'system', content: 'Summarize briefly.' },
        { role: 'user', content: 'Agent: hi\nCaller: hello' },
      ],
      temperature: 0.3,
      max_tokens: 200,
    });
  });

  it('returns undefined and logs a warning on a non-2xx response', async () => {
    globalThis.fetch = fetchMockOf(async () => new Response(JSON.stringify({ message: 'nope' }), { status: 400 })) as unknown as typeof fetch;
    const client = summaryClientFactory(opts);
    const { log, warn } = fakeLog();

    expect(await client('text', log)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }), expect.any(String));
  });

  it('returns undefined and logs a warning on timeout', async () => {
    globalThis.fetch = fetchMockOf(async () => {
      throw new DOMException('aborted', 'TimeoutError');
    }) as unknown as typeof fetch;
    const client = summaryClientFactory(opts);
    const { log, warn } = fakeLog();

    expect(await client('text', log)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 5000 }), expect.stringMatching(/timed out/));
  });

  it('returns undefined and logs a warning on a network error', async () => {
    globalThis.fetch = fetchMockOf(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const client = summaryClientFactory(opts);
    const { log, warn } = fakeLog();

    expect(await client('text', log)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringMatching(/errored/));
  });

  it('returns undefined and logs a warning when the response has no content', async () => {
    globalThis.fetch = fetchMockOf(async () => new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 })) as unknown as typeof fetch;
    const client = summaryClientFactory(opts);
    const { log, warn } = fakeLog();

    expect(await client('text', log)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
