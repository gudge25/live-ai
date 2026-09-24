import { connect } from 'node:net';
import type { ServerEvent } from '@live-ai/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LiveAiApp } from './app.js';
import { encodeFrame, Kind, uuidToBytes } from './audiosocket/protocol.js';
import { AudioSocketServer } from './audiosocket/server.js';
import { SessionStore } from './hub/session-store.js';
import { FakeAri, FakeEvents, tick } from './test/fake-ari.js';
import { silentLog } from './test/log.js';
import { FakeSdk } from './transcription/fake-sdk.js';

let ari: FakeAri;
let events: FakeEvents;
let audio: AudioSocketServer;
let port: number;
let sdks: FakeSdk[];
let sent: ServerEvent[];
let store: SessionStore;
let app: LiveAiApp;

const agentChannel = { id: '1695.10', name: 'PJSIP/222-0000000a', state: 'Up', caller: { name: 'Bob', number: '+447700900123' }, connected: { name: '', number: '222' } };
const bridged = { type: 'ChannelEnteredBridge', channel: agentChannel, bridge: { id: 'dial-bridge', channels: ['1695.10', '1695.9'] } };

beforeEach(async () => {
  ari = new FakeAri();
  ari.addChannel(agentChannel);
  events = new FakeEvents();
  audio = new AudioSocketServer(silentLog);
  port = await audio.listen(0, '127.0.0.1');
  sdks = [];
  sent = [];
  store = new SessionStore(10);
  app = new LiveAiApp({
    api: ari,
    events,
    audio,
    createSdk: () => {
      const s = new FakeSdk();
      sdks.push(s);
      return s;
    },
    store,
    log: silentLog,
    extensions: ['222'],
    tech: 'PJSIP',
    advertiseHost: `127.0.0.1:${port}`,
    sampleRate: 8000,
    dualChannel: false,
    maxConcurrent: 5,
    logTranscripts: false,
  });
  app.attachUi({ broadcast: (ev) => sent.push(ev) });
});
afterEach(() => audio.close());

/** Plays the part of Asterisk: connect to the AudioSocket server with the UUID we were given. */
async function asteriskConnects(side: 'agent' | 'caller', frames: number) {
  const em = ari.calls.find((c) => c.op === 'createExternalMedia' && (c.args[0] as { channelId: string }).channelId.endsWith(side))!;
  const uuid = (em.args[0] as { data: string }).data;
  const s = connect(port, '127.0.0.1');
  await new Promise((r) => s.on('connect', r));
  s.write(encodeFrame(Kind.Uuid, uuidToBytes(uuid)));
  for (let i = 0; i < frames; i++) s.write(encodeFrame(Kind.Audio, Buffer.alloc(320)));
  await tick(20);
  return s;
}

describe('LiveAiApp end-to-end (fake Asterisk + fake AssemblyAI)', () => {
  it('222 answers -> tap -> audio -> transcript -> UI; hangup -> cleanup', async () => {
    events.push(bridged);
    await tick(20);

    expect(sent[0]).toMatchObject({ type: 'session_started', session: { extension: '222', remote: { number: '+447700900123' } } });
    expect(sdks).toHaveLength(2);
    expect([...ari.channels.keys()].filter((id) => id.startsWith('liveai-'))).toHaveLength(4);

    await asteriskConnects('agent', 10); // 200 ms
    expect(sdks[0]!.sent.map((x) => x.bytes)).toEqual([1600, 1600]);

    sdks[1]!.turn({ turn_order: 0, transcript: 'hi i have a' });
    sdks[1]!.turn({ turn_order: 0, transcript: 'Hi, I have a question.', end_of_turn: true, turn_is_formatted: true });
    expect(sent.filter((e) => e.type === 'partial' || e.type === 'final').map((e) => [e.type, 'side' in e && e.side])).toEqual([
      ['partial', 'caller'],
      ['final', 'caller'],
    ]);

    events.push({ type: 'ChannelDestroyed', channel: agentChannel });
    await tick(30);

    expect(sent.at(-1)).toMatchObject({ type: 'session_ended', state: 'ended' });
    expect([...ari.channels.keys()].filter((id) => id.startsWith('liveai-'))).toEqual([]);
    expect(ari.bridges.size).toBe(0);
    expect(sdks.every((s) => s.closedWith?.wait === true)).toBe(true);
    expect(store.snapshot()[0]).toMatchObject({ state: 'ended', utterances: [{ text: 'Hi, I have a question.' }] });
  });

  it('marks the session tap_failed and leaves the call alone when ARI refuses the snoop', async () => {
    ari.failOn.set('snoopChannel', new Error('Channel not in Stasis'));
    events.push(bridged);
    await tick(20);
    expect(sent.map((e) => e.type)).toEqual(['session_started', 'status', 'session_ended']);
    expect(sent[1]).toMatchObject({ scope: 'tap', state: 'tap_failed' });
    expect(ari.channels.has('1695.10')).toBe(true);
    expect(ari.bridges.size).toBe(0);
    expect(app.activeChannels).toEqual([]);
  });

  it('cleans orphans only on the first connect', async () => {
    ari.addChannel({ id: 'liveai-old-em-agent', name: 'AudioSocket/x' });
    events.reconnect();
    await tick(10);
    expect(ari.channels.has('liveai-old-em-agent')).toBe(false);
    ari.addChannel({ id: 'liveai-live-em-agent', name: 'AudioSocket/x' });
    events.reconnect();
    await tick(10);
    expect(ari.channels.has('liveai-live-em-agent')).toBe(true);
  });

  it('broadcasts ARI link status', () => {
    events.emit('status', 'reconnecting');
    expect(sent).toEqual([{ type: 'status', scope: 'ari', state: 'reconnecting' }]);
  });
});
