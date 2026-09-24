import { randomBytes } from 'node:crypto';
import type { ServerEvent, SessionInfo, Side, StatusState } from '@live-ai/shared';
import type { AriApi } from './ari/rest.js';
import type { AudioSink, AudioSocketServer } from './audiosocket/server.js';
import { SessionStore } from './hub/session-store.js';
import type { Logger } from './logger.js';
import { CallMonitor, type AriEventSource, type MonitoredCall } from './monitor/call-monitor.js';
import { TapError, TapOrchestrator } from './tap/tap.js';
import { CallTranscription, type SdkParams } from './transcription/call-transcription.js';
import type { SdkTranscriber } from './transcription/streaming-session.js';

export interface Broadcaster {
  broadcast(ev: ServerEvent, extension?: string): void;
}

export interface AppOptions {
  api: AriApi;
  events: AriEventSource & { on(e: 'status', l: (s: StatusState) => void): unknown };
  audio: Pick<AudioSocketServer, 'register' | 'unregister'>;
  createSdk: (p: SdkParams) => SdkTranscriber;
  store: SessionStore;
  log: Logger;
  extensions: string[];
  tech: string;
  advertiseHost: string;
  sampleRate: number;
  dualChannel: boolean;
  maxConcurrent: number;
  logTranscripts: boolean;
  monitor?: Partial<ConstructorParameters<typeof CallMonitor>[0]>;
  transcription?: { reconnectDelayMs?: number };
}

interface Live {
  info: SessionInfo;
  stats: { bytes: Record<Side, number>; partials: number; finals: number };
  ct?: CallTranscription;
  ready: Promise<void>;
}

/** Wires call detection -> tap -> transcription -> UI broadcast. */
export class LiveAiApp {
  readonly monitor: CallMonitor;
  readonly tap: TapOrchestrator;
  private readonly live = new Map<string, Live>();
  private ui?: Broadcaster;
  private cleanedUp = false;
  ariStatus: StatusState = 'disconnected';

  constructor(private readonly o: AppOptions) {
    this.monitor = new CallMonitor({ api: o.api, events: o.events, extensions: o.extensions, tech: o.tech, log: o.log, ...o.monitor });
    this.tap = new TapOrchestrator({ api: o.api, audio: o.audio, advertiseHost: o.advertiseHost, log: o.log });
    this.monitor.on('start', (c) => this.onStart(c));
    this.monitor.on('end', (id) => void this.onEnd(id));
    o.events.on('status', (s) => {
      this.ariStatus = s;
      this.ui?.broadcast({ type: 'status', scope: 'ari', state: s });
    });
    // Remove leftovers of a previous run once, before any tap of ours exists.
    o.events.on('connected', () => {
      if (this.cleanedUp) return;
      this.cleanedUp = true;
      this.tap.cleanupOrphans().catch((err) => o.log.warn({ err }, 'orphan cleanup failed'));
    });
  }

  attachUi(ui: Broadcaster): void {
    this.ui = ui;
  }

  get activeChannels(): string[] {
    return [...this.live.keys()];
  }

  private onStart(call: MonitoredCall): void {
    if (this.live.has(call.channelId)) return;
    if (this.live.size >= this.o.maxConcurrent) {
      this.o.log.warn({ channel: call.channelId, limit: this.o.maxConcurrent }, 'concurrent session limit reached, not transcribing');
      return;
    }
    const info: SessionInfo = {
      id: randomBytes(6).toString('hex'),
      extension: call.extension,
      channelId: call.channelId,
      remote: call.remote,
      startedAt: call.startedAt.toISOString(),
      state: 'active',
    };
    const entry: Live = { info, ready: Promise.resolve(), stats: { bytes: { agent: 0, caller: 0 }, partials: 0, finals: 0 } };
    this.live.set(call.channelId, entry);
    entry.ready = this.startSession(entry);
  }

  private async startSession(entry: Live): Promise<void> {
    const { info } = entry;
    const ext = info.extension;
    this.o.store.add(info);
    this.ui?.broadcast({ type: 'session_started', session: info }, ext);

    const ct = new CallTranscription({
      createSdk: this.o.createSdk,
      sampleRate: this.o.sampleRate,
      dualChannel: this.o.dualChannel,
      log: this.o.log.child({ session: info.id }),
      reconnectDelayMs: this.o.transcription?.reconnectDelayMs,
      onTranscript: (e) => {
        const u = { sessionId: info.id, side: e.side, turn: e.turn, text: e.text, ts: new Date().toISOString() };
        if (e.kind === 'partial') entry.stats.partials++;
        if (e.kind === 'final') {
          entry.stats.finals++;
          this.o.store.addFinal(u);
          if (this.o.logTranscripts) this.o.log.info({ session: info.id, side: e.side }, u.text);
        }
        this.ui?.broadcast({ type: e.kind, ...u }, ext);
      },
      onDegraded: (side, reason) =>
        this.ui?.broadcast({ type: 'status', scope: 'transcription', state: 'transcription_degraded', sessionId: info.id, side, message: reason }, ext),
    });
    entry.ct = ct;

    const sink = (side: Side): AudioSink => ({
      onAudio: (pcm) => {
        entry.stats.bytes[side] += pcm.length;
        ct.send(side, pcm);
      },
      onEnd: () => void ct.endSide(side),
    });

    const [, tapResult] = await Promise.allSettled([ct.start(), this.tap.attach(info.id, info.channelId, { agent: sink('agent'), caller: sink('caller') })]);
    if (tapResult.status === 'rejected') {
      const msg = tapResult.reason instanceof TapError ? String((tapResult.reason.cause as Error)?.message ?? tapResult.reason.message) : String(tapResult.reason);
      await ct.close();
      const endedAt = new Date().toISOString();
      this.o.store.update(info.id, { state: 'tap_failed', endedAt });
      this.ui?.broadcast({ type: 'status', scope: 'tap', state: 'tap_failed', sessionId: info.id, message: msg }, ext);
      this.ui?.broadcast({ type: 'session_ended', sessionId: info.id, endedAt, state: 'tap_failed' }, ext);
      this.live.delete(info.channelId);
    }
  }

  private async onEnd(channelId: string): Promise<void> {
    const entry = this.live.get(channelId);
    if (!entry) return;
    await entry.ready;
    if (!this.live.has(channelId)) return; // tap failed and was already finalized
    this.live.delete(channelId);
    const { info } = entry;
    await this.tap.detach(info.id);
    await entry.ct?.close(); // waits for AAI to finalize the last turn
    const endedAt = new Date().toISOString();
    this.o.store.update(info.id, { state: 'ended', endedAt });
    this.ui?.broadcast({ type: 'session_ended', sessionId: info.id, endedAt, state: 'ended' }, info.extension);
    const { bytes, partials, finals } = entry.stats;
    // slin 8 kHz = 16 000 bytes per second of audio
    this.o.log.info(
      { sessionId: info.id, agentAudioSec: +(bytes.agent / 16000).toFixed(1), callerAudioSec: +(bytes.caller / 16000).toFixed(1), partials, finals },
      'session summary',
    );
  }

  /** Graceful shutdown: end all sessions and remove our ARI resources. */
  async shutdown(): Promise<void> {
    await Promise.allSettled(this.activeChannels.map((id) => this.onEnd(id)));
  }
}
