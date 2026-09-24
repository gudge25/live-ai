import { EventEmitter } from 'node:events';
import type { AriApi } from '../ari/rest.js';
import { isBridgeChannelEvent, isChannelEvent, isDialEvent, type AriChannel } from '../ari/types.js';
import type { Logger } from '../logger.js';

/** Prefix for every ARI resource this service creates. */
export const RESOURCE_PREFIX = 'liveai-';

export interface MonitoredCall {
  channelId: string;
  channelName: string;
  extension: string;
  remote: { name: string; number: string };
  startedAt: Date;
}

export type EndReason = 'hangup' | 'left_bridge' | 'gone_after_reconnect';

export interface CallMonitorEvents {
  start: [MonitoredCall];
  end: [channelId: string, reason: EndReason];
}

/** Anything that emits raw ARI events and a `connected` signal after each (re)connect. */
export interface AriEventSource {
  on(event: 'event', l: (ev: Record<string, unknown> & { type: string }) => void): unknown;
  on(event: 'connected', l: () => void): unknown;
}

export interface CallMonitorOptions {
  api: AriApi;
  events: AriEventSource;
  extensions: string[];
  tech: string;
  log: Logger;
  /** How many times / how often to poll BRIDGEPEER after the channel is Up. */
  bridgeCheckAttempts?: number;
  bridgeCheckIntervalMs?: number;
  /** Wait before deciding that a channel which left a bridge is no longer talking (hold/transfer). */
  leaveGraceMs?: number;
}

type Tracked = { state: 'pending' | 'active'; call?: MonitoredCall };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Watches channels of monitored extensions and emits `start` exactly once when a
 * channel is Up and bridged with another party, and `end` when it goes away.
 */
export class CallMonitor extends EventEmitter<CallMonitorEvents> {
  private readonly tracked = new Map<string, Tracked>();
  private readonly attempts: number;
  private readonly interval: number;
  private readonly leaveGrace: number;

  constructor(private readonly o: CallMonitorOptions) {
    super();
    this.attempts = o.bridgeCheckAttempts ?? 10;
    this.interval = o.bridgeCheckIntervalMs ?? 300;
    this.leaveGrace = o.leaveGraceMs ?? 2000;
    o.events.on('connected', () => void this.onConnected());
    o.events.on('event', (ev) => void this.onEvent(ev).catch((err) => o.log.error({ err }, 'call monitor: event handling failed')));
  }

  get activeChannelIds(): string[] {
    return [...this.tracked].filter(([, t]) => t.state === 'active').map(([id]) => id);
  }

  eventSources(): string[] {
    return this.o.extensions.map((ext) => `endpoint:${this.o.tech}/${ext}`);
  }

  extensionOf(ch: Pick<AriChannel, 'id' | 'name'>): string | undefined {
    if (ch.id.startsWith(RESOURCE_PREFIX)) return undefined;
    return this.o.extensions.find((ext) => ch.name.startsWith(`${this.o.tech}/${ext}-`));
  }

  private async onConnected(): Promise<void> {
    const sources = this.eventSources();
    for (let i = 0; ; i++) {
      try {
        await this.o.api.subscribe(sources);
        this.o.log.info({ sources }, 'subscribed to monitored endpoints');
        break;
      } catch (err) {
        this.o.log.error({ err, attempt: i + 1 }, 'failed to subscribe to endpoints');
        if (i >= 4) return;
        await sleep(1000 * (i + 1));
      }
    }
    await this.reconcile();
  }

  /** After a reconnect: end calls that vanished, pick up calls that started while we were offline. */
  private async reconcile(): Promise<void> {
    let channels: AriChannel[];
    try {
      channels = await this.o.api.listChannels();
    } catch (err) {
      this.o.log.warn({ err }, 'reconcile: listChannels failed');
      return;
    }
    const alive = new Set(channels.map((c) => c.id));
    for (const id of this.activeChannelIds) if (!alive.has(id)) this.finish(id, 'gone_after_reconnect');
    for (const ch of channels) if (ch.state === 'Up' && this.extensionOf(ch)) void this.tryStart(ch);
  }

  private async onEvent(ev: Record<string, unknown> & { type: string }): Promise<void> {
    if (isChannelEvent(ev)) {
      if (!this.extensionOf(ev.channel)) return;
      if (ev.type === 'ChannelStateChange' && ev.channel.state === 'Up') await this.tryStart(ev.channel);
      else if (ev.type === 'ChannelDestroyed') this.finish(ev.channel.id, 'hangup');
    } else if (isBridgeChannelEvent(ev)) {
      if (!this.extensionOf(ev.channel)) return;
      if (ev.type === 'ChannelEnteredBridge') {
        const others = ev.bridge.channels.filter((id) => id !== ev.channel.id);
        if (ev.channel.state === 'Up' && others.length > 0) this.activate(ev.channel);
        else if (ev.channel.state === 'Up') await this.tryStart(ev.channel);
      } else {
        await this.onLeftBridge(ev.channel.id);
      }
    } else if (isDialEvent(ev)) {
      if (ev.dialstatus === 'ANSWER' && this.extensionOf(ev.peer)) await this.tryStart(ev.peer);
    }
  }

  private async tryStart(ch: AriChannel): Promise<void> {
    if (this.tracked.has(ch.id)) return;
    this.tracked.set(ch.id, { state: 'pending' });
    for (let i = 0; i < this.attempts; i++) {
      const t = this.tracked.get(ch.id);
      if (!t || t.state !== 'pending') return; // activated by a bridge event, or destroyed
      try {
        const peer = await this.o.api.getChannelVar(ch.id, 'BRIDGEPEER');
        if (peer) {
          this.activate(ch);
          return;
        }
      } catch (err) {
        this.o.log.debug({ err, channel: ch.id }, 'BRIDGEPEER lookup failed');
      }
      await sleep(this.interval);
    }
    if (this.tracked.get(ch.id)?.state === 'pending') this.tracked.delete(ch.id);
  }

  private activate(ch: AriChannel): void {
    const ext = this.extensionOf(ch);
    const t = this.tracked.get(ch.id);
    if (!ext || t?.state === 'active') return;
    const remote = ch.caller?.number && ch.caller.number !== ext ? ch.caller : ch.connected;
    const call: MonitoredCall = {
      channelId: ch.id,
      channelName: ch.name,
      extension: ext,
      remote: { name: remote?.name ?? '', number: remote?.number ?? '' },
      startedAt: new Date(),
    };
    this.tracked.set(ch.id, { state: 'active', call });
    this.o.log.info({ channel: ch.id, ext, remote: call.remote.number }, 'conversation started');
    this.emit('start', call);
  }

  private async onLeftBridge(channelId: string): Promise<void> {
    if (this.tracked.get(channelId)?.state !== 'active') return;
    await sleep(this.leaveGrace);
    if (this.tracked.get(channelId)?.state !== 'active') return;
    const peer = await this.o.api.getChannelVar(channelId, 'BRIDGEPEER').catch(() => undefined);
    if (!peer) this.finish(channelId, 'left_bridge');
  }

  private finish(channelId: string, reason: EndReason): void {
    const t = this.tracked.get(channelId);
    if (!t) return;
    this.tracked.delete(channelId);
    if (t.state === 'active') {
      this.o.log.info({ channel: channelId, reason }, 'conversation ended');
      this.emit('end', channelId, reason);
    }
  }
}
