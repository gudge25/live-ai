import { beforeEach, describe, expect, it } from 'vitest';
import { AriHttpError } from '../ari/rest.js';
import type { AudioSink } from '../audiosocket/server.js';
import { FakeAri } from '../test/fake-ari.js';
import { silentLog } from '../test/log.js';
import { TapError, TapOrchestrator } from './tap.js';

const sink: AudioSink = { onAudio() {}, onEnd() {} };
const sinks = { agent: sink, caller: sink };

let ari: FakeAri;
let registered: Set<string>;
let tap: TapOrchestrator;

beforeEach(() => {
  ari = new FakeAri();
  ari.addChannel({ id: '1695.10', name: 'PJSIP/222-0000000a' });
  registered = new Set();
  tap = new TapOrchestrator({
    api: ari,
    audio: { register: (u) => registered.add(u), unregister: (u) => registered.delete(u) },
    advertiseHost: '10.0.0.5:9092',
    log: silentLog,
  });
});

const ours = () => ({
  channels: [...ari.channels.keys()].filter((id) => id.startsWith('liveai-')),
  bridges: [...ari.bridges.keys()],
});

describe('TapOrchestrator.attach', () => {
  it('creates exactly 2 snoops, 2 audiosocket channels and 2 bridges with the right params', async () => {
    const h = await tap.attach('s1', '1695.10', sinks);
    expect(ours().channels.sort()).toEqual(
      ['liveai-s1-em-agent', 'liveai-s1-em-caller', 'liveai-s1-snoop-agent', 'liveai-s1-snoop-caller'].sort(),
    );
    expect(ours().bridges.sort()).toEqual(['liveai-s1-br-agent', 'liveai-s1-br-caller']);

    const snoops = ari.calls.filter((c) => c.op === 'snoopChannel');
    expect(snoops.map((c) => c.args)).toEqual([
      ['1695.10', { snoopId: 'liveai-s1-snoop-agent', spy: 'in' }],
      ['1695.10', { snoopId: 'liveai-s1-snoop-caller', spy: 'out' }],
    ]);
    const ems = ari.calls.filter((c) => c.op === 'createExternalMedia').map((c) => c.args[0] as Record<string, string>);
    expect(ems.every((e) => e.externalHost === '10.0.0.5:9092' && e.format === 'slin')).toBe(true);
    expect(ems.map((e) => e.data).sort()).toEqual([...h.uuids].sort());
    expect(registered.size).toBe(2);

    expect(ari.bridges.get('liveai-s1-br-agent')!.channels).toEqual(['liveai-s1-snoop-agent', 'liveai-s1-em-agent']);
    expect(ari.bridges.get('liveai-s1-br-caller')!.channels).toEqual(['liveai-s1-snoop-caller', 'liveai-s1-em-caller']);
  });

  it('registers the AudioSocket UUID before Asterisk is asked to connect', async () => {
    const order: string[] = [];
    const origEm = ari.createExternalMedia.bind(ari);
    ari.createExternalMedia = async (p) => {
      order.push(registered.has(p.data) ? 'registered' : 'NOT registered');
      return origEm(p);
    };
    await tap.attach('s1', '1695.10', sinks);
    expect(order).toEqual(['registered', 'registered']);
  });
});

describe('TapOrchestrator cleanup', () => {
  it('removes everything after the session ends', async () => {
    await tap.attach('s1', '1695.10', sinks);
    await tap.detach('s1');
    expect(ours()).toEqual({ channels: [], bridges: [] });
    expect(registered.size).toBe(0);
    expect(ari.channels.has('1695.10')).toBe(true); // the real call is never touched
  });

  it('rolls back partially created resources when step 3 fails', async () => {
    ari.failOn.set('createExternalMedia', new AriHttpError(500, 'POST', '/channels/externalMedia', 'boom'));
    await expect(tap.attach('s1', '1695.10', sinks)).rejects.toBeInstanceOf(TapError);
    expect(ours()).toEqual({ channels: [], bridges: [] });
    expect(registered.size).toBe(0);
    expect(ari.ops()).toContain('hangupChannel');
    expect(ari.ops()).toContain('destroyBridge');
  });

  it('is a no-op for unknown sessions', async () => {
    await tap.detach('nope');
    expect(ari.calls).toHaveLength(0);
  });

  it('removes orphaned liveai- resources but not in-use or foreign ones', async () => {
    ari.addChannel({ id: 'liveai-old-snoop-agent', name: 'Snoop/x' });
    ari.addChannel({ id: 'liveai-old-em-agent', name: 'AudioSocket/x' });
    ari.bridges.set('liveai-old-br-agent', { id: 'liveai-old-br-agent', channels: [] });
    ari.bridges.set('foreign-bridge', { id: 'foreign-bridge', channels: [] });
    await tap.attach('live', '1695.10', sinks);

    const r = await tap.cleanupOrphans();
    expect(r).toEqual({ channels: 2, bridges: 1 });
    expect(ari.channels.has('liveai-old-snoop-agent')).toBe(false);
    expect(ari.bridges.has('foreign-bridge')).toBe(true);
    expect(ari.channels.has('1695.10')).toBe(true);
    expect(ours().channels.filter((id) => id.startsWith('liveai-live-'))).toHaveLength(4);
  });
});
