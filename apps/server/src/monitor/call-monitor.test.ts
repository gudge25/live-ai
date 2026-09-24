import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAri, FakeEvents, tick } from '../test/fake-ari.js';
import { silentLog } from '../test/log.js';
import { CallMonitor, type MonitoredCall } from './call-monitor.js';

let ari: FakeAri;
let events: FakeEvents;
let monitor: CallMonitor;
let started: MonitoredCall[];
let ended: [string, string][];

const ch = (state: string, id = '1695.10', name = 'PJSIP/222-0000000a') => ({
  id,
  name,
  state,
  caller: { name: 'Bob', number: '+447700900123' },
  connected: { name: '', number: '222' },
});

beforeEach(() => {
  ari = new FakeAri();
  events = new FakeEvents();
  monitor = new CallMonitor({
    api: ari,
    events,
    extensions: ['222'],
    tech: 'PJSIP',
    log: silentLog,
    bridgeCheckAttempts: 3,
    bridgeCheckIntervalMs: 5,
    leaveGraceMs: 5,
  });
  started = [];
  ended = [];
  monitor.on('start', (c) => started.push(c));
  monitor.on('end', (id, r) => ended.push([id, r]));
});

describe('CallMonitor', () => {
  it('subscribes to endpoint event sources on every (re)connect', async () => {
    events.reconnect();
    await tick(5);
    events.reconnect();
    await tick(5);
    const subs = ari.calls.filter((c) => c.op === 'subscribe');
    expect(subs).toHaveLength(2);
    expect(subs[1]!.args[0]).toEqual(['endpoint:PJSIP/222']);
  });

  it('starts a session when 222 answers and is bridged', async () => {
    ari.addChannel(ch('Up'));
    ari.vars.set('1695.10', { BRIDGEPEER: 'PJSIP/trunk-00000009' });
    events.push({ type: 'ChannelStateChange', channel: ch('Ringing') });
    events.push({ type: 'ChannelStateChange', channel: ch('Up') });
    await tick(20);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ channelId: '1695.10', extension: '222', remote: { number: '+447700900123', name: 'Bob' } });
  });

  it('starts immediately on ChannelEnteredBridge with another party', async () => {
    events.push({ type: 'ChannelEnteredBridge', channel: ch('Up'), bridge: { id: 'b1', channels: ['1695.10', '1695.9'] } });
    await tick(1);
    expect(started).toHaveLength(1);
  });

  it('does not start while ringing without answer', async () => {
    events.push({ type: 'ChannelStateChange', channel: ch('Ringing') });
    events.push({ type: 'ChannelDestroyed', channel: ch('Ringing') });
    await tick(20);
    expect(started).toHaveLength(0);
    expect(ended).toHaveLength(0);
  });

  it('does not start when Up but never bridged (e.g. voicemail)', async () => {
    events.push({ type: 'ChannelStateChange', channel: ch('Up') });
    await tick(40);
    expect(started).toHaveLength(0);
  });

  it('dedupes repeated events for the same channel', async () => {
    ari.vars.set('1695.10', { BRIDGEPEER: 'PJSIP/trunk-9' });
    events.push({ type: 'ChannelStateChange', channel: ch('Up') });
    events.push({ type: 'ChannelStateChange', channel: ch('Up') });
    events.push({ type: 'ChannelEnteredBridge', channel: ch('Up'), bridge: { id: 'b1', channels: ['1695.10', 'x'] } });
    events.push({ type: 'Dial', peer: ch('Up'), dialstatus: 'ANSWER' });
    await tick(20);
    expect(started).toHaveLength(1);
  });

  it('ends the session on hangup', async () => {
    events.push({ type: 'ChannelEnteredBridge', channel: ch('Up'), bridge: { id: 'b1', channels: ['1695.10', 'x'] } });
    events.push({ type: 'ChannelDestroyed', channel: ch('Up') });
    await tick(1);
    expect(ended).toEqual([['1695.10', 'hangup']]);
  });

  it('ends after leaving the bridge only if not re-bridged within grace', async () => {
    events.push({ type: 'ChannelEnteredBridge', channel: ch('Up'), bridge: { id: 'b1', channels: ['1695.10', 'x'] } });
    ari.vars.set('1695.10', { BRIDGEPEER: 'PJSIP/other-1' }); // e.g. transfer: bridged again
    events.push({ type: 'ChannelLeftBridge', channel: ch('Up'), bridge: { id: 'b1', channels: [] } });
    await tick(20);
    expect(ended).toHaveLength(0);
    ari.vars.set('1695.10', {});
    events.push({ type: 'ChannelLeftBridge', channel: ch('Up'), bridge: { id: 'b2', channels: [] } });
    await tick(20);
    expect(ended).toEqual([['1695.10', 'left_bridge']]);
  });

  it('ignores other extensions and own liveai- channels', async () => {
    events.push({ type: 'ChannelEnteredBridge', channel: ch('Up', '1', 'PJSIP/2220-01'), bridge: { id: 'b', channels: ['1', '2'] } });
    events.push({ type: 'ChannelEnteredBridge', channel: ch('Up', 'liveai-x', 'PJSIP/222-01'), bridge: { id: 'b', channels: ['1', '2'] } });
    await tick(1);
    expect(started).toHaveLength(0);
  });

  it('reconciles after reconnect: ends vanished calls and picks up new ones', async () => {
    events.push({ type: 'ChannelEnteredBridge', channel: ch('Up'), bridge: { id: 'b1', channels: ['1695.10', 'x'] } });
    await tick(1);
    // while disconnected: 1695.10 hung up, 1695.20 started
    ari.addChannel(ch('Up', '1695.20', 'PJSIP/222-00000014'));
    ari.vars.set('1695.20', { BRIDGEPEER: 'PJSIP/trunk-15' });
    events.reconnect();
    await tick(30);
    expect(ended).toEqual([['1695.10', 'gone_after_reconnect']]);
    expect(started.map((s) => s.channelId)).toEqual(['1695.10', '1695.20']);
  });
});
