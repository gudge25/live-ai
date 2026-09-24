import type { Side } from '@live-ai/shared';
import type { Logger } from '../logger.js';
import { StreamingSession, type SdkTranscriber } from './streaming-session.js';
import { TurnMapper, type TranscriptEvent } from './turn-mapper.js';

export interface SdkParams {
  sampleRate: number;
  channels?: { name: string }[];
}

export interface CallTranscriptionOptions {
  /** Build a SDK transcriber for the given params (API key / model already bound). */
  createSdk: (p: SdkParams) => SdkTranscriber;
  sampleRate: number;
  dualChannel: boolean;
  onTranscript: (e: TranscriptEvent) => void;
  onDegraded: (side: Side | undefined, reason: string) => void;
  log: Logger;
  maxReconnects?: number;
  reconnectDelayMs?: number;
}

const SIDES: Side[] = ['agent', 'caller'];
const CHUNK_MS = 100;

/** Transcription for one call: one AAI session per side, or one dual-channel session. */
export class CallTranscription {
  private readonly sessions = new Map<Side | 'both', StreamingSession>();
  private readonly mappers: TurnMapper[] = [];

  constructor(private readonly o: CallTranscriptionOptions) {
    const chunkBytes = (o.sampleRate * 2 * CHUNK_MS) / 1000;
    const common = { log: o.log, maxReconnects: o.maxReconnects, reconnectDelayMs: o.reconnectDelayMs };
    if (o.dualChannel) {
      const mapper = new TurnMapper(o.onTranscript, (t) => (SIDES as string[]).includes(t.channel ?? '') ? (t.channel as Side) : undefined);
      this.mappers.push(mapper);
      this.sessions.set(
        'both',
        new StreamingSession({
          ...common,
          // the SDK mixes channels itself on a 50 ms timer, so no aggregation here
          chunkBytes: 0,
          create: () => o.createSdk({ sampleRate: o.sampleRate, channels: SIDES.map((name) => ({ name })) }),
          onTurn: (t) => mapper.handle(t),
          onNewSession: () => mapper.newSession(),
          onDegraded: (r) => o.onDegraded(undefined, r),
        }),
      );
    } else {
      for (const side of SIDES) {
        const mapper = new TurnMapper(o.onTranscript, () => side);
        this.mappers.push(mapper);
        this.sessions.set(
          side,
          new StreamingSession({
            ...common,
            chunkBytes,
            create: () => o.createSdk({ sampleRate: o.sampleRate }),
            onTurn: (t) => mapper.handle(t),
            onNewSession: () => mapper.newSession(),
            onDegraded: (r) => o.onDegraded(side, r),
          }),
        );
      }
    }
  }

  async start(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.start()));
  }

  send(side: Side, pcm: Buffer): void {
    if (this.o.dualChannel) this.sessions.get('both')?.send(pcm, side);
    else this.sessions.get(side)?.send(pcm);
  }

  /** End one side's stream (its AudioSocket closed). */
  async endSide(side: Side): Promise<void> {
    if (!this.o.dualChannel) await this.sessions.get(side)?.close();
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
    for (const m of this.mappers) m.flush();
  }
}
