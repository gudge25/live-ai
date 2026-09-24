import type { SessionInfo, ServerEvent } from '@live-ai/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { silentLog } from '../test/log.js';
import { SessionStore } from './session-store.js';
import { UiServer } from './ui-server.js';

const TOKEN = 'test-token-0123456789';
const info = (id: string, extension: string, startedAt = '2026-09-24T10:00:00.000Z'): SessionInfo => ({
  id,
  extension,
  channelId: `ch-${id}`,
  remote: { name: '', number: '+44' },
  startedAt,
  state: 'active',
});

describe('SessionStore', () => {
  it('keeps finals, replacing same side+turn', () => {
    const s = new SessionStore(5);
    s.add(info('a', '222'));
    const ts = new Date().toISOString();
    s.addFinal({ sessionId: 'a', side: 'agent', turn: 0, text: 'x', ts });
    s.addFinal({ sessionId: 'a', side: 'agent', turn: 0, text: 'X.', ts });
    s.addFinal({ sessionId: 'a', side: 'caller', turn: 0, text: 'Hi.', ts });
    expect(s.get('a')!.utterances.map((u) => u.text)).toEqual(['X.', 'Hi.']);
  });

  it('evicts the oldest ended sessions beyond the limit and keeps active ones', () => {
    const s = new SessionStore(2);
    for (const id of ['a', 'b', 'c', 'd']) s.add(info(id, '222'));
    s.update('a', { state: 'ended', endedAt: '2026-09-24T10:01:00.000Z' });
    s.update('b', { state: 'ended', endedAt: '2026-09-24T10:02:00.000Z' });
    s.update('c', { state: 'ended', endedAt: '2026-09-24T10:03:00.000Z' });
    expect(s.get('a')).toBeUndefined();
    expect(s.get('b')).toBeDefined();
    expect(s.get('d')?.state).toBe('active');
    expect(s.activeCount).toBe(1);
  });
});

describe('UiServer', () => {
  let store: SessionStore;
  let ui: UiServer;
  let port: number;
  beforeEach(async () => {
    store = new SessionStore(10);
    ui = new UiServer({ token: TOKEN, store, log: silentLog, ariStatus: () => 'connected' });
    port = await ui.listen(0, '127.0.0.1');
  });
  afterEach(() => ui.close());

  function connect(query: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ui?${query}`);
    const msgs: ServerEvent[] = [];
    const waiters: (() => void)[] = [];
    ws.on('message', (d) => {
      msgs.push(JSON.parse(String(d)));
      waiters.splice(0).forEach((w) => w());
    });
    const next = (n: number) =>
      new Promise<ServerEvent[]>((resolve) => {
        const check = () => (msgs.length >= n ? resolve(msgs) : waiters.push(check));
        check();
      });
    return { ws, msgs, next };
  }

  it('closes with 4401 when the token is missing or wrong', async () => {
    for (const q of ['', 'token=wrong']) {
      const { ws } = connect(q);
      const code = await new Promise<number>((r) => ws.on('close', (c) => r(c)));
      expect(code).toBe(4401);
    }
  });

  it('sends a snapshot with active sessions and their finals on connect', async () => {
    store.add(info('a', '222'));
    store.addFinal({ sessionId: 'a', side: 'caller', turn: 0, text: 'Hello.', ts: new Date().toISOString() });
    const c = connect(`token=${TOKEN}`);
    const [snap] = await c.next(1);
    expect(snap).toMatchObject({ type: 'snapshot', ari: 'connected', sessions: [{ id: 'a', utterances: [{ text: 'Hello.' }] }] });
    c.ws.close();
  });

  it('filters by extension via query and via subscribe message', async () => {
    store.add(info('a', '222'));
    store.add(info('b', '223'));
    const q = connect(`token=${TOKEN}&ext=222`);
    const [snap] = await q.next(1);
    expect(snap?.type === 'snapshot' && snap.sessions.map((s) => s.id)).toEqual(['a']);

    ui.broadcast({ type: 'partial', sessionId: 'b', side: 'agent', turn: 0, text: 'x', ts: new Date().toISOString() }, '223');
    ui.broadcast({ type: 'partial', sessionId: 'a', side: 'agent', turn: 0, text: 'y', ts: new Date().toISOString() }, '222');
    const msgs = await q.next(2);
    expect(msgs[1]).toMatchObject({ sessionId: 'a' });

    q.ws.send(JSON.stringify({ type: 'subscribe', extensions: ['223'] }));
    const after = await q.next(3);
    expect(after[2]?.type === 'snapshot' && after[2].sessions.map((s) => s.id)).toEqual(['b']);
    q.ws.close();
  });

  it('serves /healthz', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(await r.json()).toEqual({ ok: true, ari: 'connected', activeSessions: 0 });
  });
});
