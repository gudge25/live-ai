import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { silentLog } from '../test/log.js';
import { AriEventStream } from './events.js';

let wss: WebSocketServer | undefined;
let stream: AriEventStream | undefined;
afterEach(async () => {
  stream?.stop();
  await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
});

async function listen(opts: ConstructorParameters<typeof WebSocketServer>[0] = {}): Promise<number> {
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1', ...opts });
  await new Promise((r) => wss!.once('listening', r));
  return (wss.address() as AddressInfo).port;
}

const waitFor = <T>(fn: (resolve: (v: T) => void) => void, ms = 3000) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    fn((v) => {
      clearTimeout(t);
      resolve(v);
    });
  });

describe('AriEventStream', () => {
  it('computes capped exponential backoff', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((a) => AriEventStream.backoff(a, 1000, 30_000))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });

  it('connects with app + auth, emits events and reconnects after drop', async () => {
    const seen: { url: string; auth?: string }[] = [];
    const port = await listen();
    wss!.on('connection', (ws, req) => {
      seen.push({ url: req.url!, auth: req.headers.authorization });
      if (seen.length === 1) {
        ws.send(JSON.stringify({ type: 'ChannelStateChange', channel: { id: 'c1' } }));
        setTimeout(() => ws.terminate(), 20);
      }
    });
    stream = new AriEventStream({ url: `http://127.0.0.1:${port}`, user: 'u', password: 'p', app: 'live-ai', initialDelayMs: 20 }, silentLog);

    const statuses: string[] = [];
    stream.on('status', (s) => statuses.push(s));
    let connects = 0;
    const gotEvent = waitFor<string>((res) => stream!.on('event', (e) => res(e.type)));
    const reconnected = waitFor<void>((res) =>
      stream!.on('connected', () => {
        if (++connects === 2) res();
      }),
    );
    stream.start();

    expect(await gotEvent).toBe('ChannelStateChange');
    await reconnected;
    expect(statuses).toEqual(['connected', 'reconnecting', 'connected']);
    const u = new URL(seen[0]!.url, 'http://x');
    expect(u.pathname).toBe('/ari/events');
    expect(u.searchParams.get('app')).toBe('live-ai');
    expect(seen[0]!.auth).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('keeps retrying when the server rejects auth', async () => {
    const port = await listen({ verifyClient: (_info, cb) => cb(false, 401, 'Unauthorized') });
    stream = new AriEventStream({ url: `http://127.0.0.1:${port}`, user: 'u', password: 'bad', app: 'a', initialDelayMs: 10 }, silentLog);
    const reconnecting = waitFor<void>((res) => stream!.on('status', (s) => s === 'reconnecting' && res()));
    stream.start();
    await reconnecting;
  });
});
