import type { Side } from '@live-ai/shared';

/** The fields of an AssemblyAI v3 `Turn` message we rely on. */
export interface TurnLike {
  turn_order: number;
  transcript: string;
  end_of_turn: boolean;
  turn_is_formatted: boolean;
  channel?: string;
}

export type TranscriptEvent = { kind: 'partial' | 'final'; side: Side; turn: number; text: string };

/**
 * Maps AAI turns to partial/final events. With `formatTurns`, AAI first sends an
 * unformatted end-of-turn and then the formatted one; the formatted one is the final.
 * If it never comes (model without formatting, or the stream closes), `flush()`
 * or the fallback timer promotes the last unformatted end-of-turn to final.
 */
export class TurnMapper {
  private readonly finalized = new Set<string>();
  private readonly pendingEot = new Map<string, TranscriptEvent>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Added to turn_order so turns stay unique across reconnects (turn_order restarts at 0). */
  private offset = 0;
  private maxTurn = -1;

  constructor(
    private readonly emit: (e: TranscriptEvent) => void,
    private readonly resolveSide: (t: TurnLike) => Side | undefined,
    private readonly formatFallbackMs = 1500,
  ) {}

  /** Call when a fresh AAI session replaces a dropped one. */
  newSession(): void {
    this.flush();
    this.offset = this.maxTurn + 1;
  }

  handle(t: TurnLike): void {
    const side = this.resolveSide(t);
    if (!side) return;
    const turn = t.turn_order + this.offset;
    this.maxTurn = Math.max(this.maxTurn, turn);
    const key = `${side}:${turn}`;
    if (this.finalized.has(key)) return;
    const text = t.transcript.trim();

    if (t.end_of_turn && t.turn_is_formatted) {
      this.clearPending(key);
      this.finalize(key, { kind: 'final', side, turn, text });
      return;
    }
    if (!text) return;
    this.emit({ kind: 'partial', side, turn, text });
    if (t.end_of_turn) {
      this.clearPending(key);
      const ev: TranscriptEvent = { kind: 'final', side, turn, text };
      this.pendingEot.set(key, ev);
      this.timers.set(
        key,
        setTimeout(() => {
          this.pendingEot.delete(key);
          this.timers.delete(key);
          this.finalize(key, ev);
        }, this.formatFallbackMs),
      );
    }
  }

  /** Promote every unformatted end-of-turn still waiting for its formatted version. */
  flush(): void {
    for (const [key, ev] of [...this.pendingEot]) {
      this.clearPending(key);
      this.finalize(key, ev);
    }
  }

  private finalize(key: string, ev: TranscriptEvent) {
    this.finalized.add(key);
    if (ev.text) this.emit(ev);
  }

  private clearPending(key: string) {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.pendingEot.delete(key);
  }
}
