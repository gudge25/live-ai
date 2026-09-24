import { randomUUID } from 'node:crypto';
import type { Side } from '@live-ai/shared';
import type { AriApi } from '../ari/rest.js';
import type { AudioSink, AudioSocketServer } from '../audiosocket/server.js';
import type { Logger } from '../logger.js';
import { RESOURCE_PREFIX } from '../monitor/call-monitor.js';

/** Snoop direction per side: `in` = audio coming from the monitored phone, `out` = audio it hears. */
export const SPY: Record<Side, 'in' | 'out'> = { agent: 'in', caller: 'out' };
const SIDES: Side[] = ['agent', 'caller'];

export interface TapHandle {
  sessionId: string;
  channels: string[];
  bridges: string[];
  uuids: string[];
}

export class TapError extends Error {
  constructor(
    message: string,
    readonly cause: unknown,
  ) {
    super(message);
    this.name = 'TapError';
  }
}

export interface TapOptions {
  api: AriApi;
  audio: Pick<AudioSocketServer, 'register' | 'unregister'>;
  /** host:port that Asterisk connects to. */
  advertiseHost: string;
  format?: string;
  log: Logger;
}

export const resourceId = (sessionId: string, kind: 'snoop' | 'em' | 'br', side: Side) => `${RESOURCE_PREFIX}${sessionId}-${kind}-${side}`;

/**
 * Listen-only tap: per side, a snoop channel and an AudioSocket external media
 * channel joined in a private mixing bridge. Nothing is ever whispered into the call.
 */
export class TapOrchestrator {
  private readonly active = new Map<string, TapHandle>();

  constructor(private readonly o: TapOptions) {}

  async attach(sessionId: string, channelId: string, sinks: Record<Side, AudioSink>): Promise<TapHandle> {
    const h: TapHandle = { sessionId, channels: [], bridges: [], uuids: [] };
    this.active.set(sessionId, h);
    try {
      for (const side of SIDES) {
        const uuid = randomUUID();
        this.o.audio.register(uuid, sinks[side]);
        h.uuids.push(uuid);

        const br = await this.o.api.createBridge({ bridgeId: resourceId(sessionId, 'br', side), name: `${RESOURCE_PREFIX}${side}` });
        h.bridges.push(br.id);

        const snoop = await this.o.api.snoopChannel(channelId, { snoopId: resourceId(sessionId, 'snoop', side), spy: SPY[side] });
        h.channels.push(snoop.id);

        const em = await this.o.api.createExternalMedia({
          channelId: resourceId(sessionId, 'em', side),
          externalHost: this.o.advertiseHost,
          data: uuid,
          format: this.o.format ?? 'slin',
        });
        h.channels.push(em.id);

        await this.o.api.addChannelsToBridge(br.id, [snoop.id, em.id]);
      }
      this.o.log.info({ sessionId, channelId }, 'tap attached');
      return h;
    } catch (err) {
      this.o.log.error({ err, sessionId, channelId }, 'tap attach failed, rolling back');
      await this.detach(sessionId);
      throw new TapError(`failed to tap channel ${channelId}`, err);
    }
  }

  async detach(sessionId: string): Promise<void> {
    const h = this.active.get(sessionId);
    if (!h) return;
    this.active.delete(sessionId);
    for (const u of h.uuids) this.o.audio.unregister(u);
    const results = await Promise.allSettled([
      ...h.channels.map((id) => this.o.api.hangupChannel(id)),
      ...h.bridges.map((id) => this.o.api.destroyBridge(id)),
    ]);
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) this.o.log.warn({ sessionId, failed: failed.length }, 'tap detach: some resources could not be removed');
    else this.o.log.info({ sessionId }, 'tap detached');
  }

  /** Remove `liveai-*` channels and bridges left by a previous run (never the ones in use now). */
  async cleanupOrphans(): Promise<{ channels: number; bridges: number }> {
    const inUse = new Set([...this.active.values()].flatMap((h) => [...h.channels, ...h.bridges]));
    const isOrphan = (id: string) => id.startsWith(RESOURCE_PREFIX) && !inUse.has(id);
    const [channels, bridges] = await Promise.all([this.o.api.listChannels(), this.o.api.listBridges()]);
    const orphanChannels = channels.filter((c) => isOrphan(c.id));
    const orphanBridges = bridges.filter((b) => isOrphan(b.id));
    await Promise.allSettled([
      ...orphanChannels.map((c) => this.o.api.hangupChannel(c.id)),
      ...orphanBridges.map((b) => this.o.api.destroyBridge(b.id)),
    ]);
    if (orphanChannels.length || orphanBridges.length) {
      this.o.log.info({ channels: orphanChannels.length, bridges: orphanBridges.length }, 'removed orphaned resources');
    }
    return { channels: orphanChannels.length, bridges: orphanBridges.length };
  }
}
