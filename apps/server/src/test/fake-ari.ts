import { EventEmitter } from 'node:events';
import { AriHttpError, type AriApi } from '../ari/rest.js';
import type { AriBridge, AriChannel } from '../ari/types.js';

export type Call = { op: string; args: unknown[] };

/** In-memory ARI that records every call. `failOn` makes a given op throw once. */
export class FakeAri implements AriApi {
  readonly app = 'live-ai';
  calls: Call[] = [];
  channels = new Map<string, AriChannel>();
  bridges = new Map<string, AriBridge>();
  vars = new Map<string, Record<string, string>>();
  failOn = new Map<string, Error>();

  private rec(op: string, ...args: unknown[]) {
    this.calls.push({ op, args });
    const err = this.failOn.get(op);
    if (err) {
      this.failOn.delete(op);
      throw err;
    }
  }

  ops(): string[] {
    return this.calls.map((c) => c.op);
  }

  addChannel(ch: Partial<AriChannel> & { id: string; name: string }): AriChannel {
    const full: AriChannel = {
      state: 'Up',
      caller: { name: '', number: '' },
      connected: { name: '', number: '' },
      ...ch,
    };
    this.channels.set(full.id, full);
    return full;
  }

  async getChannel(id: string) {
    this.rec('getChannel', id);
    const ch = this.channels.get(id);
    if (!ch) throw new AriHttpError(404, 'GET', `/channels/${id}`, '');
    return ch;
  }
  async listChannels() {
    this.rec('listChannels');
    return [...this.channels.values()];
  }
  async getChannelVar(id: string, v: string) {
    this.rec('getChannelVar', id, v);
    return this.vars.get(id)?.[v];
  }
  async hangupChannel(id: string) {
    this.rec('hangupChannel', id);
    this.channels.delete(id);
  }
  async snoopChannel(channelId: string, p: { snoopId: string; spy: 'in' | 'out' | 'both' }) {
    this.rec('snoopChannel', channelId, p);
    return this.addChannel({ id: p.snoopId, name: `Snoop/${channelId}` });
  }
  async createExternalMedia(p: { channelId: string; externalHost: string; data: string; format: string }) {
    this.rec('createExternalMedia', p);
    return this.addChannel({ id: p.channelId, name: `AudioSocket/${p.externalHost}` });
  }
  async createBridge(p: { bridgeId: string; name: string }) {
    this.rec('createBridge', p);
    const b: AriBridge = { id: p.bridgeId, channels: [] };
    this.bridges.set(b.id, b);
    return b;
  }
  async listBridges() {
    this.rec('listBridges');
    return [...this.bridges.values()];
  }
  async addChannelsToBridge(bridgeId: string, ids: string[]) {
    this.rec('addChannelsToBridge', bridgeId, ids);
    this.bridges.get(bridgeId)?.channels.push(...ids);
  }
  async destroyBridge(id: string) {
    this.rec('destroyBridge', id);
    this.bridges.delete(id);
  }
  async subscribe(sources: string[]) {
    this.rec('subscribe', sources);
  }
}

export class FakeEvents extends EventEmitter {
  push(ev: Record<string, unknown> & { type: string }) {
    this.emit('event', ev);
  }
  reconnect() {
    this.emit('connected');
  }
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
