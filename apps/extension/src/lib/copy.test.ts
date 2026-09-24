import { describe, expect, it } from 'vitest';
import type { SessionView } from './reducer';
import { transcriptText } from './copy';

const t = (s: number) => new Date(Date.UTC(2026, 8, 24, 10, 0, s)).toISOString();

describe('transcriptText', () => {
  it('outputs finals only, in chronological order', () => {
    const session: SessionView = {
      info: { id: 's', extension: '222', channelId: 'c', remote: { name: '', number: '1' }, startedAt: t(0), state: 'ended' },
      finalized: {},
      items: [
        { key: 'agent:0', side: 'agent', turn: 0, text: 'Second', ts: t(5), partial: false },
        { key: 'caller:0', side: 'caller', turn: 0, text: 'First', ts: t(2), partial: false },
        { key: 'caller:1', side: 'caller', turn: 1, text: 'in progress', ts: t(7), partial: true },
      ],
    };
    const lines = transcriptText(session, { agent: 'Agent', caller: 'Caller' }).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\] Caller: First$/);
    expect(lines[1]).toMatch(/^\[\d{2}:\d{2}:\d{2}\] Agent: Second$/);
  });
});
