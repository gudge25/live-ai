import { describe, expect, it, vi } from 'vitest';
import { TurnMapper, type TranscriptEvent } from './turn-mapper.js';

const make = (fallback = 50) => {
  const out: TranscriptEvent[] = [];
  const m = new TurnMapper((e) => out.push(e), () => 'agent', fallback);
  return { m, out };
};
const t = (turn_order: number, transcript: string, end_of_turn = false, turn_is_formatted = false) => ({
  turn_order,
  transcript,
  end_of_turn,
  turn_is_formatted,
});

describe('TurnMapper', () => {
  it('emits partials then the formatted final', () => {
    const { m, out } = make();
    m.handle(t(0, 'hello'));
    m.handle(t(0, 'hello how are'));
    m.handle(t(0, 'hello how are you', true, false));
    m.handle(t(0, 'Hello, how are you?', true, true));
    expect(out).toEqual([
      { kind: 'partial', side: 'agent', turn: 0, text: 'hello' },
      { kind: 'partial', side: 'agent', turn: 0, text: 'hello how are' },
      { kind: 'partial', side: 'agent', turn: 0, text: 'hello how are you' },
      { kind: 'final', side: 'agent', turn: 0, text: 'Hello, how are you?' },
    ]);
  });

  it('ignores anything for a turn after its final', () => {
    const { m, out } = make();
    m.handle(t(1, 'Done.', true, true));
    m.handle(t(1, 'done again'));
    expect(out).toHaveLength(1);
  });

  it('skips empty partials', () => {
    const { m, out } = make();
    m.handle(t(0, '  '));
    expect(out).toHaveLength(0);
  });

  it('promotes an unformatted end-of-turn to final if the formatted one never comes', () => {
    vi.useFakeTimers();
    const { m, out } = make(50);
    m.handle(t(2, 'no formatting here', true, false));
    vi.advanceTimersByTime(60);
    expect(out.at(-1)).toEqual({ kind: 'final', side: 'agent', turn: 2, text: 'no formatting here' });
    vi.useRealTimers();
  });

  it('flush() finalizes pending end-of-turns immediately', () => {
    const { m, out } = make(10_000);
    m.handle(t(0, 'last words', true, false));
    m.flush();
    expect(out.at(-1)?.kind).toBe('final');
  });

  it('keeps turn numbers unique across a new AAI session', () => {
    const { m, out } = make();
    m.handle(t(0, 'First.', true, true));
    m.handle(t(1, 'Second.', true, true));
    m.newSession();
    m.handle(t(0, 'After reconnect.', true, true));
    expect(out.map((e) => e.turn)).toEqual([0, 1, 2]);
  });

  it('uses the side resolver (dual-channel)', () => {
    const out: TranscriptEvent[] = [];
    const m = new TurnMapper((e) => out.push(e), (x) => (x.channel === 'caller' ? 'caller' : undefined));
    m.handle({ ...t(0, 'Hi.', true, true), channel: 'caller' });
    m.handle({ ...t(1, 'lost', true, true), channel: 'unknown' });
    expect(out).toEqual([{ kind: 'final', side: 'caller', turn: 0, text: 'Hi.' }]);
  });
});
