import { describe, expect, it } from 'vitest';
import { formatTranscriptLine, parseClientMessage, parseServerEvent } from './events.js';

const ts = '2026-09-24T10:00:00.000Z';

describe('server events', () => {
  it('parses a valid partial', () => {
    const ev = parseServerEvent({ type: 'partial', sessionId: 's1', side: 'agent', turn: 0, text: 'hel', ts });
    expect(ev.type).toBe('partial');
  });

  it('parses session_started', () => {
    const ev = parseServerEvent({
      type: 'session_started',
      session: {
        id: 's1',
        extension: '222',
        channelId: '1695.1',
        remote: { name: 'Bob', number: '+441234' },
        startedAt: ts,
        state: 'active',
      },
    });
    expect(ev.type).toBe('session_started');
  });

  it('rejects unknown side', () => {
    expect(() => parseServerEvent({ type: 'final', sessionId: 's1', side: 'bot', turn: 0, text: 'x', ts })).toThrow();
  });

  it('rejects unknown event type', () => {
    expect(() => parseServerEvent({ type: 'nope' })).toThrow();
  });

  it('rejects negative turn', () => {
    expect(() => parseServerEvent({ type: 'final', sessionId: 's1', side: 'caller', turn: -1, text: 'x', ts })).toThrow();
  });
});

describe('client messages', () => {
  it('parses subscribe', () => {
    expect(parseClientMessage({ type: 'subscribe', extensions: ['222'] })).toEqual({ type: 'subscribe', extensions: ['222'] });
  });

  it('rejects subscribe without extensions', () => {
    expect(() => parseClientMessage({ type: 'subscribe' })).toThrow();
  });
});

describe('formatTranscriptLine', () => {
  it('formats [time] Side: text', () => {
    const line = formatTranscriptLine({ ts, side: 'caller', text: 'Hello' }, { agent: 'Agent', caller: 'Caller' });
    expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\] Caller: Hello$/);
  });
});
