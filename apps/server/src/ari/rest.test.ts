import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AriHttpError, AriRest, AriTimeoutError } from './rest.js';

let server: Server;
let base: string;
let requests: { method: string; url: string; auth?: string }[] = [];
let reply: (req: IncomingMessage) => { status: number; body?: unknown } | 'hang' = () => ({ status: 200, body: {} });

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization });
    const r = reply(req);
    if (r === 'hang') return; // never answer, like a PBX blocked on a channel lock
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(r.body === undefined ? '' : JSON.stringify(r.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
beforeEach(() => {
  requests = [];
  reply = () => ({ status: 200, body: {} });
});

const client = () => new AriRest({ url: base, user: 'u', password: 'p', app: 'live-ai' });

describe('AriRest', () => {
  it('sends basic auth and snoop params', async () => {
    reply = () => ({ status: 200, body: { id: 'liveai-x-snoop-agent' } });
    const ch = await client().snoopChannel('1695.1', { snoopId: 'liveai-x-snoop-agent', spy: 'in' });
    expect(ch.id).toBe('liveai-x-snoop-agent');
    const r = requests[0]!;
    expect(r.method).toBe('POST');
    expect(r.auth).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    const u = new URL(r.url, base);
    expect(u.pathname).toBe('/ari/channels/1695.1/snoop');
    expect(Object.fromEntries(u.searchParams)).toEqual({ app: 'live-ai', spy: 'in', whisper: 'none', snoopId: 'liveai-x-snoop-agent' });
  });

  it('creates audiosocket external media', async () => {
    await client().createExternalMedia({ channelId: 'liveai-x-em-agent', externalHost: '10.0.0.5:9092', data: 'uuid-1', format: 'slin' });
    const u = new URL(requests[0]!.url, base);
    expect(u.pathname).toBe('/ari/channels/externalMedia');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      app: 'live-ai',
      encapsulation: 'audiosocket',
      transport: 'tcp',
      format: 'slin',
      external_host: '10.0.0.5:9092',
      data: 'uuid-1',
      channelId: 'liveai-x-em-agent',
    });
  });

  it('creates a mixing bridge and adds channels', async () => {
    const c = client();
    await c.createBridge({ bridgeId: 'liveai-x-br-agent', name: 'liveai' });
    await c.addChannelsToBridge('liveai-x-br-agent', ['a', 'b']);
    expect(new URL(requests[0]!.url, base).searchParams.get('type')).toBe('mixing');
    const add = new URL(requests[1]!.url, base);
    expect(add.pathname).toBe('/ari/bridges/liveai-x-br-agent/addChannel');
    expect(add.searchParams.get('channel')).toBe('a,b');
  });

  it('subscribes to event sources', async () => {
    await client().subscribe(['endpoint:PJSIP/222', 'endpoint:PJSIP/223']);
    const u = new URL(requests[0]!.url, base);
    expect(u.pathname).toBe('/ari/applications/live-ai/subscription');
    expect(u.searchParams.get('eventSource')).toBe('endpoint:PJSIP/222,endpoint:PJSIP/223');
  });

  it('treats 404 on delete as success', async () => {
    reply = () => ({ status: 404, body: { message: 'Channel not found' } });
    await expect(client().hangupChannel('gone')).resolves.toBeUndefined();
    await expect(client().destroyBridge('gone')).resolves.toBeUndefined();
  });

  it('returns undefined for missing channel variable', async () => {
    reply = () => ({ status: 404, body: { message: 'not found' } });
    await expect(client().getChannelVar('c', 'BRIDGEPEER')).resolves.toBeUndefined();
  });

  it('times out a request the PBX never answers', async () => {
    reply = () => 'hang';
    const c = new AriRest({ url: base, user: 'u', password: 'p', app: 'live-ai', requestTimeoutMs: 100 });
    const t0 = Date.now();
    await expect(c.snoopChannel('1695.1', { snoopId: 's', spy: 'out' })).rejects.toBeInstanceOf(AriTimeoutError);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('throws AriHttpError with status on failure', async () => {
    reply = () => ({ status: 401, body: { message: 'Authentication required' } });
    await expect(client().listChannels()).rejects.toMatchObject({ status: 401 });
    await expect(client().listChannels()).rejects.toBeInstanceOf(AriHttpError);
  });
});
