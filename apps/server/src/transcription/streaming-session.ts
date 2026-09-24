import type { Logger } from '../logger.js';
import type { TurnLike } from './turn-mapper.js';

/** The subset of the AssemblyAI SDK StreamingTranscriber we use (makes it mockable). */
export interface SdkTranscriber {
  on(event: 'turn', l: (t: TurnLike) => void): void;
  on(event: 'error', l: (e: Error) => void): void;
  on(event: 'close', l: (code: number, reason: string) => void): void;
  connect(): Promise<unknown>;
  sendAudio(audio: ArrayBufferLike, options?: { channel?: string }): void;
  close(waitForSessionTermination?: boolean, terminationTimeout?: number): Promise<void>;
}

export interface StreamingSessionOptions {
  create: () => SdkTranscriber;
  onTurn: (t: TurnLike) => void;
  /** A replacement AAI session was opened after a drop. */
  onNewSession: () => void;
  onDegraded: (reason: string) => void;
  log: Logger;
  /** Aggregate PCM into chunks of this size before sending (0 = send as-is). */
  chunkBytes: number;
  maxReconnects?: number;
  reconnectDelayMs?: number;
}

type State = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closing' | 'closed' | 'degraded';

/** One AAI streaming WebSocket with chunk aggregation and mid-call reconnect. */
export class StreamingSession {
  private sdk?: SdkTranscriber;
  private state: State = 'idle';
  private readonly buffers = new Map<string, Buffer[]>();
  private readonly bufferedBytes = new Map<string, number>();
  private reconnects = 0;
  private closing?: Promise<void>;

  constructor(private readonly o: StreamingSessionOptions) {}

  get status(): State {
    return this.state;
  }

  async start(): Promise<void> {
    this.state = 'connecting';
    try {
      await this.open();
    } catch (err) {
      this.o.log.warn({ err: (err as Error).message }, 'AAI: initial connect failed');
      await this.reconnect();
    }
  }

  send(pcm: Buffer, channel = ''): void {
    if (this.state !== 'open') return; // audio during a reconnect gap is dropped
    if (this.o.chunkBytes <= 0) {
      this.sendRaw(pcm, channel);
      return;
    }
    const list = this.buffers.get(channel) ?? [];
    list.push(pcm);
    const total = (this.bufferedBytes.get(channel) ?? 0) + pcm.length;
    if (total >= this.o.chunkBytes) {
      this.sendRaw(Buffer.concat(list), channel);
      this.buffers.set(channel, []);
      this.bufferedBytes.set(channel, 0);
    } else {
      this.buffers.set(channel, list);
      this.bufferedBytes.set(channel, total);
    }
  }

  /** Flush buffered audio and terminate gracefully so the last words are finalized. */
  close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    if (this.state === 'closed') return;
    const wasOpen = this.state === 'open';
    this.state = 'closing';
    const sdk = this.sdk;
    if (sdk && wasOpen) {
      for (const [channel, list] of this.buffers) if (list.length) this.sendRaw(Buffer.concat(list), channel, sdk);
      try {
        await sdk.close(true, 5000);
      } catch (err) {
        this.o.log.debug({ err }, 'AAI close failed');
      }
    }
    this.buffers.clear();
    this.state = 'closed';
  }

  private sendRaw(pcm: Buffer, channel: string, sdk = this.sdk) {
    const ab = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
    sdk?.sendAudio(ab, channel ? { channel } : undefined);
  }

  private async open(): Promise<void> {
    const sdk = this.o.create();
    this.sdk = sdk;
    sdk.on('turn', (t) => this.o.onTurn(t));
    sdk.on('error', (e) => this.o.log.warn({ err: e.message }, 'AAI stream error'));
    sdk.on('close', (code, reason) => {
      if (this.sdk !== sdk) return;
      if (this.state === 'open') {
        this.o.log.warn({ code, reason }, 'AAI stream closed unexpectedly');
        void this.reconnect();
      }
    });
    const begin = (await sdk.connect()) as { id?: string } | undefined;
    this.o.log.info({ aaiSession: begin?.id }, 'AAI stream opened');
    if ((this.state as State) === 'closing' || (this.state as State) === 'closed') {
      await sdk.close(false).catch(() => undefined);
      return;
    }
    this.state = 'open';
  }

  private async reconnect(): Promise<void> {
    const max = this.o.maxReconnects ?? 3;
    this.state = 'reconnecting';
    this.buffers.clear();
    this.bufferedBytes.clear();
    while (this.reconnects < max) {
      this.reconnects++;
      await new Promise((r) => setTimeout(r, (this.o.reconnectDelayMs ?? 500) * this.reconnects));
      if ((this.state as State) !== 'reconnecting') return; // closed meanwhile
      try {
        this.o.onNewSession();
        await this.open();
        this.o.log.info({ attempt: this.reconnects }, 'AAI stream reconnected');
        return;
      } catch (err) {
        this.o.log.warn({ err: (err as Error).message, attempt: this.reconnects }, 'AAI reconnect failed');
      }
    }
    this.state = 'degraded';
    this.o.onDegraded(`AssemblyAI unavailable after ${max} reconnect attempts`);
  }
}
