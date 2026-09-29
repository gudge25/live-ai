import type { Logger } from '../logger.js';

export interface SummaryOptions {
  apiKey: string;
  model: string;
  systemPrompt: string;
  timeoutMs: number;
}

/** Resolves to the summary text, or `undefined` if the call failed for any reason. */
export type SummaryClient = (transcriptText: string, log: Logger) => Promise<string | undefined>;

const ENDPOINT = 'https://llm-gateway.assemblyai.com/v1/chat/completions';

/** Factory that binds the API key and model settings; the key never leaves the server. */
export function summaryClientFactory(o: SummaryOptions): SummaryClient {
  return async (transcriptText, log) => {
    let res: Response;
    let text: string;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { authorization: o.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: o.model,
          messages: [
            { role: 'system', content: o.systemPrompt },
            { role: 'user', content: transcriptText },
          ],
          temperature: 0.3,
          max_tokens: 200,
        }),
        signal: AbortSignal.timeout(o.timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        log.warn({ timeoutMs: o.timeoutMs }, 'AAI LLM Gateway: summary request timed out');
      } else {
        log.warn({ err: e }, 'AAI LLM Gateway: summary request errored');
      }
      return undefined;
    }
    if (!res.ok) {
      log.warn({ status: res.status }, 'AAI LLM Gateway: summary request failed');
      return undefined;
    }
    let content: unknown;
    try {
      content = (JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
    } catch (e) {
      log.warn({ err: e }, 'AAI LLM Gateway: summary response was not valid JSON');
      return undefined;
    }
    if (typeof content !== 'string' || !content) {
      log.warn({}, 'AAI LLM Gateway: summary response missing content');
      return undefined;
    }
    return content;
  };
}
