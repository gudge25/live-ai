export class FetchTimeoutError extends Error {
  constructor(
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super(`fetch ${url} timed out after ${timeoutMs} ms`);
    this.name = 'FetchTimeoutError';
  }
}

/** `fetch` with a hard timeout; throws `FetchTimeoutError` instead of a raw `AbortError`/`TimeoutError` DOMException. */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<{ res: Response; text: string }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    return { res, text };
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new FetchTimeoutError(url, timeoutMs);
    }
    throw e;
  }
}
