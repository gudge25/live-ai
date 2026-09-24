import { describe, expect, it } from 'vitest';
import { silentLog } from '../test/log.js';
import { CallTranscription, type SdkParams } from './call-transcription.js';
import { FakeSdk } from './fake-sdk.js';
import type { TranscriptEvent } from './turn-mapper.js';

const frame = () => Buffer.alloc(320); // 20 ms of slin 8 kHz

function setup(dualChannel = false, sdkFactory?: (p: SdkParams) => FakeSdk) {
  const created: { sdk: FakeSdk; params: SdkParams }[] = [];
  const events: TranscriptEvent[] = [];
  const degraded: string[] = [];
  const ct = new CallTranscription({
    createSdk: (params) => {
      const sdk = sdkFactory ? sdkFactory(params) : new FakeSdk();
      created.push({ sdk, params });
      return sdk;
    },
    sampleRate: 8000,
    dualChannel,
    onTranscript: (e) => events.push(e),
    onDegraded: (side) => degraded.push(side ?? 'both'),
    log: silentLog,
    reconnectDelayMs: 1,
  });
  return { ct, created, events, degraded };
}

describe('CallTranscription (one session per side)', () => {
  it('opens one AAI session per side at the input sample rate', async () => {
    const { ct, created } = setup();
    await ct.start();
    expect(created).toHaveLength(2);
    expect(created.every((c) => c.params.sampleRate === 8000 && !c.params.channels)).toBe(true);
  });

  it('aggregates 20 ms frames into 100 ms chunks (1600 bytes)', async () => {
    const { ct, created } = setup();
    await ct.start();
    for (let i = 0; i < 12; i++) ct.send('agent', frame());
    const agent = created[0]!.sdk;
    expect(agent.sent).toEqual([{ bytes: 1600, channel: undefined }, { bytes: 1600, channel: undefined }]);
    expect(created[1]!.sdk.sent).toHaveLength(0);
  });

  it('flushes the remainder and terminates gracefully on hangup', async () => {
    const { ct, created } = setup();
    await ct.start();
    for (let i = 0; i < 3; i++) ct.send('caller', frame());
    await ct.close();
    const caller = created[1]!.sdk;
    expect(caller.sent).toEqual([{ bytes: 960, channel: undefined }]);
    expect(caller.closedWith).toEqual({ wait: true, timeout: 5000 });
    expect(created[0]!.sdk.closedWith?.wait).toBe(true);
  });

  it('tags transcripts with the side', async () => {
    const { ct, created, events } = setup();
    await ct.start();
    created[1]!.sdk.turn({ turn_order: 0, transcript: 'Hi there.', end_of_turn: true, turn_is_formatted: true });
    expect(events).toEqual([{ kind: 'final', side: 'caller', turn: 0, text: 'Hi there.' }]);
  });

  it('reconnects after an unexpected close and keeps streaming', async () => {
    const { ct, created, degraded } = setup();
    await ct.start();
    created[0]!.sdk.drop();
    await new Promise((r) => setTimeout(r, 20));
    expect(created).toHaveLength(3);
    for (let i = 0; i < 5; i++) ct.send('agent', frame());
    expect(created[2]!.sdk.sent).toHaveLength(1);
    expect(degraded).toHaveLength(0);
  });

  it('reports transcription_degraded after 3 failed reconnects', async () => {
    let n = 0;
    const { ct, created, degraded } = setup(false, () => {
      const s = new FakeSdk();
      if (n++ >= 2) s.connectError = new Error('503');
      return s;
    });
    await ct.start();
    created[0]!.sdk.drop();
    await new Promise((r) => setTimeout(r, 50));
    expect(degraded).toEqual(['agent']);
    expect(created.length).toBe(2 + 3);
  });
});

describe('CallTranscription (dual-channel)', () => {
  it('uses a single session with agent/caller channels and passes frames through', async () => {
    const { ct, created } = setup(true);
    await ct.start();
    expect(created).toHaveLength(1);
    expect(created[0]!.params.channels).toEqual([{ name: 'agent' }, { name: 'caller' }]);
    ct.send('agent', frame());
    ct.send('caller', frame());
    expect(created[0]!.sdk.sent).toEqual([
      { bytes: 320, channel: 'agent' },
      { bytes: 320, channel: 'caller' },
    ]);
  });
});
