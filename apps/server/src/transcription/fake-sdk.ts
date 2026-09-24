import { EventEmitter } from 'node:events';
import type { SdkTranscriber } from './streaming-session.js';
import type { TurnLike } from './turn-mapper.js';

/** Test double for the AssemblyAI StreamingTranscriber. */
export class FakeSdk implements SdkTranscriber {
  private readonly ee = new EventEmitter();
  sent: { bytes: number; channel?: string }[] = [];
  closedWith?: { wait?: boolean; timeout?: number };
  connectError?: Error;

  on(event: string, l: (...args: never[]) => void): void {
    this.ee.on(event, l as (...args: unknown[]) => void);
  }
  async connect() {
    if (this.connectError) throw this.connectError;
    return { type: 'Begin' };
  }
  sendAudio(audio: ArrayBufferLike, options?: { channel?: string }) {
    this.sent.push({ bytes: audio.byteLength, channel: options?.channel });
  }
  async close(wait?: boolean, timeout?: number) {
    this.closedWith = { wait, timeout };
  }
  turn(t: Partial<TurnLike> & { turn_order: number; transcript: string }) {
    this.ee.emit('turn', { end_of_turn: false, turn_is_formatted: false, ...t });
  }
  /** Simulate the server dropping the socket. */
  drop(code = 1011) {
    this.ee.emit('close', code, 'server error');
  }
}
