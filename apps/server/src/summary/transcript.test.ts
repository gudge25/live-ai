import { describe, expect, it } from 'vitest';
import type { Utterance } from '@live-ai/shared';
import { formatSummaryTranscript } from './transcript.js';

const u = (over: Partial<Utterance>): Utterance => ({ sessionId: 's1', side: 'agent', turn: 0, text: '', ts: '2026-09-24T10:00:00.000Z', ...over });

describe('formatSummaryTranscript', () => {
  it('formats Side: text lines with no timestamps', () => {
    const text = formatSummaryTranscript([u({ side: 'caller', text: 'Hello' })]);
    expect(text).toBe('Caller: Hello');
  });

  it('orders utterances chronologically across sides regardless of insertion order', () => {
    const text = formatSummaryTranscript([
      u({ side: 'agent', text: 'Second', ts: '2026-09-24T10:00:05.000Z' }),
      u({ side: 'caller', text: 'First', ts: '2026-09-24T10:00:01.000Z' }),
    ]);
    expect(text).toBe('Caller: First\nAgent: Second');
  });

  it('breaks ties in original order when timestamps are equal', () => {
    const ts = '2026-09-24T10:00:00.000Z';
    const text = formatSummaryTranscript([u({ side: 'agent', text: 'A', ts }), u({ side: 'caller', text: 'B', ts })]);
    expect(text).toBe('Agent: A\nCaller: B');
  });

  it('returns an empty string for no utterances', () => {
    expect(formatSummaryTranscript([])).toBe('');
  });
});
