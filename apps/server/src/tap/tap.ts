import { randomUUID } from 'node:crypto';
import type { Side } from '@live-ai/shared';
import { AriHttpError, AriTimeoutError, type AriApi } from '../ari/rest.js';
import type { AudioSink, AudioSocketServer } from '../audiosocket/server.js';
import type { Logger } from '../logger.js';
import { RESOURCE_PREFIX, type AriEventSource } from '../monitor/call-monitor.js';

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
  events: AriEventSource;
  /** host:port that Asterisk connects to. */
  advertiseHost: string;
  format?: string;
  log: Logger;
  /** How long to wait, after a channel was created, for its StasisStart before giving up on it. */
  stasisTimeoutMs?: number;
  /** Tries per channel-creating request when Asterisk is slow to answer (timeouts only). Default 2. */
  createAttempts?: number;
}

export const resourceId = (sessionId: string, kind: 'snoop' | 'em' | 'br', side: Side) => `${RESOURCE_PREFIX}${sessionId}-${kind}-${side}`;

/**
 * Listen-only tap: per side, a snoop channel and an AudioSocket external media
 * channel joined in a private mixing bridge. Nothing is ever whispered into the call.
 */
export class TapOrchestrator {
  private readonly active = new Map<string, TapHandle>();

  constructor(private readonly o: TapOptions) {
    // Each in-flight channel wait holds a transient listener on this (shared, long-lived)
    // emitter; raise the cap so a burst of concurrent calls doesn't trip Node's default of 10.
    o.events.setMaxListeners?.(50);
  }

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

        const snoopId = resourceId(sessionId, 'snoop', side);
        const emId = resourceId(sessionId, 'em', side);
        // Independent of each other; only the final addChannel call needs both results.
        const [snoop, em] = await Promise.all([
          this.createStasisChannel(h, snoopId, () => this.o.api.snoopChannel(channelId, { snoopId, spy: SPY[side] })),
          this.createStasisChannel(h, emId, () =>
            this.o.api.createExternalMedia({ channelId: emId, externalHost: this.o.advertiseHost, data: uuid, format: this.o.format ?? 'slin' }),
          ),
        ]);

        // Only now are both channels confirmed to be in the Stasis app; addChannel on a
        // channel that hasn't entered Stasis yet gets rejected with 422 by Asterisk.
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

  /**
   * Creates a Stasis-bound channel (snoop or externalMedia) and waits for Asterisk to confirm,
   * via `StasisStart`, that it actually entered the app before returning it. If `create` itself
   * fails, the wait is cancelled immediately rather than left to linger until its timeout.
   *
   * The StasisStart timer only starts once the create request has returned: a slow Asterisk
   * must not use up the confirmation budget while still answering the request itself.
   */
  private async createStasisChannel<T extends { id: string }>(h: TapHandle, channelId: string, create: () => Promise<T>): Promise<T> {
    const wait = this.waitForStasisStart(channelId);
    let ch: T;
    try {
      ch = await this.createWithRetry(channelId, create);
    } catch (err) {
      wait.cancel();
      // A request we gave up on may still complete inside Asterisk; remember its (deterministic) id
      // so the rollback hangs it up instead of leaving it behind.
      if (err instanceof AriTimeoutError) h.channels.push(channelId);
      throw err;
    }
    h.channels.push(ch.id); // record it for rollback even if the Stasis confirmation below times out
    wait.arm();
    await wait.promise;
    return ch;
  }

  /**
   * Runs a channel-creating request, tolerating a slow Asterisk. After a timeout the request may
   * still complete on the PBX, so before sending it again we look for the channel by its id and use
   * it if it appeared; only if it didn't is the request retried (once, by default). Non-timeout
   * errors are not retried — an HTTP error is Asterisk's real answer.
   */
  private async createWithRetry<T extends { id: string }>(channelId: string, create: () => Promise<T>): Promise<T> {
    const attempts = this.o.createAttempts ?? 2;
    for (let attempt = 1; ; attempt++) {
      try {
        return await create();
      } catch (err) {
        // After a retry, a 4xx can mean "that id exists now": the first request finished late.
        const mayHaveCompleted = err instanceof AriTimeoutError || (attempt > 1 && err instanceof AriHttpError);
        if (!mayHaveCompleted) throw err;
        const late = await this.o.api.getChannel(channelId).catch(() => undefined);
        if (late) {
          this.o.log.warn({ channelId, attempt }, 'ARI create was slow but the channel exists, using it');
          return late as unknown as T;
        }
        if (attempt >= attempts) throw err;
        this.o.log.warn({ channelId, attempt, err: err instanceof Error ? err.message : err }, 'ARI create timed out, retrying');
      }
    }
  }

  /**
   * Resolves once Asterisk reports `channelId` as having entered the Stasis app, or rejects if
   * `stasisTimeoutMs` elapses after `arm()` — proceeding without confirmation would risk the exact
   * 422 "Channel not in Stasis application" this wait exists to avoid. The listener is registered
   * before the caller issues the channel-creating request, so it can't miss an event that arrives
   * early (in which case the wait is already settled when `arm()` is called). `cancel()` tears the
   * listener/timer down without settling either way, for when the owning request failed and the
   * wait's outcome no longer matters.
   */
  private waitForStasisStart(channelId: string): { promise: Promise<void>; arm: () => void; cancel: () => void } {
    const timeoutMs = this.o.stasisTimeoutMs ?? 2000;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let settle!: (err?: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      const onEvent = (ev: Record<string, unknown> & { type: string }) => {
        const channel = (ev as { channel?: { id?: string } }).channel;
        if (ev.type === 'StasisStart' && channel?.id === channelId) settle();
      };
      settle = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.o.events.off('event', onEvent);
        if (err) reject(err);
        else resolve();
      };
      this.o.events.on('event', onEvent);
    });
    // The real rejection is still observed by whoever awaits `promise`; this just keeps Node
    // from logging it as unhandled during the window before that `await` runs.
    promise.catch(() => {});
    const arm = () => {
      if (settled || timer) return;
      timer = setTimeout(() => settle(new Error(`channel ${channelId} did not report StasisStart within ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    };
    return { promise, arm, cancel: () => settle() };
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
